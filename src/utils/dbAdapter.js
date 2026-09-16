const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { config } = require('../config');
const { logger } = require('./logger');
const { logDeduplicator } = require('./logDeduplicator');
const mysql = require('./mysql');
const { validateIdentifier, validateIdentifiers } = require('./securityGuard');

let sqliteDb = null;
let dbInitialized = false;
let retryTimer = null;
const MAX_RETRY_COUNT = 5;
const RETRY_INTERVAL = 30000;
const BATCH_SIZE = 100;

const syncMetrics = {
  totalOperations: 0,
  successfulOperations: 0,
  failedOperations: 0,
  startTime: null,
  endTime: null
};

function getSqliteDatabase() {
  if (!sqliteDb) {
    let dbPath = config.database.path;
    if (!path.isAbsolute(dbPath)) {
      dbPath = path.join(process.cwd(), dbPath);
    }
    
    // 检测旧数据库并提示迁移
    const oldDbPath = path.join(__dirname, '../database/code_optimizer.db');
    const newDbExists = fs.existsSync(dbPath);
    const oldDbExists = fs.existsSync(oldDbPath);
    
    if (oldDbExists && !newDbExists) {
      logger.info(`检测到旧数据库: ${oldDbPath}`);
      logger.info(`新数据库位置: ${dbPath}`);
      
      try {
        const oldDb = new Database(oldDbPath);
        const tableCount = oldDb.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table'").get().cnt;
        oldDb.close();
        logger.info(`旧数据库包含 ${tableCount} 张表，是否迁移数据到新位置？`);
        
        // 简单的控制台提示（非交互式，避免阻塞启动）
        console.log('\n' + '='.repeat(60));
        console.log('  检测到旧数据库文件');
        console.log(`    旧位置: ${oldDbPath}`);
        console.log(`    新位置: ${dbPath}`);
        console.log('='.repeat(60));
        console.log('  如需迁移数据，请手动复制旧数据库文件到新位置');
        console.log('='.repeat(60) + '\n');
      } catch (e) {
        logger.debug(`检测旧数据库失败: ${e.message}`);
      }
    }
    
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    sqliteDb = new Database(dbPath);
    // 性能调优：WAL 模式 + 同步级别 + 缓存 + 内存映射
    sqliteDb.pragma('foreign_keys = ON');
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('synchronous = NORMAL');
    sqliteDb.pragma('cache_size = -20000'); // 20MB 缓存
    sqliteDb.pragma('temp_store = MEMORY');
    sqliteDb.pragma('mmap_size = 268435456'); // 256MB 内存映射
    sqliteDb.pragma('wal_autocheckpoint = 1000'); // 每 1000 页自动 checkpoint
    initSyncQueueTable();
    createAllTables();
    createIndexes();
    startRetryTimer();
    
    // 只在首次初始化时输出 info 级别日志，Worker 进程使用 debug 级别
    const isMainThread = !process.env.WORKER_THREAD_ID;
    if (isMainThread || !dbInitialized) {
      logger.info(`SQLite数据库路径: ${dbPath}`);
      dbInitialized = true;
    } else {
      logger.debug(`SQLite数据库已初始化: ${dbPath}`);
    }
  }
  return sqliteDb;
}

function initSyncQueueTable() {
  try {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS sync_queue (
        id TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        sql TEXT NOT NULL,
        params TEXT,
        operation_type TEXT NOT NULL,
        retry_count INTEGER DEFAULT 0,
        last_retry_at DATETIME,
        next_retry_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 兼容旧数据库：检查并添加缺失的列
    try {
      const existingColumns = sqliteDb.prepare(`PRAGMA table_info(sync_queue)`).all();
      const existingColumnNames = existingColumns.map(col => col.name);
      
      const missingColumns = [
        { name: 'next_retry_at', type: 'DATETIME' },
        { name: 'last_retry_at', type: 'DATETIME' }
      ];
      
      for (const col of missingColumns) {
        if (!existingColumnNames.includes(col.name)) {
          sqliteDb.exec(`ALTER TABLE sync_queue ADD COLUMN ${col.name} ${col.type}`);
          logger.info(`同步队列表添加缺失列: ${col.name}`);
        }
      }
    } catch (e) {
      logger.debug(`检查同步队列表列失败: ${e.message}`);
    }
  } catch (e) {
    logger.debug(`初始化同步队列表失败: ${e.message}`);
  }
}

function createAllTables() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS sys_user (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      email VARCHAR(100),
      role VARCHAR(20) NOT NULL DEFAULT 'operator',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      last_login_at DATETIME,
      login_count INTEGER DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS sys_oper_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username VARCHAR(50),
      operation_type VARCHAR(50) NOT NULL,
      operation_desc TEXT,
      request_method VARCHAR(10),
      request_url VARCHAR(255),
      request_params TEXT,
      response_status INTEGER,
      ip_address VARCHAR(50),
      user_agent TEXT,
      duration_ms INTEGER,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS sys_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_key VARCHAR(100) NOT NULL UNIQUE,
      config_value TEXT,
      config_type VARCHAR(50),
      description TEXT,
      is_public BOOLEAN DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS scan_project (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_name VARCHAR(255) NOT NULL,
      project_path VARCHAR(500) NOT NULL,
      project_type VARCHAR(50),
      language VARCHAR(50),
      framework VARCHAR(100),
      description TEXT,
      total_files INTEGER DEFAULT 0,
      total_lines INTEGER DEFAULT 0,
      scan_count INTEGER DEFAULT 0,
      last_scan_at DATETIME,
      user_id INTEGER,
      status VARCHAR(20) DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS scan_task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      task_name VARCHAR(255),
      scan_mode VARCHAR(20) NOT NULL,
      scan_type VARCHAR(50) NOT NULL,
      target_path VARCHAR(500),
      file_count INTEGER DEFAULT 0,
      scanned_files INTEGER DEFAULT 0,
      issue_count INTEGER DEFAULT 0,
      issue_critical INTEGER DEFAULT 0,
      issue_high INTEGER DEFAULT 0,
      issue_medium INTEGER DEFAULT 0,
      issue_low INTEGER DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending',
      progress INTEGER DEFAULT 0,
      started_at DATETIME,
      completed_at DATETIME,
      duration_ms INTEGER,
      error_message TEXT,
      user_id INTEGER,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS code_issue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      project_id INTEGER,
      file_path VARCHAR(500) NOT NULL,
      file_name VARCHAR(255),
      language VARCHAR(50),
      issue_type VARCHAR(50) NOT NULL,
      severity VARCHAR(20) NOT NULL,
      message TEXT NOT NULL,
      suggestion TEXT,
      line_start INTEGER NOT NULL,
      line_end INTEGER,
      column_start INTEGER,
      column_end INTEGER,
      code_snippet TEXT,
      ast_node_type VARCHAR(100),
      is_fixed BOOLEAN DEFAULT 0,
      fixed_at DATETIME,
      fixed_by_user_id INTEGER,
      fix_suggestion TEXT,
      ai_optimized BOOLEAN DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS ai_optimize_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      task_id INTEGER,
      original_code TEXT NOT NULL,
      optimized_code TEXT,
      explanation TEXT,
      optimization_type VARCHAR(50),
      ai_model VARCHAR(100),
      tokens_used INTEGER,
      api_latency_ms INTEGER,
      user_rating INTEGER,
      user_feedback TEXT,
      is_applied BOOLEAN DEFAULT 0,
      applied_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS code_report (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      project_id INTEGER,
      report_name VARCHAR(255) NOT NULL,
      report_type VARCHAR(50),
      file_path VARCHAR(500),
      file_size_kb REAL,
      summary TEXT,
      include_ai_suggestions BOOLEAN DEFAULT 1,
      user_id INTEGER,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS llm_api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_name VARCHAR(50) NOT NULL,
      api_key TEXT NOT NULL,
      api_url TEXT,
      model_name VARCHAR(100),
      is_active BOOLEAN DEFAULT 1,
      priority INTEGER DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS api_access_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      access_key VARCHAR(100) NOT NULL UNIQUE,
      key_name VARCHAR(100),
      permissions TEXT,
      rate_limit INTEGER DEFAULT 100,
      usage_count INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT 1,
      expires_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS self_update_history (
      id TEXT PRIMARY KEY,
      update_type VARCHAR(50) NOT NULL,
      target_version VARCHAR(20),
      current_version VARCHAR(20),
      version_after VARCHAR(20),
      update_source VARCHAR(100),
      update_content TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      user_confirmed BOOLEAN DEFAULT 0,
      confirmed_at DATETIME,
      rejected_step VARCHAR(100),
      sandbox_result TEXT,
      applied_at DATETIME,
      rollback_version VARCHAR(20),
      rollback_at DATETIME,
      rolled_back_reason VARCHAR(200),
      error_message TEXT,
      duration_ms INTEGER,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS self_repair_history (
      id TEXT PRIMARY KEY,
      error_type VARCHAR(100) NOT NULL,
      error_message TEXT,
      error_stack TEXT,
      affected_component VARCHAR(100),
      repair_strategy VARCHAR(100),
      repair_content TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      user_confirmed BOOLEAN DEFAULT 0,
      confirmed_at DATETIME,
      sandbox_result TEXT,
      applied_at DATETIME,
      rollback_at DATETIME,
      rolled_back_reason VARCHAR(200),
      error_count INTEGER DEFAULT 1,
      last_error_at DATETIME,
      duration_ms INTEGER,
      error_message_detail TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS confirmation_history (
      id TEXT PRIMARY KEY,
      operation_type VARCHAR(100) NOT NULL,
      risk_level VARCHAR(20) NOT NULL,
      step_name VARCHAR(100),
      step_number INTEGER DEFAULT 0,
      total_steps INTEGER DEFAULT 0,
      description TEXT NOT NULL,
      impact VARCHAR(500),
      files_affected TEXT,
      backup_available BOOLEAN DEFAULT 0,
      rollback_possible BOOLEAN DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending',
      reason VARCHAR(200),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS kb_entries (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      content_type TEXT NOT NULL,
      language TEXT,
      tags TEXT,
      source TEXT,
      vector_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS kb_cases (
      id TEXT PRIMARY KEY,
      original_code TEXT NOT NULL,
      optimized_code TEXT NOT NULL,
      explanation TEXT,
      language TEXT,
      issue_type TEXT,
      vector_json TEXT,
      usage_count INTEGER DEFAULT 0,
      rating REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS code_standards (
      id TEXT PRIMARY KEY,
      rule_name VARCHAR(100) NOT NULL,
      rule_description TEXT NOT NULL,
      bad_example TEXT,
      good_example TEXT,
      language VARCHAR(20),
      severity VARCHAR(20),
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS user_preferences (
      id TEXT PRIMARY KEY,
      config_key VARCHAR(100) UNIQUE NOT NULL,
      config_value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS kb_metadata (
      meta_key VARCHAR(100) PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS telemetry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type VARCHAR(100) NOT NULL,
      event_category VARCHAR(100) NOT NULL,
      event_data TEXT,
      severity VARCHAR(20) DEFAULT 'info',
      timestamp BIGINT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS sustain_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      condition TEXT NOT NULL,
      action TEXT NOT NULL,
      action_params TEXT,
      priority INTEGER DEFAULT 50,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS rule_execution_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id VARCHAR(36) NOT NULL,
      rule_name VARCHAR(100) NOT NULL,
      context TEXT,
      action_taken TEXT,
      result TEXT,
      success INTEGER,
      timestamp BIGINT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS ai_analysis_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_type VARCHAR(50) NOT NULL,
      focus VARCHAR(100) DEFAULT 'general',
      input_data TEXT,
      analysis_result TEXT,
      suggestions TEXT,
      confidence REAL DEFAULT 0,
      executed BOOLEAN DEFAULT 0,
      execution_result TEXT,
      timestamp BIGINT NOT NULL,
      output_data TEXT,
      ai_model VARCHAR(100),
      tokens_used INTEGER,
      duration_ms INTEGER,
      success BOOLEAN DEFAULT 1,
      error_message TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS validation_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      validation_type VARCHAR(50) NOT NULL,
      target_id TEXT,
      target_type VARCHAR(50),
      before_state TEXT,
      after_state TEXT,
      metrics_before TEXT,
      metrics_after TEXT,
      success INTEGER DEFAULT 0,
      improvement_score REAL DEFAULT 0,
      timestamp BIGINT NOT NULL,
      cycle_id TEXT,
      result TEXT,
      score REAL,
      passed BOOLEAN DEFAULT 0,
      details TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS api_request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER,
      provider_name VARCHAR(50),
      endpoint VARCHAR(255),
      request_method VARCHAR(10),
      request_headers TEXT,
      request_body TEXT,
      response_status INTEGER,
      response_body TEXT,
      response_headers TEXT,
      tokens_used INTEGER,
      latency_ms INTEGER,
      error_message TEXT,
      is_success BOOLEAN DEFAULT 1,
      user_id INTEGER,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS code_analysis_record (
      id TEXT PRIMARY KEY,
      project_id INTEGER,
      task_id INTEGER,
      file_path VARCHAR(500) NOT NULL,
      file_name VARCHAR(255),
      language VARCHAR(50),
      file_size INTEGER,
      line_count INTEGER,
      complexity_score REAL,
      maintainability_index REAL,
      analysis_start_at DATETIME,
      analysis_end_at DATETIME,
      duration_ms INTEGER,
      status VARCHAR(20) DEFAULT 'completed',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_result (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_id TEXT NOT NULL,
      project_id INTEGER,
      task_id INTEGER,
      result_type VARCHAR(50) NOT NULL,
      result_data TEXT,
      confidence REAL DEFAULT 0,
      source VARCHAR(100),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS notification (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      message_type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      content TEXT,
      data_json TEXT,
      is_read BOOLEAN DEFAULT 0,
      is_confirmed BOOLEAN DEFAULT 0,
      confirmed_at DATETIME,
      action VARCHAR(50),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS system_monitor (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric_type VARCHAR(50) NOT NULL,
      metric_name VARCHAR(100) NOT NULL,
      metric_value REAL NOT NULL,
      threshold REAL,
      is_alert BOOLEAN DEFAULT 0,
      component VARCHAR(100),
      timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS backup_history (
      id TEXT PRIMARY KEY,
      backup_type VARCHAR(50) NOT NULL,
      backup_path VARCHAR(500),
      backup_size BIGINT,
      backup_count INTEGER,
      status VARCHAR(20) DEFAULT 'pending',
      error_message TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      duration_ms INTEGER,
      user_id INTEGER,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS kb_import_history (
      id TEXT PRIMARY KEY,
      source_type VARCHAR(50) NOT NULL,
      source_path VARCHAR(500),
      file_count INTEGER DEFAULT 0,
      imported_count INTEGER DEFAULT 0,
      skipped_count INTEGER DEFAULT 0,
      duplicate_count INTEGER DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending',
      error_message TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      user_id INTEGER,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS dependency_version (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_name VARCHAR(255) NOT NULL,
      current_version VARCHAR(50),
      latest_version VARCHAR(50),
      is_outdated BOOLEAN DEFAULT 0,
      update_priority VARCHAR(20) DEFAULT 'low',
      last_check_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS project_analysis_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      analysis_date DATETIME NOT NULL,
      total_files INTEGER DEFAULT 0,
      total_issues INTEGER DEFAULT 0,
      critical_count INTEGER DEFAULT 0,
      high_count INTEGER DEFAULT 0,
      medium_count INTEGER DEFAULT 0,
      low_count INTEGER DEFAULT 0,
      fixed_count INTEGER DEFAULT 0,
      avg_complexity REAL DEFAULT 0,
      avg_maintainability REAL DEFAULT 0,
      summary TEXT,
      user_id INTEGER,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ];
  
  for (const sql of tables) {
    try {
      sqliteDb.exec(sql);
    } catch (e) {
      logger.warn(`创建表失败: ${e.message}`);
    }
  }
  
  migrateSqliteTables();
  
  // Worker 环境下使用 debug 级别，避免重复日志
  const isWorker = !!process.env.WORKER_THREAD_ID;
  if (isWorker) {
    logger.debug(`SQLite数据库表初始化完成（${tables.length}张表）`);
  } else {
    logDeduplicator.logWithDeduplication('info', 'db_init_complete', `SQLite数据库表初始化完成（${tables.length}张表）`);
  }
}

/**
 * 创建数据库索引以加速高频查询。
 * 全部使用 IF NOT EXISTS，可安全重复执行。
 * 索引覆盖：外键关联列、时间戳列（用于范围查询/清理）、状态过滤列。
 */
function createIndexes() {
  const indexes = [
    // code_issue：按任务/项目/文件/严重级别查询
    'CREATE INDEX IF NOT EXISTS idx_code_issue_task_id ON code_issue(task_id)',
    'CREATE INDEX IF NOT EXISTS idx_code_issue_project_id ON code_issue(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_code_issue_file_path ON code_issue(file_path)',
    'CREATE INDEX IF NOT EXISTS idx_code_issue_severity ON code_issue(severity)',
    'CREATE INDEX IF NOT EXISTS idx_code_issue_fixed ON code_issue(is_fixed)',
    // scan_task：按项目/状态查询
    'CREATE INDEX IF NOT EXISTS idx_scan_task_project_id ON scan_task(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_scan_task_status ON scan_task(status)',
    // ai_optimize_record：按问题/任务查询
    'CREATE INDEX IF NOT EXISTS idx_ai_opt_issue_id ON ai_optimize_record(issue_id)',
    'CREATE INDEX IF NOT EXISTS idx_ai_opt_task_id ON ai_optimize_record(task_id)',
    // code_report / code_analysis_record / analysis_result：按任务/项目查询
    'CREATE INDEX IF NOT EXISTS idx_code_report_task_id ON code_report(task_id)',
    'CREATE INDEX IF NOT EXISTS idx_code_analysis_project ON code_analysis_record(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_code_analysis_task ON code_analysis_record(task_id)',
    'CREATE INDEX IF NOT EXISTS idx_analysis_result_aid ON analysis_result(analysis_id)',
    'CREATE INDEX IF NOT EXISTS idx_analysis_result_project ON analysis_result(project_id)',
    // 时间戳列：telemetry / 日志 / 监控（按时间范围查询与定期清理）
    'CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry_events(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry_events(event_type)',
    'CREATE INDEX IF NOT EXISTS idx_rule_exec_rule ON rule_execution_log(rule_id)',
    'CREATE INDEX IF NOT EXISTS idx_rule_exec_ts ON rule_execution_log(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_ai_analysis_ts ON ai_analysis_records(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_ai_analysis_type ON ai_analysis_records(analysis_type)',
    'CREATE INDEX IF NOT EXISTS idx_validation_ts ON validation_records(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_validation_target ON validation_records(target_id)',
    'CREATE INDEX IF NOT EXISTS idx_api_req_log_created ON api_request_log(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_api_req_log_provider ON api_request_log(provider_name)',
    'CREATE INDEX IF NOT EXISTS idx_sys_oper_log_created ON sys_oper_log(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_sys_oper_log_user ON sys_oper_log(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_system_monitor_ts ON system_monitor(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_system_monitor_type ON system_monitor(metric_type)',
    'CREATE INDEX IF NOT EXISTS idx_project_summary_project ON project_analysis_summary(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_project_summary_date ON project_analysis_summary(analysis_date)',
    // 通知：未读查询
    'CREATE INDEX IF NOT EXISTS idx_notification_user_read ON notification(user_id, is_read)',
    'CREATE INDEX IF NOT EXISTS idx_notification_created ON notification(created_at)',
    // 历史/状态查询
    'CREATE INDEX IF NOT EXISTS idx_update_history_status ON self_update_history(status)',
    'CREATE INDEX IF NOT EXISTS idx_update_history_created ON self_update_history(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_repair_history_status ON self_repair_history(status)',
    'CREATE INDEX IF NOT EXISTS idx_repair_history_created ON self_repair_history(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_confirmation_status ON confirmation_history(status)',
    'CREATE INDEX IF NOT EXISTS idx_backup_history_status ON backup_history(status)',
    'CREATE INDEX IF NOT EXISTS idx_kb_import_status ON kb_import_history(status)',
    // 知识库：按类型/语言过滤
    'CREATE INDEX IF NOT EXISTS idx_kb_entries_type ON kb_entries(content_type)',
    'CREATE INDEX IF NOT EXISTS idx_kb_entries_language ON kb_entries(language)',
    'CREATE INDEX IF NOT EXISTS idx_kb_cases_language ON kb_cases(language)',
    'CREATE INDEX IF NOT EXISTS idx_kb_cases_issue_type ON kb_cases(issue_type)',
    // 同步队列：重试调度
    'CREATE INDEX IF NOT EXISTS idx_sync_queue_next_retry ON sync_queue(next_retry_at)',
    'CREATE INDEX IF NOT EXISTS idx_sync_queue_table ON sync_queue(table_name)',
    // LLM 密钥：活跃查询
    'CREATE INDEX IF NOT EXISTS idx_llm_keys_active ON llm_api_keys(is_active)',
    'CREATE INDEX IF NOT EXISTS idx_dependency_pkg ON dependency_version(package_name)'
  ];

  let created = 0;
  for (const sql of indexes) {
    try {
      sqliteDb.exec(sql);
      created++;
    } catch (e) {
      logger.debug(`创建索引失败: ${e.message}`);
    }
  }
  const isWorker = !!process.env.WORKER_THREAD_ID;
  if (!isWorker) {
    logDeduplicator.logWithDeduplication('info', 'db_indexes_complete', `数据库索引创建完成（${created}/${indexes.length}）`);
  }
}

function migrateSqliteTables() {
  // 主键类型迁移：将 INTEGER AUTOINCREMENT 主键改为 TEXT PRIMARY KEY
  const pkMigrations = [
    { table: 'self_update_history', columns: 'id TEXT PRIMARY KEY, version_before VARCHAR(20), version_after VARCHAR(20), update_source VARCHAR(100), update_content TEXT, user_confirmed BOOLEAN DEFAULT 0, confirmed_at DATETIME, rejected_step VARCHAR(100), sandbox_result TEXT, applied_at DATETIME, rollback_version VARCHAR(20), rollback_at DATETIME, rolled_back_reason VARCHAR(200), duration_ms INTEGER, created_at DATETIME' },
    { table: 'self_repair_history', columns: 'id TEXT PRIMARY KEY, repair_strategy VARCHAR(100), repair_content TEXT, user_confirmed BOOLEAN DEFAULT 0, confirmed_at DATETIME, sandbox_result TEXT, applied_at DATETIME, rollback_at DATETIME, rolled_back_reason VARCHAR(200), error_count INTEGER DEFAULT 1, last_error_at DATETIME, duration_ms INTEGER, error_message_detail TEXT, created_at DATETIME' },
    { table: 'confirmation_history', columns: 'id TEXT PRIMARY KEY, user_id INTEGER, action VARCHAR(100), description TEXT, impact VARCHAR(500), files_affected TEXT, backup_available BOOLEAN DEFAULT 0, rollback_possible BOOLEAN DEFAULT 0, status VARCHAR(20) DEFAULT "pending", reason VARCHAR(200), created_at DATETIME' },
    { table: 'code_standards', columns: 'id TEXT PRIMARY KEY, language VARCHAR(50), rule_name VARCHAR(200), rule_code VARCHAR(100), description TEXT, severity VARCHAR(20), category VARCHAR(50), pattern TEXT, fix_suggestion TEXT, created_at DATETIME' },
    { table: 'user_preferences', columns: 'id TEXT PRIMARY KEY, user_id INTEGER, config_key VARCHAR(100), config_value TEXT, category VARCHAR(50), created_at DATETIME' },
    { table: 'kb_metadata', columns: 'id TEXT PRIMARY KEY, kb_entry_id INTEGER, meta_key VARCHAR(100), meta_value TEXT, created_at DATETIME' },
    { table: 'code_analysis_record', columns: 'id TEXT PRIMARY KEY, project_id INTEGER, file_path VARCHAR(500), language VARCHAR(50), file_size INTEGER, line_count INTEGER, complexity_score REAL, maintainability_index REAL, analysis_start_at DATETIME, analysis_end_at DATETIME, duration_ms INTEGER, status VARCHAR(20) DEFAULT "completed", created_at DATETIME' },
    { table: 'notification', columns: 'id TEXT PRIMARY KEY, user_id INTEGER, type VARCHAR(50), title VARCHAR(200), message TEXT, data_json TEXT, is_confirmed BOOLEAN DEFAULT 0, confirmed_at DATETIME, action VARCHAR(50), created_at DATETIME' },
    { table: 'backup_history', columns: 'id TEXT PRIMARY KEY, backup_type VARCHAR(50), backup_path VARCHAR(500), file_size_kb REAL, status VARCHAR(20), error_message TEXT, started_at DATETIME, completed_at DATETIME, duration_ms INTEGER, user_id INTEGER, created_at DATETIME' },
    { table: 'kb_import_history', columns: 'id TEXT PRIMARY KEY, kb_id INTEGER, file_path VARCHAR(500), import_count INTEGER DEFAULT 0, skipped_count INTEGER DEFAULT 0, duplicate_count INTEGER DEFAULT 0, error_message TEXT, started_at DATETIME, completed_at DATETIME, user_id INTEGER, created_at DATETIME' }
  ];
  
  for (const pkMig of pkMigrations) {
    try {
      const existingColumns = sqliteDb.prepare(`PRAGMA table_info(${pkMig.table})`).all();
      const pkCol = existingColumns.find(col => col.pk === 1);
      
      if (pkCol && pkCol.type !== 'TEXT') {
        // Worker 环境下使用 debug 级别，避免重复日志
        const isWorker = !!process.env.WORKER_THREAD_ID;
        if (isWorker) {
          logger.debug(`检测到 ${pkMig.table} 主键类型需要迁移 (${pkCol.type} → TEXT)`);
        } else {
          logDeduplicator.logWithDeduplication('info', `pk_migrate_${pkMig.table}`, `检测到 ${pkMig.table} 主键类型需要迁移 (${pkCol.type} → TEXT)`);
        }
        try {
          // 创建临时表
          sqliteDb.exec(`CREATE TABLE IF NOT EXISTS ${pkMig.table}_temp (${pkMig.columns})`);
          // 复制数据（将 INTEGER id 转为 TEXT）
          const copyResult = sqliteDb.prepare(`INSERT INTO ${pkMig.table}_temp SELECT * FROM ${pkMig.table}`).run();
          if (copyResult.changes > 0) {
            // 删除旧表
            sqliteDb.exec(`DROP TABLE ${pkMig.table}`);
            // 重命名临时表
            sqliteDb.exec(`ALTER TABLE ${pkMig.table}_temp RENAME TO ${pkMig.table}`);
            if (isWorker) {
              logger.debug(`主键类型迁移完成 ${pkMig.table}: 迁移 ${copyResult.changes} 条记录`);
            } else {
              logDeduplicator.logWithDeduplication('info', `pk_migrate_done_${pkMig.table}`, `主键类型迁移完成 ${pkMig.table}: 迁移 ${copyResult.changes} 条记录`);
            }
          } else {
            // 无数据，直接删除旧表并重命名
            sqliteDb.exec(`DROP TABLE ${pkMig.table}`);
            sqliteDb.exec(`ALTER TABLE ${pkMig.table}_temp RENAME TO ${pkMig.table}`);
            if (isWorker) {
              logger.debug(`主键类型迁移完成 ${pkMig.table}: 空表`);
            } else {
              logDeduplicator.logWithDeduplication('info', `pk_migrate_done_${pkMig.table}`, `主键类型迁移完成 ${pkMig.table}: 空表`);
            }
          }
        } catch (e) {
          logger.debug(`主键类型迁移 ${pkMig.table} 失败: ${e.message}`);
          // 清理临时表
          try { sqliteDb.exec(`DROP TABLE IF EXISTS ${pkMig.table}_temp`); } catch {}
        }
      }
    } catch (e) {
      logger.debug(`检测主键类型 ${pkMig.table} 失败: ${e.message}`);
    }
  }
  
  // 列重命名数据迁移：检测旧列是否存在且有数据，复制到新列
  const renameMigrations = [
    { table: 'ai_optimize_record', renames: [
      { old: 'applied', new: 'is_applied' }
    ]},
    { table: 'user_preferences', renames: [
      { old: 'preference_key', new: 'config_key' },
      { old: 'preference_value', new: 'config_value' }
    ]},
    { table: 'kb_metadata', renames: [
      { old: 'key', new: 'meta_key' }
    ]}
  ];
  
  let dataMigratedCount = 0;
  for (const rename of renameMigrations) {
    try {
      const existingColumns = sqliteDb.prepare(`PRAGMA table_info(${rename.table})`).all();
      const existingColumnNames = existingColumns.map(col => col.name);
      
      for (const r of rename.renames) {
        if (existingColumnNames.includes(r.old) && !existingColumnNames.includes(r.new)) {
          try {
            // 添加新列
            sqliteDb.exec(`ALTER TABLE ${rename.table} ADD COLUMN ${r.new} TEXT`);
            // 复制数据
            const count = sqliteDb.prepare(`UPDATE ${rename.table} SET ${r.new} = ${r.old} WHERE ${r.new} IS NULL`).run().changes;
            if (count > 0) {
              dataMigratedCount += count;
              logger.debug(`迁移 ${rename.table}: ${r.old} → ${r.new}, 迁移 ${count} 条数据`);
            }
          } catch (e) {
            logger.debug(`列重命名迁移 ${rename.table}.${r.old} → ${r.new} 失败: ${e.message}`);
          }
        }
      }
    } catch (e) {
      logger.debug(`列重命名迁移表 ${rename.table} 失败: ${e.message}`);
    }
  }
  
  if (dataMigratedCount > 0) {
    logger.info(`SQLite列重命名数据迁移完成，共迁移 ${dataMigratedCount} 条数据`);
  }
  
  const migrations = [
    { table: 'scan_project', columns: [
      { name: 'framework', type: 'VARCHAR(100)' },
      { name: 'description', type: 'TEXT' },
      { name: 'total_files', type: 'INTEGER DEFAULT 0' },
      { name: 'total_lines', type: 'INTEGER DEFAULT 0' },
      { name: 'scan_count', type: 'INTEGER DEFAULT 0' },
      { name: 'last_scan_at', type: 'DATETIME' },
      { name: 'user_id', type: 'INTEGER' }
    ]},
    { table: 'scan_task', columns: [
      { name: 'target_path', type: 'VARCHAR(500)' },
      { name: 'file_count', type: 'INTEGER DEFAULT 0' },
      { name: 'scanned_files', type: 'INTEGER DEFAULT 0' },
      { name: 'issue_count', type: 'INTEGER DEFAULT 0' },
      { name: 'issue_critical', type: 'INTEGER DEFAULT 0' },
      { name: 'issue_high', type: 'INTEGER DEFAULT 0' },
      { name: 'issue_medium', type: 'INTEGER DEFAULT 0' },
      { name: 'issue_low', type: 'INTEGER DEFAULT 0' },
      { name: 'progress', type: 'INTEGER DEFAULT 0' },
      { name: 'started_at', type: 'DATETIME' },
      { name: 'completed_at', type: 'DATETIME' },
      { name: 'duration_ms', type: 'INTEGER' },
      { name: 'error_message', type: 'TEXT' },
      { name: 'user_id', type: 'INTEGER' }
    ]},
    { table: 'code_issue', columns: [
      { name: 'language', type: 'VARCHAR(50)' },
      { name: 'message', type: 'TEXT' },
      { name: 'line_start', type: 'INTEGER' },
      { name: 'line_end', type: 'INTEGER' },
      { name: 'column_start', type: 'INTEGER' },
      { name: 'column_end', type: 'INTEGER' },
      { name: 'code_snippet', type: 'TEXT' },
      { name: 'ast_node_type', type: 'VARCHAR(100)' },
      { name: 'fixed_by_user_id', type: 'INTEGER' },
      { name: 'fix_suggestion', type: 'TEXT' },
      { name: 'ai_optimized', type: 'BOOLEAN DEFAULT 0' }
    ]},
    { table: 'ai_optimize_record', columns: [
      { name: 'explanation', type: 'TEXT' },
      { name: 'ai_model', type: 'VARCHAR(100)' },
      { name: 'tokens_used', type: 'INTEGER' },
      { name: 'api_latency_ms', type: 'INTEGER' },
      { name: 'user_rating', type: 'INTEGER' },
      { name: 'user_feedback', type: 'TEXT' },
      { name: 'is_applied', type: 'BOOLEAN DEFAULT 0' }
    ]},
    { table: 'code_report', columns: [
      { name: 'file_path', type: 'VARCHAR(500)' },
      { name: 'file_size_kb', type: 'REAL' },
      { name: 'summary', type: 'TEXT' },
      { name: 'include_ai_suggestions', type: 'BOOLEAN DEFAULT 1' },
      { name: 'user_id', type: 'INTEGER' }
    ]},
    { table: 'llm_api_keys', columns: [
      { name: 'priority', type: 'INTEGER DEFAULT 0' }
    ]},
    { table: 'api_access_keys', columns: [
      { name: 'usage_count', type: 'INTEGER DEFAULT 0' }
    ]},
    { table: 'self_update_history', columns: [
      { name: 'update_source', type: 'VARCHAR(100)' },
      { name: 'update_content', type: 'TEXT' },
      { name: 'user_confirmed', type: 'BOOLEAN DEFAULT 0' },
      { name: 'confirmed_at', type: 'DATETIME' },
      { name: 'rejected_step', type: 'VARCHAR(100)' },
      { name: 'sandbox_result', type: 'TEXT' },
      { name: 'applied_at', type: 'DATETIME' },
      { name: 'rollback_version', type: 'VARCHAR(20)' },
      { name: 'rollback_at', type: 'DATETIME' },
      { name: 'rolled_back_reason', type: 'VARCHAR(200)' },
      { name: 'duration_ms', type: 'INTEGER' }
    ]},
    { table: 'self_repair_history', columns: [
      { name: 'repair_strategy', type: 'VARCHAR(100)' },
      { name: 'repair_content', type: 'TEXT' },
      { name: 'user_confirmed', type: 'BOOLEAN DEFAULT 0' },
      { name: 'confirmed_at', type: 'DATETIME' },
      { name: 'sandbox_result', type: 'TEXT' },
      { name: 'applied_at', type: 'DATETIME' },
      { name: 'rollback_at', type: 'DATETIME' },
      { name: 'rolled_back_reason', type: 'VARCHAR(200)' },
      { name: 'error_count', type: 'INTEGER DEFAULT 1' },
      { name: 'last_error_at', type: 'DATETIME' },
      { name: 'duration_ms', type: 'INTEGER' },
      { name: 'error_message_detail', type: 'TEXT' }
    ]},
    { table: 'confirmation_history', columns: [
      { name: 'description', type: 'TEXT' },
      { name: 'impact', type: 'VARCHAR(500)' },
      { name: 'files_affected', type: 'TEXT' },
      { name: 'backup_available', type: 'BOOLEAN DEFAULT 0' },
      { name: 'rollback_possible', type: 'BOOLEAN DEFAULT 0' },
      { name: 'status', type: 'VARCHAR(20) DEFAULT "pending"' },
      { name: 'reason', type: 'VARCHAR(200)' }
    ]},
    { table: 'code_analysis_record', columns: [
      { name: 'language', type: 'VARCHAR(50)' },
      { name: 'file_size', type: 'INTEGER' },
      { name: 'line_count', type: 'INTEGER' },
      { name: 'complexity_score', type: 'REAL' },
      { name: 'maintainability_index', type: 'REAL' },
      { name: 'analysis_start_at', type: 'DATETIME' },
      { name: 'analysis_end_at', type: 'DATETIME' },
      { name: 'duration_ms', type: 'INTEGER' },
      { name: 'status', type: 'VARCHAR(20) DEFAULT "completed"' }
    ]},
    { table: 'analysis_result', columns: [
      { name: 'confidence', type: 'REAL DEFAULT 0' },
      { name: 'source', type: 'VARCHAR(100)' }
    ]},
    { table: 'notification', columns: [
      { name: 'data_json', type: 'TEXT' },
      { name: 'is_confirmed', type: 'BOOLEAN DEFAULT 0' },
      { name: 'confirmed_at', type: 'DATETIME' },
      { name: 'action', type: 'VARCHAR(50)' }
    ]},
    { table: 'system_monitor', columns: [
      { name: 'is_alert', type: 'BOOLEAN DEFAULT 0' },
      { name: 'component', type: 'VARCHAR(100)' }
    ]},
    { table: 'backup_history', columns: [
      { name: 'error_message', type: 'TEXT' },
      { name: 'started_at', type: 'DATETIME' },
      { name: 'completed_at', type: 'DATETIME' },
      { name: 'duration_ms', type: 'INTEGER' },
      { name: 'user_id', type: 'INTEGER' }
    ]},
    { table: 'kb_import_history', columns: [
      { name: 'skipped_count', type: 'INTEGER DEFAULT 0' },
      { name: 'duplicate_count', type: 'INTEGER DEFAULT 0' },
      { name: 'error_message', type: 'TEXT' },
      { name: 'started_at', type: 'DATETIME' },
      { name: 'completed_at', type: 'DATETIME' },
      { name: 'user_id', type: 'INTEGER' }
    ]},
    { table: 'dependency_version', columns: [
      { name: 'update_priority', type: 'VARCHAR(20) DEFAULT "low"' },
      { name: 'last_check_at', type: 'DATETIME' }
    ]},
    { table: 'project_analysis_summary', columns: [
      { name: 'critical_count', type: 'INTEGER DEFAULT 0' },
      { name: 'high_count', type: 'INTEGER DEFAULT 0' },
      { name: 'medium_count', type: 'INTEGER DEFAULT 0' },
      { name: 'low_count', type: 'INTEGER DEFAULT 0' },
      { name: 'fixed_count', type: 'INTEGER DEFAULT 0' },
      { name: 'avg_complexity', type: 'REAL DEFAULT 0' },
      { name: 'avg_maintainability', type: 'REAL DEFAULT 0' },
      { name: 'summary', type: 'TEXT' },
      { name: 'user_id', type: 'INTEGER' }
    ]}
  ];
  
  let migratedCount = 0;
  
  for (const migration of migrations) {
    try {
      const existingColumns = sqliteDb.prepare(`PRAGMA table_info(${migration.table})`).all();
      const existingColumnNames = existingColumns.map(col => col.name);
      
      for (const col of migration.columns) {
        if (!existingColumnNames.includes(col.name)) {
          try {
            sqliteDb.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${col.name} ${col.type}`);
            migratedCount++;
          } catch (e) {
            logger.debug(`添加列 ${migration.table}.${col.name} 失败: ${e.message}`);
          }
        }
      }
    } catch (e) {
      logger.debug(`迁移表 ${migration.table} 失败: ${e.message}`);
    }
  }
  
  if (migratedCount > 0) {
    logger.info(`SQLite表结构迁移完成，共添加 ${migratedCount} 个缺失列`);
  }
}

function enqueueSyncOperation(tableName, sql, params, operationType) {
  try {
    const id = require('./helpers').generateUUID();
    sqliteDb.prepare(`
      INSERT INTO sync_queue (id, table_name, sql, params, operation_type)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, tableName, sql, JSON.stringify(params), operationType);
    logger.debug(`操作已加入同步队列 [${tableName}]: ${operationType}`);
  } catch (e) {
    logger.warn(`加入同步队列失败: ${e.message}`);
  }
}

/**
 * 指数退避延迟计算
 */
function getExponentialBackoffDelay(retryCount, baseDelay = 1000, maxDelay = 30000) {
  const delay = baseDelay * Math.pow(2, retryCount) + Math.random() * 1000;
  return Math.min(delay, maxDelay);
}

/**
 * 批量执行MySQL操作
 */
async function executeBatchOperations(pool, operations) {
  const batchResults = [];
  
  for (let i = 0; i < operations.length; i += BATCH_SIZE) {
    const batch = operations.slice(i, i + BATCH_SIZE);
    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();
      
      for (const op of batch) {
        try {
          await connection.execute(op.sql, op.params);
          batchResults.push({ ...op, success: true });
        } catch (error) {
          if (error.message.includes('Duplicate entry')) {
            batchResults.push({ ...op, success: true, skipped: true });
          } else {
            batchResults.push({ ...op, success: false, error: error.message });
          }
        }
      }
      
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      logger.error(`批量操作事务失败: ${error.message}`);
      for (const op of batch) {
        if (!batchResults.find(r => r.id === op.id)) {
          batchResults.push({ ...op, success: false, error: error.message });
        }
      }
    } finally {
      connection.release();
    }
  }
  
  return batchResults;
}

async function processSyncQueue() {
  if (!mysql.isEnabled()) return;
  
  try {
    const pendingOperations = sqliteDb.prepare(`
      SELECT * FROM sync_queue 
      WHERE retry_count < ? 
      ORDER BY created_at ASC
      LIMIT 100
    `).all(MAX_RETRY_COUNT);
    
    if (pendingOperations.length === 0) return;

    const pool = await mysql.getPool();
    if (!pool) return;
    
    // 转换操作格式
    const operations = pendingOperations.map(op => ({
      id: op.id,
      tableName: op.table_name,
      sql: op.sql,
      params: convertTimestampParams(op.params ? JSON.parse(op.params) : [], op.table_name),
      operationType: op.operation_type,
      retryCount: op.retry_count
    }));
    
    // 批量执行
    const results = await executeBatchOperations(pool, operations);
    
    // 更新同步队列状态
    for (const result of results) {
      if (result.success) {
        sqliteDb.prepare('DELETE FROM sync_queue WHERE id = ?').run(result.id);
        logger.debug(`同步队列操作成功 [${result.tableName}]: ${result.operationType}`);
      } else {
        // 指数退避重试
        const newRetryCount = result.retryCount + 1;
        const delay = getExponentialBackoffDelay(newRetryCount);
        
        sqliteDb.prepare(`
          UPDATE sync_queue 
          SET retry_count = ?, last_retry_at = CURRENT_TIMESTAMP, next_retry_at = datetime('now', '+${Math.floor(delay / 1000)} seconds')
          WHERE id = ?
        `).run(newRetryCount, result.id);
        
        logger.debug(`同步队列操作重试失败 [${result.tableName}]: ${result.error}, 重试次数: ${newRetryCount}, 下次重试: ${delay}ms后`);
        
        if (newRetryCount >= MAX_RETRY_COUNT) {
          logger.error(`同步队列操作达到最大重试次数，已放弃 [${result.tableName}]`);
        }
      }
    }
  } catch (e) {
    logger.error(`处理同步队列失败: ${e.message}`);
  }
}

function startRetryTimer() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = setInterval(processSyncQueue, RETRY_INTERVAL);
  logger.debug('同步队列重试定时器已启动');
  
  mysql.startHealthCheckTimer();
}

function escapeValue(value, convertTimestamp = true) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (convertTimestamp && value > 1000000000000) {
      return "'" + new Date(value).toISOString().slice(0, 19).replace('T', ' ') + "'";
    }
    return value.toString();
  }
  if (value instanceof Date) {
    return "'" + value.toISOString().slice(0, 19).replace('T', ' ') + "'";
  }
  if (typeof value === 'object') {
    return "'" + JSON.stringify(value).replace(/'/g, "''") + "'";
  }
  const strValue = value.toString();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(strValue)) {
    return "'" + strValue.slice(0, 19).replace('T', ' ') + "'";
  }
  return "'" + strValue.replace(/'/g, "''") + "'";
}

function convertTimestampParams(params, tableName = '') {
  const noTimestampTables = ['telemetry_events', 'validation_records', 'ai_analysis_records', 'rule_execution_log'];
  const shouldConvert = !noTimestampTables.includes(tableName);
  
  return params.map(param => {
    if (shouldConvert && typeof param === 'number' && param > 1000000000000) {
      return new Date(param).toISOString().slice(0, 19).replace('T', ' ');
    }
    if (shouldConvert && param instanceof Date) {
      return param.toISOString().slice(0, 19).replace('T', ' ');
    }
    if (shouldConvert && typeof param === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(param)) {
      return param.slice(0, 19).replace('T', ' ');
    }
    // 处理字符串形式的毫秒时间戳（如 '1785130963019.0'）
    // 使用正则表达式确保只匹配纯数字字符串，避免UUID如 '9e4433d2' 被解析为 Infinity
    if (shouldConvert && typeof param === 'string') {
      if (/^-?\d+(\.\d+)?$/.test(param)) {
        const numValue = parseFloat(param);
        if (!isNaN(numValue) && numValue > 1000000000000 && numValue < 9000000000000) {
          return new Date(numValue).toISOString().slice(0, 19).replace('T', ' ');
        }
      }
    }
    return param;
  });
}

function extractTableName(sql) {
  const match = sql.match(/^(INSERT|UPDATE|DELETE)\s+(INTO|FROM)\s+(\w+)/i);
  if (match && match[3]) {
    return match[3];
  }
  return '';
}

function executeMysqlAsync(sql, params, tableName = null) {
  if (!mysql.isEnabled()) return;
  
  setImmediate(async () => {
    try {
      const convertedParams = convertTimestampParams(params, tableName);
      await mysql.execute(sql, convertedParams);
    } catch (error) {
      logger.debug(`MySQL操作失败，加入重试队列: ${error.message}`);
      if (tableName) {
        enqueueSyncOperation(tableName, sql, params, 'execute');
      }
    }
  });
}

function executeMysqlInsertAsync(tableName, rows) {
  if (!mysql.isEnabled() || !Array.isArray(rows) || rows.length === 0) return;
  
  setImmediate(async () => {
    try {
      const columns = Object.keys(rows[0]);
      const placeholders = columns.map((_, i) => `?`).join(', ');
      const sql = `INSERT INTO \`${tableName}\` (\`${columns.join('\`, \`')}\`) VALUES (${placeholders})`;
      
      for (const row of rows) {
        const params = convertTimestampParams(columns.map(col => row[col]), tableName);
        await mysql.execute(sql, params);
      }
    } catch (error) {
      logger.debug(`MySQL批量插入失败，加入重试队列 [${tableName}]: ${error.message}`);
      const columns = Object.keys(rows[0]);
      const placeholders = columns.map((_, i) => `?`).join(', ');
      const sql = `INSERT INTO \`${tableName}\` (\`${columns.join('\`, \`')}\`) VALUES (${placeholders})`;
      
      for (const row of rows) {
        enqueueSyncOperation(tableName, sql, columns.map(col => row[col]), 'insert');
      }
    }
  });
}

function extractTableName(sql) {
  const match = sql.match(/INSERT\s+INTO\s+`?(\w+)`?|UPDATE\s+`?(\w+)`?|DELETE\s+FROM\s+`?(\w+)`?/i);
  return match ? (match[1] || match[2] || match[3]) : null;
}

async function syncTableSchemaFromSqlite(connection, tableName, targetTableName) {
  try {
    const sqlite = getSqliteDatabase();
    const schemaResult = sqlite.prepare(`PRAGMA table_info(${tableName})`).all();
    
    if (!schemaResult || schemaResult.length === 0) {
      throw new Error(`SQLite表 ${tableName} 不存在`);
    }
    
    const columns = schemaResult.map(col => {
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
        mysqlType = `VARCHAR(${col.dflt_value || 255})`;
      }
      
      let constraint = '';
      if (col.notnull === 1 && !mysqlType.includes('PRIMARY KEY')) {
        constraint += ' NOT NULL';
      }
      if (col.dflt_value !== null && col.dflt_value !== undefined) {
        let defaultValue = col.dflt_value;
        if (typeof defaultValue === 'string') {
          if (['CURRENT_TIMESTAMP', 'NULL', 'TRUE', 'FALSE', 'NOW()', 'CURDATE()', 'CURTIME()'].includes(defaultValue.toUpperCase())) {
            defaultValue = defaultValue.toUpperCase();
          } else if (!defaultValue.startsWith("'")) {
            defaultValue = `'${defaultValue}'`;
          }
        }
        constraint += ` DEFAULT ${defaultValue}`;
      }
      if (col.pk === 1 && !mysqlType.includes('PRIMARY KEY')) {
        constraint += ' PRIMARY KEY';
      }
      
      return `\`${col.name}\` ${mysqlType}${constraint}`;
    });
    
    const createSql = `CREATE TABLE \`${targetTableName}\` (${columns.join(', ')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
    await connection.execute(createSql);
    
    logger.info(`从SQLite同步表结构成功 [${tableName}]`);
  } catch (error) {
    logger.error(`从SQLite同步表结构失败 [${tableName}]: ${error.message}`);
    throw error;
  }
}

async function ensureTableColumns(connection, tableName) {
  try {
    const sqlite = getSqliteDatabase();
    const sqliteSchema = sqlite.prepare(`PRAGMA table_info(${tableName})`).all();
    
    if (!sqliteSchema || sqliteSchema.length === 0) {
      return;
    }
    
    const [mysqlColumns] = await connection.execute(`SHOW COLUMNS FROM \`${tableName}\``);
    const mysqlColumnNames = mysqlColumns.map(col => col.Field);
    
    for (const col of sqliteSchema) {
      if (!mysqlColumnNames.includes(col.name)) {
        let mysqlType = col.type.toUpperCase();
        
        if (mysqlType === 'INTEGER') {
          mysqlType = 'INT';
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
          mysqlType = `VARCHAR(${col.dflt_value || 255})`;
        }
        
        let constraint = '';
        if (col.notnull === 1) {
          constraint += ' NOT NULL';
        }
        if (col.dflt_value !== null && col.dflt_value !== undefined) {
          let defaultValue = col.dflt_value;
          if (typeof defaultValue === 'string') {
            if (['CURRENT_TIMESTAMP', 'NULL', 'TRUE', 'FALSE', 'NOW()', 'CURDATE()', 'CURTIME()'].includes(defaultValue.toUpperCase())) {
              defaultValue = defaultValue.toUpperCase();
            } else if (!defaultValue.startsWith("'")) {
              defaultValue = `'${defaultValue}'`;
            }
          }
          constraint += ` DEFAULT ${defaultValue}`;
        }
        
        await connection.execute(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${col.name}\` ${mysqlType}${constraint}`);
        logger.info(`为 ${tableName} 表添加缺失列: ${col.name}`);
      }
    }
  } catch (error) {
    logger.warn(`检查 ${tableName} 表列失败: ${error.message}`);
  }
}

function convertSqlForMysql(sql) {
  return sql
    .replace(/\$(\d+)/g, '?')
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'INT PRIMARY KEY AUTO_INCREMENT')
    .replace(/BOOLEAN/g, 'TINYINT(1)')
    .replace(/REAL/g, 'DECIMAL(10,2)')
    .replace(/TEXT PRIMARY KEY/g, 'VARCHAR(36) PRIMARY KEY');
}

function adaptSqliteResultForMysql(tableName, result, params) {
  const sqlite = getSqliteDatabase();
  let row = null;
  
  if (params && params.length > 0) {
    try {
      row = sqlite.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(params[0]);
    } catch (e) {
      logger.debug(`查询插入行失败: ${e.message}`);
    }
  }
  
  if (!row && result.lastInsertRowid) {
    try {
      row = sqlite.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(result.lastInsertRowid);
    } catch (e) {
      logger.debug(`查询插入行失败(使用lastInsertRowid): ${e.message}`);
    }
  }
  
  if (!row && result.changes > 0) {
    try {
      row = sqlite.prepare(`SELECT * FROM ${tableName} ORDER BY id DESC LIMIT 1`).get();
    } catch (e) {
      logger.debug(`查询最新插入行失败: ${e.message}`);
    }
  }
  
  if (row) {
    executeMysqlInsertAsync(tableName, [row]);
  }
}

class DbAdapter {
  constructor() {
    this._sqlite = getSqliteDatabase();
  }

  getSqlite() {
    return this._sqlite;
  }

  isMysqlEnabled() {
    return mysql.isEnabled();
  }

  getSyncQueueCount() {
    try {
      return this._sqlite.prepare('SELECT COUNT(*) as count FROM sync_queue').get().count;
    } catch (e) {
      return 0;
    }
  }

  pragma(...args) {
    return this._sqlite.pragma(...args);
  }

  exec(sql) {
    return this._sqlite.exec(sql);
  }

  prepare(sql) {
    const stmt = this._sqlite.prepare(sql);
    const tableName = extractTableName(sql);
    
    return {
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
      run: (...args) => {
        const result = stmt.run(...args);
        const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        
        if (mysql.isEnabled() && tableName) {
          const mysqlSql = convertSqlForMysql(sql);
          
          if (sql.toUpperCase().startsWith('INSERT')) {
            adaptSqliteResultForMysql(tableName, result, params);
          } else {
            executeMysqlAsync(mysqlSql, params, tableName);
          }
        }
        
        return result;
      },
      pluck: () => stmt.pluck(),
      expand: () => stmt.expand()
    };
  }

  get(sql, params = []) {
    return this._sqlite.prepare(sql).get(params);
  }

  all(sql, params = []) {
    return this._sqlite.prepare(sql).all(params);
  }

  run(sql, ...args) {
    const tableName = extractTableName(sql);
    const stmt = this._sqlite.prepare(sql);
    const result = stmt.run(...args);
    const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    
    if (mysql.isEnabled() && tableName) {
      const mysqlSql = convertSqlForMysql(sql);
      
      if (sql.toUpperCase().startsWith('INSERT')) {
        adaptSqliteResultForMysql(tableName, result, params);
      } else {
        executeMysqlAsync(mysqlSql, params, tableName);
      }
    }
    
    return result;
  }

  insert(tableName, data) {
    const safeTable = validateIdentifier(tableName);
    const columns = validateIdentifiers(Object.keys(data));
    const placeholders = columns.map(() => `?`).join(', ');
    const values = columns.map(col => data[col]);

    const sql = `INSERT INTO ${safeTable} (${columns.join(', ')}) VALUES (${placeholders})`;
    const result = this._sqlite.prepare(sql).run(values);

    if (mysql.isEnabled()) {
      executeMysqlInsertAsync(safeTable, [data]);
    }

    return result;
  }

  insertMany(tableName, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;

    const safeTable = validateIdentifier(tableName);
    const columns = validateIdentifiers(Object.keys(rows[0]));
    const placeholders = columns.map(() => `?`).join(', ');
    const sql = `INSERT INTO ${safeTable} (${columns.join(', ')}) VALUES (${placeholders})`;
    
    const sqlOperations = [];
    
    const insertManyTx = this._sqlite.transaction((items) => {
      const stmt = this._sqlite.prepare(sql);
      for (const item of items) {
        const params = columns.map(col => item[col]);
        sqlOperations.push({ sql, params: [params] });
        stmt.run(params);
      }
    });
    
    insertManyTx(rows);
    
    if (mysql.isEnabled()) {
      setImmediate(async () => {
        try {
          const pool = await mysql.getPool();
          if (pool) {
            const connection = await pool.getConnection();
            await connection.beginTransaction();
            try {
              for (const op of sqlOperations) {
                const mysqlSql = convertSqlForMysql(op.sql);
                const params = Array.isArray(op.params[0]) ? op.params[0] : [];
                const convertedParams = convertTimestampParams(params, safeTable);
                await connection.execute(mysqlSql, convertedParams);
              }
              await connection.commit();
            } catch (error) {
              await connection.rollback();
              logger.debug(`MySQL批量插入失败: ${error.message}`);
              for (const op of sqlOperations) {
                enqueueSyncOperation(safeTable, convertSqlForMysql(op.sql), Array.isArray(op.params[0]) ? op.params[0] : [], 'insert');
              }
            } finally {
              connection.release();
            }
          }
        } catch (error) {
          logger.warn(`MySQL批量插入初始化失败: ${error.message}`);
          for (const op of sqlOperations) {
            enqueueSyncOperation(safeTable, convertSqlForMysql(op.sql), Array.isArray(op.params[0]) ? op.params[0] : [], 'insert');
          }
        }
      });
    }
  }

  update(tableName, data, where) {
    const safeTable = validateIdentifier(tableName);
    const dataKeys = validateIdentifiers(Object.keys(data));
    const whereKeys = validateIdentifiers(Object.keys(where));
    const setClause = dataKeys.map(key => `${key} = ?`).join(', ');
    const whereClause = whereKeys.map(key => `${key} = ?`).join(' AND ');

    const sql = `UPDATE ${safeTable} SET ${setClause} WHERE ${whereClause}`;
    const values = [...Object.values(data), ...Object.values(where)];

    const result = this._sqlite.prepare(sql).run(values);

    if (mysql.isEnabled()) {
      const mysqlSetClause = dataKeys.map(key => `\`${key}\` = ?`).join(', ');
      const mysqlWhereClause = whereKeys.map(key => `\`${key}\` = ?`).join(' AND ');
      const mysqlSql = `UPDATE \`${safeTable}\` SET ${mysqlSetClause} WHERE ${mysqlWhereClause}`;
      executeMysqlAsync(mysqlSql, [...Object.values(data), ...Object.values(where)]);
    }

    return result;
  }

  delete(tableName, where) {
    const safeTable = validateIdentifier(tableName);
    const whereKeys = validateIdentifiers(Object.keys(where));
    const whereClause = whereKeys.map(key => `${key} = ?`).join(' AND ');
    const sql = `DELETE FROM ${safeTable} WHERE ${whereClause}`;
    const values = Object.values(where);

    const result = this._sqlite.prepare(sql).run(values);

    if (mysql.isEnabled()) {
      const mysqlWhereClause = whereKeys.map(key => `\`${key}\` = ?`).join(' AND ');
      const mysqlSql = `DELETE FROM \`${safeTable}\` WHERE ${mysqlWhereClause}`;
      executeMysqlAsync(mysqlSql, values);
    }

    return result;
  }

  transaction(fn) {
    // 兼容 better-sqlite3 语义：返回可调用函数，调用时才真正执行事务并转发参数
    return (...args) => {
      const sqlOperations = [];
      const originalPrepare = this._sqlite.prepare.bind(this._sqlite);
      let result;

      try {
        this._sqlite.prepare = (sql) => {
          const stmt = originalPrepare(sql);
          const originalRun = stmt.run.bind(stmt);
          stmt.run = (...runArgs) => {
            const tableName = extractTableName(sql);
            sqlOperations.push({ sql, params: runArgs, tableName });
            return originalRun(...runArgs);
          };
          return stmt;
        };

        const tx = this._sqlite.transaction(fn);
        result = tx(...args);
      } finally {
        this._sqlite.prepare = originalPrepare;
      }

      if (mysql.isEnabled() && sqlOperations.length > 0) {
        setImmediate(async () => {
          try {
            const pool = await mysql.getPool();
            if (pool) {
              const connection = await pool.getConnection();
              await connection.beginTransaction();
              try {
                for (const op of sqlOperations) {
                  const mysqlSql = convertSqlForMysql(op.sql);
                  const params = Array.isArray(op.params[0]) ? op.params[0] : [];
                  const convertedParams = convertTimestampParams(params, op.tableName);
                  await connection.execute(mysqlSql, convertedParams);
                }
                await connection.commit();
              } catch (error) {
                await connection.rollback();
                logger.warn(`MySQL事务失败: ${error.message}`);
              } finally {
                connection.release();
              }
            }
          } catch (error) {
            logger.warn(`MySQL事务初始化失败: ${error.message}`);
          }
        });
      }

      return result;
    };
  }

  async syncLocalToRemote(tableName, mode = 'merge') {
    if (!mysql.isEnabled()) {
      logger.warn('MySQL未启用，无法同步');
      return { success: false, message: 'MySQL未启用' };
    }

    try {
      const rows = this._sqlite.prepare(`SELECT * FROM ${tableName}`).all();
      
      if (rows.length === 0) {
        logger.info(`同步 ${tableName}: 0 条记录`);
        return { success: true, count: 0, table: tableName };
      }
      
      const pool = await mysql.getPool();
      if (!pool) {
        return { success: false, message: 'MySQL连接池不可用', table: tableName };
      }

      const connection = await pool.getConnection();

      try {
        // merge/append 模式同样需要结构自愈：云端旧表缺新列时自动 ALTER TABLE ADD COLUMN
        if (mode !== 'overwrite') {
          await ensureTableColumns(connection, tableName);
        }
        await connection.beginTransaction();
        await connection.execute("SET sql_mode = ''");
        
        const columns = Object.keys(rows[0]);
        const noTimestampTables = ['telemetry_events', 'validation_records', 'ai_analysis_records', 'rule_execution_log'];
        const convertTimestamp = !noTimestampTables.includes(tableName);
        const idColumn = columns.includes('id') ? 'id' : columns[0];
        
        let syncedCount = 0;
        let updatedCount = 0;
        let insertedCount = 0;
        
        if (mode === 'overwrite') {
          const tempTable = `${tableName}_sync_temp`;
          const backupTable = `${tableName}_sync_backup`;
          
          await connection.execute(`DROP TABLE IF EXISTS \`${tempTable}\``);
          
          await ensureTableColumns(connection, tableName);
          
          try {
            await syncTableSchemaFromSqlite(connection, tableName, tempTable);
          } catch (schemaError) {
            logger.warn(`从SQLite同步表结构失败，尝试使用LIKE创建 [${tableName}]: ${schemaError.message}`);
            try {
              await connection.execute(`CREATE TABLE \`${tempTable}\` LIKE \`${tableName}\``);
            } catch (createError) {
              throw new Error(`表 ${tableName} 创建失败: ${createError.message}`);
            }
          }
          
          for (let i = 0; i < rows.length; i += 50) {
            const batch = rows.slice(i, i + 50);
            const values = batch.map(row => {
              return '(' + columns.map(col => escapeValue(row[col], convertTimestamp)).join(', ') + ')';
            }).join(',\n');
            await connection.execute(`INSERT INTO \`${tempTable}\` (\`${columns.join('\`, \`')}\`) VALUES ${values}`);
          }
          
          await connection.execute(`RENAME TABLE \`${tableName}\` TO \`${backupTable}\`, \`${tempTable}\` TO \`${tableName}\``);
          await connection.execute(`DROP TABLE IF EXISTS \`${backupTable}\``);

          // 修复 LIKE 创建导致的 AUTO_INCREMENT 丢失
          try {
            const [pkCols] = await connection.query(`
              SELECT COLUMN_NAME, COLUMN_TYPE
              FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_KEY = 'PRI' AND DATA_TYPE = 'int'
            `, [tableName]);
            for (const pk of pkCols) {
              const [check] = await connection.query(`SHOW COLUMNS FROM \`${tableName}\` WHERE Field = ?`, [pk.COLUMN_NAME]);
              if (check[0] && !check[0].Extra?.includes('auto_increment')) {
                await connection.execute(`ALTER TABLE \`${tableName}\` MODIFY \`${pk.COLUMN_NAME}\` ${pk.COLUMN_TYPE} NOT NULL AUTO_INCREMENT`);
                logger.debug(`恢复 AUTO_INCREMENT: ${tableName}.${pk.COLUMN_NAME}`);
              }
            }
          } catch (aiFixError) {
            logger.debug(`恢复 AUTO_INCREMENT 失败 [${tableName}]: ${aiFixError.message}`);
          }

          syncedCount = rows.length;
          
        } else if (mode === 'append') {
          const [existingIds] = await connection.query(`SELECT \`${idColumn}\` FROM \`${tableName}\``);
          const existingIdSet = new Set(existingIds.map(r => r[idColumn]));
          
          for (let i = 0; i < rows.length; i += 50) {
            const batch = rows.slice(i, i + 50).filter(row => !existingIdSet.has(row[idColumn]));
            if (batch.length === 0) continue;
            
            const values = batch.map(row => {
              return '(' + columns.map(col => escapeValue(row[col], convertTimestamp)).join(', ') + ')';
            }).join(',\n');
            await connection.execute(`INSERT INTO \`${tableName}\` (\`${columns.join('\`, \`')}\`) VALUES ${values}`);
            insertedCount += batch.length;
          }
          syncedCount = insertedCount;
          
        } else {
          for (let i = 0; i < rows.length; i += 50) {
            const batch = rows.slice(i, i + 50);
            const values = batch.map(row => {
              return '(' + columns.map(col => escapeValue(row[col], convertTimestamp)).join(', ') + ')';
            }).join(',\n');
            
            const updateColumns = columns.filter(col => col !== idColumn);
            const updateClause = updateColumns.map(col => `\`${col}\` = VALUES(\`${col}\`)`).join(', ');
            
            try {
              await connection.execute(
                `INSERT INTO \`${tableName}\` (\`${columns.join('\`, \`')}\`) VALUES ${values} ON DUPLICATE KEY UPDATE ${updateClause}`
              );
              updatedCount += batch.length;
            } catch (upsertError) {
              await connection.execute(
                `INSERT INTO \`${tableName}\` (\`${columns.join('\`, \`')}\`) VALUES ${values}`
              );
              insertedCount += batch.length;
            }
          }
          syncedCount = updatedCount + insertedCount;
        }
        
        await connection.commit();
        
        logger.info(`同步 ${tableName} [${mode}]: ${syncedCount} 条记录 (更新: ${updatedCount}, 新增: ${insertedCount})`);
        return { 
          success: true, 
          count: syncedCount, 
          table: tableName,
          updated: updatedCount,
          inserted: insertedCount
        };
      } catch (error) {
        await connection.rollback();
        logger.error(`同步 ${tableName} 失败，已回滚: ${error.message}`);
        return { success: false, message: error.message, table: tableName };
      } finally {
        connection.release();
      }
    } catch (error) {
      logger.error(`同步 ${tableName} 失败: ${error.message}`);
      return { success: false, message: error.message, table: tableName };
    }
  }

  async syncAllLocalToRemote(mode = 'merge') {
    if (!mysql.isEnabled()) {
      return { success: false, message: 'MySQL未启用' };
    }

    logger.info(`开始全量同步本地数据到云端 [${mode}]...`);
    
    const tables = [
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

    const results = [];
    let successCount = 0;
    let totalCount = 0;

    for (const table of tables) {
      const result = await this.syncLocalToRemote(table, mode);
      results.push(result);
      if (result.success) {
        successCount++;
        totalCount += result.count || 0;
      }
    }

    logger.info(`全量同步完成: ${successCount}/${tables.length} 张表成功，共 ${totalCount} 条记录`);
    
    const { config } = require('../config');
    config.mysql.lastSyncTime = new Date();
    
    return {
      success: successCount === tables.length,
      message: `同步完成: ${successCount}/${tables.length} 张表成功`,
      totalRecords: totalCount,
      results
    };
  }

  async syncRemoteToLocal(tableName) {
    if (!mysql.isEnabled()) {
      return { success: false, message: 'MySQL未启用', table: tableName };
    }

    try {
      const pool = await mysql.getPool();
      if (!pool) {
        return { success: false, message: 'MySQL连接池不可用', table: tableName };
      }

      const connection = await pool.getConnection();

      try {
        await this.syncMysqlSchemaToSqlite(connection, tableName);
        
        const [rows, fields] = await connection.query(`SELECT * FROM \`${tableName}\``);
        
        if (rows.length === 0) {
          logger.info(`同步 ${tableName}: 0 条记录（云端为空）`);
          connection.release();
          return { success: true, count: 0, table: tableName };
        }
        
        const sqlite = getSqliteDatabase();
        
        const sqliteColumns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all().map(col => col.name);
        
        let mysqlColumns = [];
        if (fields && fields.length > 0) {
          mysqlColumns = fields.map(field => field.name);
        } else if (typeof rows[0] === 'object' && !Array.isArray(rows[0])) {
          mysqlColumns = Object.keys(rows[0]);
        }
        
        if (mysqlColumns.length === 0) {
          logger.warn(`同步 ${tableName}: 无法获取MySQL列名`);
          connection.release();
          return { success: true, count: 0, table: tableName };
        }
        
        let commonColumns = mysqlColumns.filter(col => sqliteColumns.includes(col));
        
        if (commonColumns.length === 0) {
          logger.warn(`同步 ${tableName}: MySQL列 [${mysqlColumns.slice(0, 5).join(', ')}...] vs SQLite列 [${sqliteColumns.slice(0, 5).join(', ')}...]`);
          const lowerSqlite = sqliteColumns.map(c => c.toLowerCase());
          commonColumns = mysqlColumns.filter(col => lowerSqlite.includes(col.toLowerCase()));
          if (commonColumns.length === 0) {
            logger.warn(`同步 ${tableName}: 没有匹配的列，跳过`);
            connection.release();
            return { success: true, count: 0, table: tableName };
          }
          logger.info(`同步 ${tableName}: 大小写不敏感匹配成功，使用列 [${commonColumns.slice(0, 5).join(', ')}...]`);
        }
        
        sqlite.prepare(`DELETE FROM ${tableName}`).run();
        
        const noTimestampTables = ['telemetry_events', 'validation_records', 'ai_analysis_records', 'rule_execution_log'];
        const convertTimestamp = !noTimestampTables.includes(tableName);
        
        const sqliteSchema = sqlite.prepare(`PRAGMA table_info(${tableName})`).all();
        const notNullDateColumns = new Set();
        for (const col of sqliteSchema) {
          if (col.notnull === 1 && (col.type.toUpperCase() === 'TEXT' || col.type.toUpperCase() === 'DATETIME')) {
            notNullDateColumns.add(col.name);
          }
        }
        
        const insertSql = `INSERT INTO ${tableName} (${commonColumns.join(', ')}) VALUES (${commonColumns.map(() => '?').join(', ')})`;
        const insertStmt = sqlite.prepare(insertSql);
        
        sqlite.exec('BEGIN TRANSACTION');
        try {
          for (const row of rows) {
            const values = commonColumns.map((col, index) => {
              let val;
              if (typeof row === 'object' && !Array.isArray(row)) {
                val = row[col];
              } else {
                val = row[index];
              }
              if (val === null || val === undefined) {
                if (notNullDateColumns.has(col)) {
                  return '1970-01-01 00:00:00';
                }
                return null;
              }
              if (typeof val === 'bigint') {
                return Number(val);
              }
              if (Buffer.isBuffer(val)) {
                return val.toString('base64');
              }
              if (typeof val === 'object' && val !== null) {
                if (val instanceof Date) {
                  if (isNaN(val.getTime())) {
                    if (notNullDateColumns.has(col)) {
                      return '1970-01-01 00:00:00';
                    }
                    return null;
                  }
                  return val.toISOString().replace('T', ' ').replace('.000Z', '');
                }
                if (typeof val.toNumber === 'function') {
                  return val.toNumber();
                }
                if (typeof val.toString === 'function') {
                  const str = val.toString();
                  if (!isNaN(str) && str !== '') {
                    return Number(str);
                  }
                  return str;
                }
                try {
                  return JSON.stringify(val);
                } catch (e) {
                  return String(val);
                }
              }
              if (typeof val === 'string') {
                if (/^0000-00-00/.test(val)) {
                  if (notNullDateColumns.has(col)) {
                    return '1970-01-01 00:00:00';
                  }
                  return null;
                }
                if (val.trim() === '') {
                  if (notNullDateColumns.has(col)) {
                    return '1970-01-01 00:00:00';
                  }
                  return null;
                }
                if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(val)) {
                  return val;
                }
                if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
                  return val.replace('T', ' ').replace('.000Z', '').replace('Z', '');
                }
              }
              return val;
            });
            insertStmt.run(values);
          }
          sqlite.exec('COMMIT');
        } catch (e) {
          sqlite.exec('ROLLBACK');
          logger.error(`同步 ${tableName} 失败，最后一行数据: ${JSON.stringify(row)}`);
          throw e;
        }
        
        logger.info(`同步 ${tableName}: ${rows.length} 条记录`);
        return { success: true, count: rows.length, table: tableName };
      } catch (error) {
        logger.error(`同步 ${tableName} 失败: ${error.message}`);
        return { success: false, message: error.message, table: tableName };
      } finally {
        connection.release();
      }
    } catch (error) {
      logger.error(`同步 ${tableName} 失败: ${error.message}`);
      return { success: false, message: error.message, table: tableName };
    }
  }

  async syncAllRemoteToLocal() {
    if (!mysql.isEnabled()) {
      return { success: false, message: 'MySQL未启用' };
    }

    logger.info('开始全量同步云端数据到本地...');
    
    const tables = [
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
    
    const results = [];
    let successCount = 0;
    let totalCount = 0;
    
    for (const table of tables) {
      const result = await this.syncRemoteToLocal(table);
      results.push(result);
      if (result.success) {
        successCount++;
        totalCount += result.count || 0;
      }
    }

    logger.info(`全量同步完成: ${successCount}/${tables.length} 张表成功，共 ${totalCount} 条记录`);
    
    const { config } = require('../config');
    config.mysql.lastSyncTime = new Date();
    
    return {
      success: successCount === tables.length,
      message: `同步完成: ${successCount}/${tables.length} 张表成功，共 ${totalCount} 条记录`,
      totalRecords: totalCount,
      results
    };
  }

  async syncMysqlSchemaToSqlite(connection, tableName) {
    try {
      const sqlite = getSqliteDatabase();
      
      const [mysqlColumns] = await connection.query(`SHOW COLUMNS FROM \`${tableName}\``);
      const sqliteSchema = sqlite.prepare(`PRAGMA table_info(${tableName})`).all();
      const sqliteColumnNames = sqliteSchema.map(col => col.name);
      
      let hasChanges = false;
      
      const mysqlIdCol = mysqlColumns.find(col => col.Key === 'PRI');
      const sqliteIdCol = sqliteSchema.find(col => col.pk === 1);
      
      let needRebuild = false;
      if (mysqlIdCol && sqliteIdCol) {
        const mysqlIdType = mysqlIdCol.Type.toLowerCase();
        const sqliteIdType = sqliteIdCol.type.toUpperCase();
        
        if (mysqlIdType.includes('varchar') && sqliteIdType === 'INTEGER') {
          needRebuild = true;
        }
      }
      
      if (needRebuild) {
        logger.info(`SQLite表 ${tableName} 主键类型不匹配，需要重建`);
        
        const tempData = sqlite.prepare(`SELECT * FROM ${tableName}`).all();
        
        sqlite.exec(`DROP TABLE IF EXISTS ${tableName}`);
        
        let createSql = `CREATE TABLE ${tableName} (`;
        const colDefs = [];
        
        for (const mysqlCol of mysqlColumns) {
          const colName = mysqlCol.Field;
          let sqliteType = 'TEXT';
          const mysqlType = mysqlCol.Type.toLowerCase();
          
          if (mysqlType.includes('int')) {
            sqliteType = mysqlType.includes('bigint') ? 'INTEGER' : 'INTEGER';
          } else if (mysqlType.includes('decimal') || mysqlType.includes('float') || mysqlType.includes('double')) {
            sqliteType = 'REAL';
          } else if (mysqlType.includes('datetime') || mysqlType.includes('timestamp')) {
            sqliteType = 'TEXT';
          } else if (mysqlType.includes('text')) {
            sqliteType = 'TEXT';
          } else if (mysqlType.includes('varchar')) {
            sqliteType = 'TEXT';
          } else if (mysqlType.includes('boolean') || mysqlType.includes('tinyint(1)')) {
            sqliteType = 'INTEGER';
          } else if (mysqlType.includes('blob')) {
            sqliteType = 'BLOB';
          }
          
          let constraint = '';
          if (mysqlCol.Key === 'PRI') {
            constraint += ' PRIMARY KEY';
          }
          if (mysqlCol.Null === 'NO') {
            constraint += ' NOT NULL';
          }
          if (mysqlCol.Default !== null && mysqlCol.Default !== undefined) {
            let defaultValue = mysqlCol.Default;
            if (typeof defaultValue === 'string') {
              if (!defaultValue.startsWith("'") && !['CURRENT_TIMESTAMP', 'NULL', '0', '1'].includes(defaultValue)) {
                defaultValue = `'${defaultValue}'`;
              }
            }
            constraint += ` DEFAULT ${defaultValue}`;
          }
          
          colDefs.push(`${colName} ${sqliteType}${constraint}`);
        }
        
        createSql += colDefs.join(', ') + ')';
        sqlite.exec(createSql);
        
        logger.info(`SQLite表 ${tableName} 重建完成`);
        return;
      }
      
      for (const mysqlCol of mysqlColumns) {
        const colName = mysqlCol.Field;
        if (!sqliteColumnNames.includes(colName)) {
          let sqliteType = 'TEXT';
          const mysqlType = mysqlCol.Type.toLowerCase();
          
          if (mysqlType.includes('int')) {
            sqliteType = mysqlType.includes('bigint') ? 'INTEGER' : 'INTEGER';
          } else if (mysqlType.includes('decimal') || mysqlType.includes('float') || mysqlType.includes('double')) {
            sqliteType = 'REAL';
          } else if (mysqlType.includes('datetime') || mysqlType.includes('timestamp')) {
            sqliteType = 'TEXT';
          } else if (mysqlType.includes('text')) {
            sqliteType = 'TEXT';
          } else if (mysqlType.includes('varchar')) {
            sqliteType = 'TEXT';
          } else if (mysqlType.includes('boolean') || mysqlType.includes('tinyint(1)')) {
            sqliteType = 'INTEGER';
          } else if (mysqlType.includes('blob')) {
            sqliteType = 'BLOB';
          }
          
          let constraint = '';
          if (mysqlCol.Null === 'NO') {
            constraint += ' NOT NULL';
          }
          if (mysqlCol.Default !== null && mysqlCol.Default !== undefined) {
            let defaultValue = mysqlCol.Default;
            if (typeof defaultValue === 'string') {
              if (!defaultValue.startsWith("'") && !['CURRENT_TIMESTAMP', 'NULL', '0', '1'].includes(defaultValue)) {
                defaultValue = `'${defaultValue}'`;
              }
            }
            constraint += ` DEFAULT ${defaultValue}`;
          }
          
          try {
            sqlite.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${sqliteType}${constraint}`);
            logger.debug(`SQLite表 ${tableName} 添加缺失字段: ${colName}`);
            hasChanges = true;
          } catch (e) {
            logger.debug(`SQLite表 ${tableName} 添加字段 ${colName} 失败: ${e.message}`);
          }
        }
      }
      
      if (hasChanges) {
        logger.info(`SQLite表 ${tableName} 结构同步完成`);
      }
    } catch (error) {
      logger.debug(`同步MySQL表结构到SQLite失败 [${tableName}]: ${error.message}`);
    }
  }

  close() {
    if (sqliteDb) {
      sqliteDb.close();
      sqliteDb = null;
    }
  }
}

const dbAdapter = new DbAdapter();

module.exports = { dbAdapter };