/**
 * MySQL数据库连接模块
 * 用于云端知识库同步
 * 可选配置，未启用时不影响本地SQLite
 * 支持加密配置存储，确保隐私安全
 * 支持多数据库连接配置和动态切换
 */

const mysql = require('mysql2/promise');
const { config } = require('../config');
const { logger } = require('./logger');

let pool = null;
let currentConnectionConfig = null;
let connectionHealthy = false;
let healthCheckTimer = null;
const HEALTH_CHECK_INTERVAL = 60000;

// ---------- 连接失败指数退避（熔断）----------
// 远端 MySQL 不可达/权限错误时，同步队列(30s)与健康检查(60s)都会反复触发
// ensureDatabaseExists，建立连接 + 10s 超时 + warn 日志每分钟刷屏。
// 连续失败期间按指数退避跳过尝试：1min → 2min → 4min → … 封顶 15min；
// 首次失败 warn 一次，后续降为 debug，恢复时 info 通知。用户主动操作（测试连接/切换连接）不受退避限制。
let ensureFailureCount = 0;
let ensureFailureKey = '';
let lastEnsureAttemptAt = 0;
const ENSURE_BASE_BACKOFF_MS = 60000;
const ENSURE_MAX_BACKOFF_MS = 15 * 60000;

function ensureBackoffMs() {
  return Math.min(ENSURE_BASE_BACKOFF_MS * 2 ** Math.max(0, ensureFailureCount - 1), ENSURE_MAX_BACKOFF_MS);
}

/**
 * 获取MySQL连接池配置
 */
function getMySQLConnectionConfig() {
  if (config.mysql?.enabled && config.mysql?.host) {
    return {
      host: config.mysql.host,
      port: config.mysql.port || 3306,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database || 'code_optimizer',
      connectionLimit: config.mysql.connectionLimit || 10,
      namedPlaceholders: true,
      decimalNumbers: true,
      supportBigNumbers: true,
      bigNumberStrings: false
    };
  }

  return null;
}

/**
 * 使用自定义配置获取MySQL连接池配置
 */
function getConnectionConfigFromCustom(customConfig) {
  if (!customConfig || !customConfig.enabled || !customConfig.host) {
    return null;
  }

  return {
    host: customConfig.host,
    port: customConfig.port || 3306,
    user: customConfig.user,
    password: customConfig.password,
    database: customConfig.database || 'code_optimizer',
    connectionLimit: customConfig.connectionLimit || 10,
    namedPlaceholders: true,
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false
  };
}

/**
 * 将 MySQL 连接错误翻译为可操作的处理指引（用户看得懂、知道去哪改）
 */
function describeMysqlErrorHint(error) {
  const errno = error && error.errno;
  const code = (error && error.code) || '';
  if (errno === 1045) return '用户名或密码错误：请核对数据库账号密码';
  if (errno === 1130) return '服务器拒绝了本机公网 IP 的连接：请到云数据库控制台将当前出口 IP 加入白名单，或将该用户的 host 改为 %';
  if (errno === 1044 || errno === 1142) return '权限不足：请到云数据库控制台为该账号授权，或将配置中的库名改为服务商预建的数据库名';
  if (errno === 1049) return '数据库不存在且当前账号无自动建库权限：请到云数据库控制台创建该库，或把配置改为服务商预建的库名';
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND/.test(code)) return '网络不可达：请检查主机地址、端口以及安全组/防火墙是否放行 3306（或自定义端口）';
  if (code === 'ECONNRESET') return '连接被重置：常见于安全组/白名单拦截，请到云数据库控制台将当前出口 IP 加入白名单';
  return '';
}

/**
 * 验证目标数据库可直接访问（不要求建库权限）。
 * 托管云 MySQL 通常只授予预建库权限、不给 CREATE DATABASE 权限，
 * 因此建库失败并不代表目标库不可用——以直连验证结果为准。
 * @returns {Promise<void>} 可访问则 resolve；不可访问则抛出直连时的真实错误（如 1049 库不存在）
 */
async function verifyTargetDatabase(mysqlConfig) {
  let conn = null;
  try {
    conn = await mysql.createConnection({
      host: mysqlConfig.host,
      port: mysqlConfig.port || 3306,
      user: mysqlConfig.user,
      password: mysqlConfig.password,
      database: mysqlConfig.database,
      connectTimeout: 10000,
      charset: 'utf8mb4'
    });
    await conn.execute('SELECT 1');
  } finally {
    if (conn) { try { await conn.end(); } catch (_) { /* ignore */ } }
  }
}

/**
 * 确保目标数据库可用：
 * 1. 尝试 CREATE DATABASE IF NOT EXISTS（自建库场景友好）
 * 2. 若因权限（1044/1142）失败——不代表目标库不可用——降级为直连目标库验证，
 *    可访问即继续（托管云预建库场景）；不可访问则抛出真实原因
 * 3. 其余错误（1045 密码错误 / 1130 白名单拒绝 / 网络不可达）为真实失败，附带处理指引
 * @param {object} mysqlConfig 连接配置
 * @param {object} [opts]
 * @param {boolean} [opts.force] 用户主动操作（测试连接/切换连接）时为 true，跳过退避直接尝试
 * @returns {Promise<boolean>} true=数据库可用，false=连接或权限错误（或处于退避期内）
 */
async function ensureDatabaseExists(mysqlConfig, opts = {}) {
  if (!mysqlConfig || !mysqlConfig.host || !mysqlConfig.database) {
    return false;
  }
  // 换了连接配置：重新计数
  const failureKey = `${mysqlConfig.host}:${mysqlConfig.port || 3306}:${mysqlConfig.database}:${mysqlConfig.user}`;
  if (failureKey !== ensureFailureKey) {
    ensureFailureKey = failureKey;
    ensureFailureCount = 0;
  }
  // 退避期内静默跳过：不建连接、不打日志
  if (!opts.force && ensureFailureCount > 0 && Date.now() - lastEnsureAttemptAt < ensureBackoffMs()) {
    return false;
  }
  lastEnsureAttemptAt = Date.now();
  let conn = null;
  try {
    conn = await mysql.createConnection({
      host: mysqlConfig.host,
      port: mysqlConfig.port || 3306,
      user: mysqlConfig.user,
      password: mysqlConfig.password,
      connectTimeout: 10000,
      charset: 'utf8mb4'
    });
    // 限定数据库名只允许安全字符，配合反引号避免关键字冲突
    const safeDb = String(mysqlConfig.database).replace(/[^a-zA-Z0-9_$]/g, '_');
    let created = false;
    try {
      await conn.execute(`CREATE DATABASE IF NOT EXISTS \`${safeDb}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      created = true;
    } catch (createErr) {
      // 无建库权限 ≠ 目标库不可用：直连目标库验证，可访问即继续
      if (createErr.errno === 1044 || createErr.errno === 1142) {
        logger.debug(`[MySQL] 无 CREATE DATABASE 权限（${createErr.code || createErr.message}），改为直连验证目标库 ${safeDb}`);
        await verifyTargetDatabase(mysqlConfig);
        logger.info(`[MySQL] 无建库权限，但目标库 ${safeDb} 可直接访问，继续使用现有库`);
      } else {
        throw createErr;
      }
    }
    if (ensureFailureCount > 0) {
      logger.info(`[MySQL] 数据库连接已恢复: ${safeDb}（此前连续失败 ${ensureFailureCount} 次）`);
    } else if (created) {
      logger.info(`[MySQL] 确保数据库存在: ${safeDb}`);
    }
    ensureFailureCount = 0;
    return true;
  } catch (error) {
    ensureFailureCount++;
    const hint = describeMysqlErrorHint(error);
    const detail = `[MySQL] 确保数据库可用失败(第 ${ensureFailureCount} 次): ${error.message}${hint ? `。${hint}` : ''}`;
    if (ensureFailureCount === 1) {
      logger.warn(`${detail}${hint ? '' : '，后续按指数退避重试（间隔 1min 起步，最长 15min）'}`);
    } else {
      logger.debug(detail);
    }
    return false;
  } finally {
    if (conn) { try { await conn.end(); } catch (_) { /* ignore */ } }
  }
}

/**
 * 获取MySQL连接池
 * @param {object} [opts] 透传给 ensureDatabaseExists（用户主动操作时传 { force: true } 绕过退避）
 */
async function getPool(opts = {}) {
  const mysqlConfig = getMySQLConnectionConfig();

  if (!mysqlConfig || !mysqlConfig.host) {
    return null;
  }

  const configKey = `${mysqlConfig.host}:${mysqlConfig.port}:${mysqlConfig.database}:${mysqlConfig.user}`;

  if (!pool || currentConnectionConfig !== configKey) {
    if (pool) {
      try {
        await pool.end();
      } catch (e) {
        logger.debug('关闭旧连接池失败:', e.message);
      }
      pool = null;
    }

    // 先确保数据库存在（避免云端 DB 被删除导致 ER_BAD_DB_ERROR）
    const ensured = await ensureDatabaseExists(mysqlConfig, opts);
    if (!ensured) {
      pool = null;
      currentConnectionConfig = null;
      return null;
    }

    try {
      pool = mysql.createPool({
        host: mysqlConfig.host,
        port: mysqlConfig.port,
        user: mysqlConfig.user,
        password: mysqlConfig.password,
        database: mysqlConfig.database,
        connectionLimit: mysqlConfig.connectionLimit,
        waitForConnections: true,
        queueLimit: 0,
        charset: 'utf8mb4'
      });

      currentConnectionConfig = configKey;
      logger.info('MySQL连接池创建成功');
    } catch (error) {
      logger.warn(`MySQL连接池创建失败: ${error.message}`);
      pool = null;
      currentConnectionConfig = null;
    }
  }

  return pool;
}

/**
 * 测试MySQL连接
 */
async function testConnection() {
  const pool = await getPool({ force: true }); // 用户主动测试：绕过退避
  if (!pool) {
    return { success: false, message: 'MySQL未启用' };
  }
  
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    return { success: true, message: 'MySQL连接成功' };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

/**
 * 执行查询
 */
async function query(sql, params = []) {
  const pool = await getPool();
  if (!pool) {
    throw new Error('MySQL未启用');
  }
  
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (error) {
    logger.debug(`MySQL查询失败: ${error.message}`);
    throw error;
  }
}

/**
 * 执行插入/更新/删除
 */
async function execute(sql, params = []) {
  const pool = await getPool();
  if (!pool) {
    throw new Error('MySQL未启用');
  }
  
  try {
    const [result] = await pool.execute(sql, params);
    return {
      success: true,
      affectedRows: result.affectedRows,
      insertId: result.insertId
    };
  } catch (error) {
    logger.debug(`MySQL执行失败: ${error.message}`);
    throw error;
  }
}

/**
 * 初始化MySQL数据库表
 */
async function initDatabase() {
  const pool = await getPool();
  if (!pool) {
    return false;
  }
  
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS sys_user (
        id INT PRIMARY KEY AUTO_INCREMENT,
        username VARCHAR(50) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        email VARCHAR(100),
        role VARCHAR(20) NOT NULL DEFAULT 'operator',
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        last_login_at DATETIME,
        login_count INT DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS sys_oper_log (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT,
        username VARCHAR(50),
        operation_type VARCHAR(50) NOT NULL,
        operation_desc TEXT,
        request_method VARCHAR(10),
        request_url VARCHAR(255),
        request_params TEXT,
        response_status INT,
        ip_address VARCHAR(50),
        user_agent TEXT,
        duration_ms INT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS sys_config (
        id INT PRIMARY KEY AUTO_INCREMENT,
        config_key VARCHAR(100) NOT NULL UNIQUE,
        config_value TEXT,
        config_type VARCHAR(50),
        description TEXT,
        is_public BOOLEAN DEFAULT FALSE,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS scan_project (
        id INT PRIMARY KEY AUTO_INCREMENT,
        project_name VARCHAR(255) NOT NULL,
        project_path VARCHAR(500) NOT NULL,
        project_type VARCHAR(50),
        language VARCHAR(50),
        framework VARCHAR(100),
        description TEXT,
        total_files INT DEFAULT 0,
        total_lines INT DEFAULT 0,
        scan_count INT DEFAULT 0,
        last_scan_at DATETIME,
        user_id INT,
        status VARCHAR(20) DEFAULT 'active',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS scan_task (
        id INT PRIMARY KEY AUTO_INCREMENT,
        project_id INT,
        task_name VARCHAR(255),
        scan_mode VARCHAR(20) NOT NULL,
        scan_type VARCHAR(50) NOT NULL,
        target_path VARCHAR(500),
        file_count INT DEFAULT 0,
        scanned_files INT DEFAULT 0,
        issue_count INT DEFAULT 0,
        issue_critical INT DEFAULT 0,
        issue_high INT DEFAULT 0,
        issue_medium INT DEFAULT 0,
        issue_low INT DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        progress INT DEFAULT 0,
        started_at DATETIME,
        completed_at DATETIME,
        duration_ms INT,
        error_message TEXT,
        user_id INT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS code_issue (
        id INT PRIMARY KEY AUTO_INCREMENT,
        task_id INT NOT NULL,
        project_id INT,
        file_path VARCHAR(500) NOT NULL,
        file_name VARCHAR(255),
        language VARCHAR(50),
        issue_type VARCHAR(50) NOT NULL,
        severity VARCHAR(20) NOT NULL,
        message TEXT NOT NULL,
        suggestion TEXT,
        line_start INT NOT NULL,
        line_end INT,
        column_start INT,
        column_end INT,
        code_snippet TEXT,
        ast_node_type VARCHAR(100),
        is_fixed BOOLEAN DEFAULT FALSE,
        fixed_at DATETIME,
        fixed_by_user_id INT,
        fix_suggestion TEXT,
        ai_optimized BOOLEAN DEFAULT FALSE,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS ai_optimize_record (
        id INT PRIMARY KEY AUTO_INCREMENT,
        issue_id INT NOT NULL,
        task_id INT,
        original_code TEXT NOT NULL,
        optimized_code TEXT,
        explanation TEXT,
        optimization_type VARCHAR(50),
        ai_model VARCHAR(100),
        tokens_used INT,
        api_latency_ms INT,
        user_rating INT,
        user_feedback TEXT,
        is_applied BOOLEAN DEFAULT FALSE,
        applied_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS code_report (
        id INT PRIMARY KEY AUTO_INCREMENT,
        task_id INT NOT NULL,
        project_id INT,
        report_name VARCHAR(255) NOT NULL,
        report_type VARCHAR(50),
        file_path VARCHAR(500),
        file_size_kb DECIMAL(10,2),
        summary TEXT,
        include_ai_suggestions BOOLEAN DEFAULT TRUE,
        user_id INT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS llm_api_keys (
        id INT PRIMARY KEY AUTO_INCREMENT,
        provider_name VARCHAR(50) NOT NULL,
        api_key TEXT NOT NULL,
        api_url TEXT,
        model_name VARCHAR(100),
        is_active BOOLEAN DEFAULT TRUE,
        priority INT DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS api_access_keys (
        id INT PRIMARY KEY AUTO_INCREMENT,
        access_key VARCHAR(100) NOT NULL UNIQUE,
        key_name VARCHAR(100),
        permissions TEXT,
        rate_limit INT DEFAULT 100,
        usage_count INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        expires_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS kb_entries (
        id VARCHAR(36) PRIMARY KEY,
        content TEXT NOT NULL,
        content_type VARCHAR(50) NOT NULL,
        language VARCHAR(20),
        tags TEXT,
        source VARCHAR(100),
        vector_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS kb_cases (
        id VARCHAR(36) PRIMARY KEY,
        original_code TEXT NOT NULL,
        optimized_code TEXT NOT NULL,
        explanation TEXT,
        language VARCHAR(20),
        issue_type VARCHAR(50),
        vector_json TEXT,
        usage_count INT DEFAULT 0,
        rating DECIMAL(3,2) DEFAULT 0.00,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS code_standards (
        id VARCHAR(36) PRIMARY KEY,
        rule_name VARCHAR(100) NOT NULL,
        rule_description TEXT NOT NULL,
        bad_example TEXT,
        good_example TEXT,
        language VARCHAR(20),
        severity VARCHAR(20),
        is_active BOOLEAN DEFAULT TRUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        id VARCHAR(36) PRIMARY KEY,
        config_key VARCHAR(100) UNIQUE NOT NULL,
        config_value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS kb_metadata (
        meta_key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS telemetry_events (
        id INT PRIMARY KEY AUTO_INCREMENT,
        event_type VARCHAR(100) NOT NULL,
        event_category VARCHAR(100) NOT NULL,
        event_data TEXT,
        severity VARCHAR(20) DEFAULT 'info',
        timestamp BIGINT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS sustain_rules (
        id INT PRIMARY KEY AUTO_INCREMENT,
        rule_id VARCHAR(36) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        \`condition\` TEXT NOT NULL,
        \`action\` TEXT NOT NULL,
        action_params TEXT,
        priority INT DEFAULT 50,
        enabled INT DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS rule_execution_log (
        id INT PRIMARY KEY AUTO_INCREMENT,
        rule_id VARCHAR(36) NOT NULL,
        rule_name VARCHAR(100) NOT NULL,
        context TEXT,
        action_taken TEXT,
        result TEXT,
        success INT,
        timestamp BIGINT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS ai_analysis_records (
        id INT PRIMARY KEY AUTO_INCREMENT,
        analysis_type VARCHAR(50) NOT NULL,
        focus VARCHAR(100) DEFAULT 'general',
        input_data TEXT,
        analysis_result TEXT,
        suggestions TEXT,
        confidence DECIMAL(5,2) DEFAULT 0,
        executed BOOLEAN DEFAULT FALSE,
        execution_result TEXT,
        timestamp BIGINT NOT NULL,
        output_data TEXT,
        ai_model VARCHAR(100),
        tokens_used INT,
        duration_ms INT,
        success BOOLEAN DEFAULT TRUE,
        error_message TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS validation_records (
        id INT PRIMARY KEY AUTO_INCREMENT,
        validation_type VARCHAR(50) NOT NULL,
        target_id VARCHAR(255),
        target_type VARCHAR(50),
        before_state TEXT,
        after_state TEXT,
        metrics_before TEXT,
        metrics_after TEXT,
        success INT DEFAULT 0,
        improvement_score DECIMAL(10,2) DEFAULT 0,
        timestamp BIGINT NOT NULL,
        cycle_id VARCHAR(100),
        result TEXT,
        score DECIMAL(5,2),
        passed BOOLEAN DEFAULT FALSE,
        details TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS self_update_history (
        id VARCHAR(36) PRIMARY KEY,
        update_type VARCHAR(50) NOT NULL,
        target_version VARCHAR(20),
        current_version VARCHAR(20),
        version_after VARCHAR(20),
        update_source VARCHAR(100),
        update_content TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        user_confirmed BOOLEAN DEFAULT FALSE,
        confirmed_at DATETIME,
        rejected_step VARCHAR(100),
        sandbox_result TEXT,
        applied_at DATETIME,
        rollback_version VARCHAR(20),
        rollback_at DATETIME,
        rolled_back_reason VARCHAR(200),
        error_message TEXT,
        duration_ms INT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS self_repair_history (
        id VARCHAR(36) PRIMARY KEY,
        error_type VARCHAR(100) NOT NULL,
        error_message TEXT,
        error_stack TEXT,
        affected_component VARCHAR(100),
        repair_strategy VARCHAR(100),
        repair_content TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        user_confirmed BOOLEAN DEFAULT FALSE,
        confirmed_at DATETIME,
        sandbox_result TEXT,
        applied_at DATETIME,
        rollback_at DATETIME,
        rolled_back_reason VARCHAR(200),
        error_count INT DEFAULT 1,
        last_error_at DATETIME,
        duration_ms INT,
        error_message_detail TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS confirmation_history (
        id VARCHAR(36) PRIMARY KEY,
        operation_type VARCHAR(100) NOT NULL,
        risk_level VARCHAR(20) NOT NULL,
        step_name VARCHAR(100),
        step_number INT DEFAULT 0,
        total_steps INT DEFAULT 0,
        description TEXT NOT NULL,
        impact VARCHAR(500),
        files_affected TEXT,
        backup_available BOOLEAN DEFAULT FALSE,
        rollback_possible BOOLEAN DEFAULT FALSE,
        status VARCHAR(20) DEFAULT 'pending',
        reason VARCHAR(200),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS api_request_log (
        id INT PRIMARY KEY AUTO_INCREMENT,
        api_key_id INT,
        provider_name VARCHAR(50),
        endpoint VARCHAR(255),
        request_method VARCHAR(10),
        request_headers TEXT,
        request_body TEXT,
        response_status INT,
        response_body TEXT,
        response_headers TEXT,
        tokens_used INT,
        latency_ms INT,
        error_message TEXT,
        is_success TINYINT(1) DEFAULT 1,
        user_id INT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS code_analysis_record (
        id VARCHAR(36) PRIMARY KEY,
        project_id INT,
        task_id INT,
        file_path VARCHAR(500) NOT NULL,
        file_name VARCHAR(255),
        language VARCHAR(50),
        file_size INT,
        line_count INT,
        complexity_score DECIMAL(10,2),
        maintainability_index DECIMAL(10,2),
        analysis_start_at DATETIME,
        analysis_end_at DATETIME,
        duration_ms INT,
        status VARCHAR(20) DEFAULT 'completed',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS analysis_result (
        id INT PRIMARY KEY AUTO_INCREMENT,
        analysis_id VARCHAR(36) NOT NULL,
        project_id INT,
        task_id INT,
        result_type VARCHAR(50) NOT NULL,
        result_data TEXT,
        confidence DECIMAL(5,2) DEFAULT 0,
        source VARCHAR(100),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS notification (
        id VARCHAR(36) PRIMARY KEY,
        user_id INT,
        message_type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        content TEXT,
        data_json TEXT,
        is_read TINYINT(1) DEFAULT 0,
        is_confirmed TINYINT(1) DEFAULT 0,
        confirmed_at DATETIME,
        action VARCHAR(50),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS system_monitor (
        id INT PRIMARY KEY AUTO_INCREMENT,
        metric_type VARCHAR(50) NOT NULL,
        metric_name VARCHAR(100) NOT NULL,
        metric_value DECIMAL(18,4) NOT NULL,
        threshold DECIMAL(18,4),
        is_alert TINYINT(1) DEFAULT 0,
        component VARCHAR(100),
        timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS backup_history (
        id VARCHAR(36) PRIMARY KEY,
        backup_type VARCHAR(50) NOT NULL,
        backup_path VARCHAR(500),
        backup_size BIGINT,
        backup_count INT,
        status VARCHAR(20) DEFAULT 'pending',
        error_message TEXT,
        started_at DATETIME,
        completed_at DATETIME,
        duration_ms INT,
        user_id INT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS kb_import_history (
        id VARCHAR(36) PRIMARY KEY,
        source_type VARCHAR(50) NOT NULL,
        source_path VARCHAR(500),
        file_count INT DEFAULT 0,
        imported_count INT DEFAULT 0,
        skipped_count INT DEFAULT 0,
        duplicate_count INT DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        error_message TEXT,
        started_at DATETIME,
        completed_at DATETIME,
        user_id INT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS dependency_version (
        id INT PRIMARY KEY AUTO_INCREMENT,
        package_name VARCHAR(255) NOT NULL,
        current_version VARCHAR(50),
        latest_version VARCHAR(50),
        is_outdated TINYINT(1) DEFAULT 0,
        update_priority VARCHAR(20) DEFAULT 'low',
        last_check_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS project_analysis_summary (
        id INT PRIMARY KEY AUTO_INCREMENT,
        project_id INT NOT NULL,
        analysis_date DATETIME NOT NULL,
        total_files INT DEFAULT 0,
        total_issues INT DEFAULT 0,
        critical_count INT DEFAULT 0,
        high_count INT DEFAULT 0,
        medium_count INT DEFAULT 0,
        low_count INT DEFAULT 0,
        fixed_count INT DEFAULT 0,
        avg_complexity DECIMAL(10,2) DEFAULT 0,
        avg_maintainability DECIMAL(10,2) DEFAULT 0,
        summary TEXT,
        user_id INT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS sync_metadata (
        id INT PRIMARY KEY AUTO_INCREMENT,
        table_name VARCHAR(50) NOT NULL,
        last_sync_at TIMESTAMP NULL,
        record_count INT DEFAULT 0,
        machine_id VARCHAR(32),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_table_machine (table_name, machine_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`CREATE INDEX idx_user_username ON sys_user(username)`).catch(() => {});
    await query(`CREATE INDEX idx_user_status ON sys_user(status)`).catch(() => {});
    await query(`CREATE INDEX idx_oper_log_user_id ON sys_oper_log(user_id)`).catch(() => {});
    await query(`CREATE INDEX idx_oper_log_operation_type ON sys_oper_log(operation_type)`).catch(() => {});
    await query(`CREATE INDEX idx_config_key ON sys_config(config_key)`).catch(() => {});
    await query(`CREATE INDEX idx_project_user_id ON scan_project(user_id)`).catch(() => {});
    await query(`CREATE INDEX idx_project_status ON scan_project(status)`).catch(() => {});
    await query(`CREATE INDEX idx_task_project_id ON scan_task(project_id)`).catch(() => {});
    await query(`CREATE INDEX idx_task_user_id ON scan_task(user_id)`).catch(() => {});
    await query(`CREATE INDEX idx_task_status ON scan_task(status)`).catch(() => {});
    await query(`CREATE INDEX idx_issue_task_id ON code_issue(task_id)`).catch(() => {});
    await query(`CREATE INDEX idx_issue_project_id ON code_issue(project_id)`).catch(() => {});
    await query(`CREATE INDEX idx_issue_type ON code_issue(issue_type)`).catch(() => {});
    await query(`CREATE INDEX idx_issue_severity ON code_issue(severity)`).catch(() => {});
    await query(`CREATE INDEX idx_issue_is_fixed ON code_issue(is_fixed)`).catch(() => {});
    await query(`CREATE INDEX idx_ai_optimize_issue_id ON ai_optimize_record(issue_id)`).catch(() => {});
    await query(`CREATE INDEX idx_report_task_id ON code_report(task_id)`).catch(() => {});
    await query(`CREATE INDEX idx_report_project_id ON code_report(project_id)`).catch(() => {});
    await query(`CREATE INDEX idx_llm_provider ON llm_api_keys(provider_name)`).catch(() => {});
    await query(`CREATE INDEX idx_llm_active ON llm_api_keys(is_active)`).catch(() => {});
    await query(`CREATE INDEX idx_access_key ON api_access_keys(access_key)`).catch(() => {});
    await query(`CREATE INDEX idx_access_active ON api_access_keys(is_active)`).catch(() => {});
    await query(`CREATE INDEX idx_kb_content_type ON kb_entries(content_type)`).catch(() => {});
    await query(`CREATE INDEX idx_kb_language ON kb_entries(language)`).catch(() => {});
    await query(`CREATE INDEX idx_kb_cases_language ON kb_cases(language)`).catch(() => {});
    await query(`CREATE INDEX idx_kb_cases_issue_type ON kb_cases(issue_type)`).catch(() => {});
    await query(`CREATE INDEX idx_standards_language ON code_standards(language)`).catch(() => {});
    await query(`CREATE INDEX idx_monitor_type ON telemetry_events(event_type)`).catch(() => {});
    await query(`CREATE INDEX idx_monitor_component ON telemetry_events(event_category)`).catch(() => {});
    await query(`CREATE INDEX idx_update_type ON self_update_history(update_type)`).catch(() => {});
    await query(`CREATE INDEX idx_update_status ON self_update_history(status)`).catch(() => {});
    await query(`CREATE INDEX idx_repair_error_type ON self_repair_history(error_type)`).catch(() => {});
    await query(`CREATE INDEX idx_repair_status ON self_repair_history(status)`).catch(() => {});
    await query(`CREATE INDEX idx_confirmation_operation ON confirmation_history(operation_type)`).catch(() => {});
    await query(`CREATE INDEX idx_confirmation_status ON confirmation_history(status)`).catch(() => {});
    
    await migrateTableStructure();
    
    const expectedTables = 32;
    const actualTableCount = (await query(`
      SELECT COUNT(*) as count FROM information_schema.TABLES 
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME != 'sync_metadata'
    `))[0].count;
    
    logger.info(`MySQL数据库表初始化完成（${actualTableCount}/${expectedTables}张表）`);
    
    if (actualTableCount < expectedTables) {
      logger.warn(`MySQL表数量不足，期望${expectedTables}张，实际${actualTableCount}张，尝试创建缺失的表...`);
      await ensureAllTablesExist();
    }
    
    return true;
  } catch (error) {
    logger.warn(`MySQL数据库表初始化失败: ${error.message}`);
    return false;
  }
}

/**
 * 迁移表结构以兼容业务代码
 */
async function migrateTableStructure() {
  try {
    await migrateTelemetryEvents();
    await migrateValidationRecords();
    await migrateAiAnalysisRecords();
    
    logger.debug('MySQL表结构迁移完成');
  } catch (error) {
    logger.debug(`MySQL表结构迁移部分失败: ${error.message}`);
  }
}

async function migrateTelemetryEvents() {
  try {
    const columns = await query(`SHOW COLUMNS FROM telemetry_events`);
    const idColumn = columns.find(col => col.Field === 'id');
    
    if (idColumn && idColumn.Type === 'varchar(36)') {
      await query(`CREATE TABLE IF NOT EXISTS telemetry_events_new (
        id INT PRIMARY KEY AUTO_INCREMENT,
        event_type VARCHAR(100) NOT NULL,
        event_category VARCHAR(100) NOT NULL,
        event_data TEXT,
        severity VARCHAR(20) DEFAULT 'info',
        timestamp BIGINT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      
      await query(`INSERT INTO telemetry_events_new (event_type, event_category, event_data, severity, timestamp, created_at)
        SELECT event_type, COALESCE(event_category, '') as event_category, event_data, COALESCE(severity, 'info') as severity, 
               COALESCE(timestamp, 0) as timestamp, COALESCE(created_at, NOW()) as created_at
        FROM telemetry_events`).catch(() => {});
      
      await query(`DROP TABLE telemetry_events`);
      await query(`RENAME TABLE telemetry_events_new TO telemetry_events`);
      
      logger.info('telemetry_events表结构迁移完成');
    }
  } catch (error) {
    logger.debug(`telemetry_events迁移失败: ${error.message}`);
  }
}

async function migrateValidationRecords() {
  try {
    const columns = await query(`SHOW COLUMNS FROM validation_records`);
    const idColumn = columns.find(col => col.Field === 'id');
    
    if (idColumn && idColumn.Type === 'varchar(36)') {
      await query(`CREATE TABLE IF NOT EXISTS validation_records_new (
        id INT PRIMARY KEY AUTO_INCREMENT,
        validation_type VARCHAR(50) NOT NULL,
        target_id VARCHAR(255),
        target_type VARCHAR(50),
        before_state TEXT,
        after_state TEXT,
        metrics_before TEXT,
        metrics_after TEXT,
        success INT DEFAULT 0,
        improvement_score DECIMAL(10,2) DEFAULT 0,
        timestamp BIGINT NOT NULL,
        cycle_id VARCHAR(100),
        result TEXT,
        score DECIMAL(5,2),
        passed BOOLEAN DEFAULT FALSE,
        details TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      
      await query(`INSERT INTO validation_records_new (validation_type, target_id, target_type, before_state, after_state, 
        metrics_before, metrics_after, success, improvement_score, timestamp, cycle_id, result, score, passed, details, created_at)
        SELECT validation_type, target_id, target_type, before_state, after_state, metrics_before, metrics_after, 
               COALESCE(success, 0) as success, COALESCE(improvement_score, 0) as improvement_score, 
               COALESCE(timestamp, 0) as timestamp, cycle_id, result, score, passed, details, COALESCE(created_at, NOW()) as created_at
        FROM validation_records`).catch(() => {});
      
      await query(`DROP TABLE validation_records`);
      await query(`RENAME TABLE validation_records_new TO validation_records`);
      
      logger.info('validation_records表结构迁移完成');
    }
  } catch (error) {
    logger.debug(`validation_records迁移失败: ${error.message}`);
  }
}

async function migrateAiAnalysisRecords() {
  try {
    const columns = await query(`SHOW COLUMNS FROM ai_analysis_records`);
    const idColumn = columns.find(col => col.Field === 'id');
    const executionResultColumn = columns.find(col => col.Field === 'execution_result');
    
    let needsRebuild = false;
    if (idColumn && idColumn.Type === 'varchar(36)') {
      needsRebuild = true;
    }
    if (!executionResultColumn) {
      needsRebuild = true;
    }
    
    if (needsRebuild) {
      await query(`CREATE TABLE IF NOT EXISTS ai_analysis_records_new (
        id INT PRIMARY KEY AUTO_INCREMENT,
        analysis_type VARCHAR(50) NOT NULL,
        focus VARCHAR(100) DEFAULT 'general',
        input_data TEXT,
        analysis_result TEXT,
        suggestions TEXT,
        confidence DECIMAL(5,2) DEFAULT 0,
        executed BOOLEAN DEFAULT FALSE,
        execution_result TEXT,
        timestamp BIGINT NOT NULL,
        output_data TEXT,
        ai_model VARCHAR(100),
        tokens_used INT,
        duration_ms INT,
        success BOOLEAN DEFAULT TRUE,
        error_message TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      
      await query(`INSERT INTO ai_analysis_records_new (analysis_type, focus, input_data, analysis_result, 
        suggestions, confidence, executed, execution_result, timestamp, output_data, ai_model, tokens_used, duration_ms, 
        success, error_message, created_at)
        SELECT analysis_type, COALESCE(focus, 'general') as focus, input_data, 
               COALESCE(analysis_result, '') as analysis_result, COALESCE(suggestions, '') as suggestions, 
               COALESCE(confidence, 0) as confidence, COALESCE(executed, 0) as executed, 
               execution_result,
               COALESCE(timestamp, 0) as timestamp, output_data, ai_model, tokens_used, duration_ms, 
               COALESCE(success, 1) as success, error_message, COALESCE(created_at, NOW()) as created_at
        FROM ai_analysis_records`).catch(() => {});
      
      await query(`DROP TABLE ai_analysis_records`);
      await query(`RENAME TABLE ai_analysis_records_new TO ai_analysis_records`);
      
      logger.info('ai_analysis_records表结构迁移完成');
    }
  } catch (error) {
    logger.debug(`ai_analysis_records迁移失败: ${error.message}`);
  }
}

/**
 * 关闭连接池
 */
async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('MySQL连接池已关闭');
  }
}

/**
 * 检查MySQL连接健康状态
 */
async function checkConnectionHealth() {
  if (!config.mysql.enabled) {
    connectionHealthy = false;
    return;
  }
  
  const pool = await getPool();
  if (!pool) {
    connectionHealthy = false;
    return;
  }
  
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    connectionHealthy = true;
    logger.debug('MySQL连接健康检查通过');
  } catch (error) {
    connectionHealthy = false;
    logger.warn(`MySQL连接健康检查失败: ${error.message}`);
  }
}

/**
 * 启动健康检查定时器
 */
function startHealthCheckTimer() {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  healthCheckTimer = setInterval(checkConnectionHealth, HEALTH_CHECK_INTERVAL);
  logger.debug('MySQL健康检查定时器已启动');
}

/**
 * 停止健康检查定时器
 */
function stopHealthCheckTimer() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

/**
 * 获取连接健康状态
 */
function isConnectionHealthy() {
  return connectionHealthy;
}

/**
 * 检查MySQL是否可用（包含健康检查）
 */
function isEnabled() {
  // 用缓存变量代替异步 getPool，避免同步路径阻塞
  return config.mysql.enabled && pool !== null && connectionHealthy;
}

/**
 * 使用自定义配置创建连接池
 */
function createPoolWithConfig(customConfig) {
  const mysqlConfig = getConnectionConfigFromCustom(customConfig);
  
  if (!mysqlConfig || !mysqlConfig.host) {
    return null;
  }

  try {
    const newPool = mysql.createPool({
      host: mysqlConfig.host,
      port: mysqlConfig.port,
      user: mysqlConfig.user,
      password: mysqlConfig.password,
      database: mysqlConfig.database,
      connectionLimit: mysqlConfig.connectionLimit,
      waitForConnections: true,
      queueLimit: 0,
      charset: 'utf8mb4'
    });

    logger.info(`MySQL连接池创建成功 (${customConfig.name || customConfig.id})`);
    return newPool;
  } catch (error) {
    logger.warn(`MySQL连接池创建失败: ${error.message}`);
    return null;
  }
}

/**
 * 使用自定义配置测试连接
 */
async function testConnectionWithConfig(customConfig) {
  // 先确保配置的数据库存在（避免 DB 被删后测试直接失败）；用户主动测试：绕过退避
  const mysqlConfig = getConnectionConfigFromCustom(customConfig);
  if (mysqlConfig) {
    await ensureDatabaseExists(mysqlConfig, { force: true });
  }

  const pool = createPoolWithConfig(customConfig);

  if (!pool) {
    return { success: false, message: '连接配置无效' };
  }

  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    await pool.end();
    return { success: true, message: 'MySQL连接成功' };
  } catch (error) {
    if (pool) {
      try {
        await pool.end();
      } catch (e) {
        logger.debug('关闭临时连接池失败:', e.message);
      }
    }
    const hint = describeMysqlErrorHint(error);
    return { success: false, message: hint ? `${error.message}。${hint}` : error.message };
  }
}

/**
 * 切换到指定数据库连接
 */
async function switchConnection(connectionConfig) {
  if (pool) {
    await closePool();
  }

  const mysqlConfig = getConnectionConfigFromCustom(connectionConfig);
  if (!mysqlConfig || !mysqlConfig.host) {
    return { success: false, message: '无效的连接配置' };
  }

  // 确保目标数据库存在（用户主动切换：绕过退避）
  const ensured = await ensureDatabaseExists(mysqlConfig, { force: true });
  if (!ensured) {
    pool = null;
    currentConnectionConfig = null;
    connectionHealthy = false;
    return { success: false, message: '无法确保目标数据库存在（请检查用户权限）' };
  }

  try {
    pool = mysql.createPool({
      host: mysqlConfig.host,
      port: mysqlConfig.port,
      user: mysqlConfig.user,
      password: mysqlConfig.password,
      database: mysqlConfig.database,
      connectionLimit: mysqlConfig.connectionLimit,
      waitForConnections: true,
      queueLimit: 0,
      charset: 'utf8mb4',
      namedPlaceholders: true,
      decimalNumbers: true,
      supportBigNumbers: true,
      bigNumberStrings: false
    });

    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();

    currentConnectionConfig = `${mysqlConfig.host}:${mysqlConfig.port}:${mysqlConfig.database}:${mysqlConfig.user}`;
    connectionHealthy = true;

    logger.info(`已切换到数据库连接: ${connectionConfig.name || connectionConfig.id}`);
    return { success: true, message: '数据库连接切换成功' };
  } catch (error) {
    pool = null;
    currentConnectionConfig = null;
    connectionHealthy = false;
    return { success: false, message: error.message };
  }
}

/**
 * 获取当前连接配置
 */
function getCurrentConnectionConfig() {
  return currentConnectionConfig || config.mysql;
}

/**
 * 验证SQL标识符（表名/列名），防止SQL注入
 */
function validateIdentifier(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`无效的SQL标识符: ${name}`);
  }
  return name;
}

/**
 * 确保所有表都存在，用于修复表创建失败的情况
 */
async function ensureAllTablesExist() {
  const pool = await getPool();
  if (!pool) return;

  const allTables = [
    'sys_user', 'sys_oper_log', 'sys_config',
    'scan_project', 'scan_task', 'code_issue',
    'ai_optimize_record', 'code_report', 'llm_api_keys',
    'api_access_keys', 'self_update_history', 'self_repair_history',
    'confirmation_history', 'kb_entries', 'kb_cases',
    'code_standards', 'user_preferences', 'kb_metadata',
    'telemetry_events', 'sustain_rules', 'rule_execution_log',
    'ai_analysis_records', 'validation_records',
    'api_request_log', 'code_analysis_record', 'analysis_result',
    'notification', 'system_monitor', 'backup_history',
    'kb_import_history', 'dependency_version', 'project_analysis_summary'
  ];
  
  try {
    const existingTables = (await query(`
      SELECT TABLE_NAME FROM information_schema.TABLES 
      WHERE TABLE_SCHEMA = DATABASE()
    `)).map(row => row.TABLE_NAME);
    
    await cleanupTempTables();
    
    for (const table of allTables) {
      if (!existingTables.includes(table)) {
        logger.info(`创建缺失的表: ${table}`);
        await createMissingTable(table);
      } else {
        await syncTableSchemaFromSqlite(table);
      }
    }
    
    const finalCount = (await query(`
      SELECT COUNT(*) as count FROM information_schema.TABLES 
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME != 'sync_metadata'
    `))[0].count;
    
    logger.info(`表检查完成，当前共有${finalCount}张表`);
  } catch (error) {
    logger.error(`确保所有表存在失败: ${error.message}`);
  }
}

async function cleanupTempTables() {
  try {
    const tempTables = (await query(`
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
      AND (TABLE_NAME LIKE '%_sync_temp' OR TABLE_NAME LIKE '%_sync_backup')
    `)).map(row => row.TABLE_NAME);

    for (const table of tempTables) {
      const safeName = validateIdentifier(table);
      await query(`DROP TABLE IF EXISTS \`${safeName}\``);
      logger.info(`清理临时表: ${safeName}`);
    }
  } catch (error) {
    logger.debug(`清理临时表失败: ${error.message}`);
  }
}

async function syncTableSchemaFromSqlite(tableName) {
  try {
    const safeName = validateIdentifier(tableName);
    const sqlite = require('./dbAdapter').dbAdapter.getSqlite();
    const schemaResult = sqlite.prepare(`PRAGMA table_info(${safeName})`).all();

    if (!schemaResult || schemaResult.length === 0) {
      logger.warn(`SQLite表 ${safeName} 不存在，跳过结构同步`);
      return;
    }

    const mysqlColumns = (await query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
    `, [safeName])).map(row => row.COLUMN_NAME);
    
    let hasChanges = false;
    for (const col of schemaResult) {
      const safeColName = validateIdentifier(col.name);
      if (!mysqlColumns.includes(col.name)) {
        let mysqlType = col.type.toUpperCase();

        if (mysqlType === 'INTEGER') {
          mysqlType = col.pk === 1 ? 'INT' : 'INT';
        } else if (mysqlType === 'TEXT') {
          mysqlType = 'TEXT';
        } else if (mysqlType === 'REAL') {
          mysqlType = 'DECIMAL(10,2)';
        } else if (mysqlType === 'BOOLEAN') {
          mysqlType = 'TINYINT(1)';
        } else if (mysqlType === 'BIGINT') {
          mysqlType = 'BIGINT';
        } else if (mysqlType === 'DATETIME') {
          mysqlType = 'DATETIME';
        } else if (mysqlType === 'VARCHAR') {
          mysqlType = `VARCHAR(255)`;
        }

        let constraint = '';
        if (col.notnull !== 1) {
          constraint += ' NULL';
        }
        if (col.dflt_value !== null && col.dflt_value !== undefined && !['TEXT', 'BLOB', 'JSON'].includes(mysqlType)) {
          let defaultValue = String(col.dflt_value).replace(/'/g, "''");
          if (!defaultValue.startsWith("'")) {
            defaultValue = `'${defaultValue}'`;
          }
          constraint += ` DEFAULT ${defaultValue}`;
        }

        try {
          await query(`ALTER TABLE \`${safeName}\` ADD COLUMN \`${safeColName}\` ${mysqlType}${constraint}`);
          logger.info(`表 ${safeName} 添加缺失字段: ${safeColName}`);
          hasChanges = true;
        } catch (alterError) {
          logger.warn(`添加字段 ${safeColName} 失败: ${alterError.message}`);
        }
      }
    }

    if (hasChanges) {
      logger.info(`表 ${safeName} 结构同步完成`);
    }
  } catch (error) {
    logger.warn(`同步表结构失败 [${tableName}]: ${error.message}`);
  }
}

async function createMissingTable(tableName) {
  try {
    const safeName = validateIdentifier(tableName);
    const sqlite = require('./dbAdapter').dbAdapter.getSqlite();
    const schemaResult = sqlite.prepare(`PRAGMA table_info(${safeName})`).all();

    if (!schemaResult || schemaResult.length === 0) {
      logger.warn(`SQLite表 ${safeName} 也不存在，跳过创建`);
      return;
    }

    const columns = schemaResult.map(col => {
      const safeColName = validateIdentifier(col.name);
      let mysqlType = col.type.toUpperCase();

      if (mysqlType === 'INTEGER') {
        mysqlType = col.pk === 1 && col.notnull === 1 ? 'INT PRIMARY KEY AUTO_INCREMENT' : 'INT';
      } else if (mysqlType === 'TEXT') {
        mysqlType = col.pk === 1 ? 'VARCHAR(36)' : 'TEXT';
      } else if (mysqlType === 'REAL') {
        mysqlType = 'DECIMAL(10,2)';
      } else if (mysqlType === 'BOOLEAN') {
        mysqlType = 'TINYINT(1)';
      } else if (mysqlType === 'BIGINT') {
        mysqlType = 'BIGINT';
      } else if (mysqlType === 'DATETIME') {
        mysqlType = 'DATETIME';
      } else if (mysqlType === 'VARCHAR') {
        mysqlType = `VARCHAR(255)`;
      }

      let constraint = '';
      if (col.notnull === 1 && !mysqlType.includes('PRIMARY KEY')) {
        constraint += ' NOT NULL';
      }
      if (col.dflt_value !== null && col.dflt_value !== undefined && !['TEXT', 'BLOB', 'JSON'].includes(mysqlType)) {
        let defaultValue = String(col.dflt_value).replace(/'/g, "''");
        if (!defaultValue.startsWith("'")) {
          defaultValue = `'${defaultValue}'`;
        }
        constraint += ` DEFAULT ${defaultValue}`;
      }
      if (col.pk === 1 && !mysqlType.includes('PRIMARY KEY')) {
        constraint += ' PRIMARY KEY';
      }

      return `\`${safeColName}\` ${mysqlType}${constraint}`;
    });

    const createSql = `CREATE TABLE \`${safeName}\` (${columns.join(', ')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
    await query(createSql);

    logger.info(`表 ${safeName} 创建成功`);
  } catch (error) {
    logger.error(`创建表 ${tableName} 失败: ${error.message}`);
  }
}

module.exports = {
  getPool,
  testConnection,
  query,
  execute,
  initDatabase,
  closePool,
  isEnabled,
  createPoolWithConfig,
  testConnectionWithConfig,
  switchConnection,
  getCurrentConnectionConfig,
  checkConnectionHealth,
  startHealthCheckTimer,
  stopHealthCheckTimer,
  isConnectionHealthy,
  ensureDatabaseExists,
  describeMysqlErrorHint
};
