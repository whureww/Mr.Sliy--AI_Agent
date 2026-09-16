/**
 * 工具处理器（从 agent.js 的 executeTool 解耦提取）
 * 每个 handler 是一个 async (params) => result 函数，通过 createToolHandlers(agent) 注入 agent 实例。
 * agent 提供：analyzeFile / analyzeProject / optimize / searchKnowledge / getStatus /
 *   getProviders / switchProvider / clearChatHistory / getSkills / enableSandbox /
 *   disableSandbox / hotReloadService
 */

const fs = require('fs');
const path = require('path');
const { safeResolvePath } = require('../utils/securityGuard');
const { readTextFile, encodeText } = require('../utils/encoding');
const { getFileLanguage } = require('../utils/helpers');
const { providerManager } = require('../services/llm/providers');
const { selfUpdateManager } = require('../services/bootstrap/selfUpdateManager');
const { selfRepairManager } = require('../services/bootstrap/selfRepairManager');
const { rollbackManager } = require('../services/bootstrap/rollback');
const { sandboxManager } = require('../sandbox/sandboxManager');

/**
 * 异步存在性检查
 */
async function fileExists(p) {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

/**
 * 创建工具处理器映射
 * @param {object} agent - CodeOptimizerAgent 实例
 * @returns {Object<string, function>} toolName -> async handler(params)
 */
function createToolHandlers(agent) {
  return {
    async analyze_file(p) {
      const filePath = p.filePath || p.path;
      if (!filePath || typeof filePath !== 'string') {
        return { success: false, message: '文件路径不能为空' };
      }
      // 安全路径解析：防路径遍历与敏感文件读取
      const pathCheck = safeResolvePath(filePath);
      if (!pathCheck.safe) {
        return { success: false, message: pathCheck.error };
      }
      const resolvedPath = pathCheck.resolvedPath;

      if (!await fileExists(resolvedPath)) {
        const altPath = resolvedPath + '.java';
        // 后备路径同样需要安全校验
        const altCheck = safeResolvePath(altPath);
        if (altCheck.safe && await fileExists(altCheck.resolvedPath)) {
          return await agent.analyzeFile(altCheck.resolvedPath);
        }
        const dirPath = path.dirname(resolvedPath);
        const fileName = path.basename(resolvedPath);
        const dirCheck = safeResolvePath(dirPath);
        if (!dirCheck.safe || !await fileExists(dirCheck.resolvedPath)) {
          return { success: false, message: `文件不存在: ${resolvedPath}` };
        }
        try {
          const files = (await fs.promises.readdir(dirCheck.resolvedPath)).filter(f =>
            f.toLowerCase().includes(fileName.toLowerCase().replace('.java', ''))
          );
          if (files.length > 0) {
            const matchedPath = path.join(dirCheck.resolvedPath, files[0]);
            const matchedCheck = safeResolvePath(matchedPath);
            if (matchedCheck.safe && await fileExists(matchedCheck.resolvedPath)) {
              return await agent.analyzeFile(matchedCheck.resolvedPath);
            }
          }
        } catch (e) {
          return { success: false, message: `目录读取失败: ${e.message}` };
        }
        return { success: false, message: `文件不存在: ${resolvedPath}` };
      }
      return await agent.analyzeFile(resolvedPath);
    },

    async scan_project(p) {
      const projectPath = p.projectPath || p.path || p.dir;
      if (!projectPath || typeof projectPath !== 'string') {
        return { success: false, message: '项目路径不能为空' };
      }
      // 安全路径解析：防路径遍历
      const pathCheck = safeResolvePath(projectPath);
      if (!pathCheck.safe) {
        return { success: false, message: pathCheck.error };
      }
      const resolvedPath = pathCheck.resolvedPath;

      // 异步存在性检查
      try {
        await fs.promises.access(resolvedPath);
      } catch {
        return { success: false, message: `项目路径不存在: ${resolvedPath}` };
      }
      return await agent.analyzeProject(resolvedPath, {
        maxFiles: p.maxFiles || p.limit || 100
      });
    },

    async optimize_code(p) {
      if (!p.code || typeof p.code !== 'string') {
        return { success: false, message: '代码内容不能为空' };
      }
      return await agent.optimize(p.code, p.language || 'javascript');
    },

    async search_knowledge(p) {
      if (!p.query || typeof p.query !== 'string') {
        return { success: false, message: '搜索关键词不能为空' };
      }
      return await agent.searchKnowledge(p.query, {
        limit: p.limit || 10
      });
    },

    get_status() {
      return agent.getStatus();
    },

    get_providers() {
      return { providers: agent.getProviders() };
    },

    async switch_provider(p) {
      const providerName = p.providerName || p.name;
      if (!providerName) {
        return { success: false, message: '提供商名称不能为空' };
      }
      return await agent.switchProvider(providerName);
    },

    clear_history() {
      agent.clearChatHistory();
      return { success: true, message: '聊天历史已清空' };
    },

    get_skills() {
      return { skills: agent.getSkills() };
    },

    async fix_file(p) {
      const filePath = p.filePath || p.path;
      if (!filePath || typeof filePath !== 'string') {
        return { success: false, message: '文件路径不能为空' };
      }

      // 安全路径解析：写操作同样需要防路径遍历
      const pathCheck = safeResolvePath(filePath);
      if (!pathCheck.safe) {
        return { success: false, message: pathCheck.error };
      }
      const resolvedPath = pathCheck.resolvedPath;
      // 编码自动检测读取；备份与写回沿用原编码，避免非 UTF-8 文件被转码破坏
      let originalCode;
      let fileEncoding;
      try {
        ({ text: originalCode, encoding: fileEncoding } = await readTextFile(resolvedPath));
      } catch (e) {
        if (e.code === 'ENOENT') {
          return { success: false, message: `文件不存在: ${resolvedPath}` };
        }
        return { success: false, message: `读取文件失败: ${e.message}` };
      }
      const language = getFileLanguage(resolvedPath);

      const analyzeResult = await agent.analyzeFile(resolvedPath);
      if (!analyzeResult.success) {
        return analyzeResult;
      }

      if (analyzeResult.issues && analyzeResult.issues.length === 0) {
        return { success: true, message: '文件没有发现问题，无需修复', filePath: resolvedPath };
      }

      const provider = providerManager.getActiveProvider();
      if (!provider) {
        return { success: false, message: '未配置活跃的LLM提供商' };
      }

      const optimizePrompt = `请根据以下问题列表，对代码进行修复和优化。直接返回优化后的完整代码，不要返回任何解释或建议。

文件路径: ${resolvedPath}
语言: ${language}

原始代码:
\`\`\`${language}
${originalCode}
\`\`\`

发现的问题:
${JSON.stringify(analyzeResult.issues, null, 2)}

要求:
1. 直接修复所有问题
2. 保持代码结构和功能不变
3. 只返回优化后的完整代码，不要任何解释`;

      const optimizeResult = await provider.chat([
        { role: 'user', content: optimizePrompt }
      ]);

      const optimizedCode = optimizeResult.content
        .replace(/\`\`\`[a-z]*\n?/gi, '')
        .replace(/\`\`\`/g, '')
        .trim();

      const createBackup = p.createBackup !== false;
      if (createBackup) {
        const backupPath = resolvedPath + '.bak';
        await fs.promises.writeFile(backupPath, encodeText(originalCode, fileEncoding));
      }

      await fs.promises.writeFile(resolvedPath, encodeText(optimizedCode, fileEncoding));

      return {
        success: true,
        message: '文件已修复并保存',
        filePath: resolvedPath,
        encoding: fileEncoding,
        issuesFixed: analyzeResult.issues.length,
        issues: analyzeResult.issues,
        backupCreated: createBackup
      };
    },

    async apply_fix(p) {
      const filePath = p.filePath || p.path;
      const optimizedCode = p.optimizedCode || p.code;

      if (!filePath || typeof filePath !== 'string') {
        return { success: false, message: '文件路径不能为空' };
      }
      if (!optimizedCode || typeof optimizedCode !== 'string') {
        return { success: false, message: '优化后的代码不能为空' };
      }

      // 安全路径解析：写操作同样需要防路径遍历
      const pathCheck = safeResolvePath(filePath);
      if (!pathCheck.safe) {
        return { success: false, message: pathCheck.error };
      }
      const resolvedPath = pathCheck.resolvedPath;
      // 编码自动检测读取；备份与写回沿用原编码，避免非 UTF-8 文件被转码破坏
      let originalCode;
      let fileEncoding;
      try {
        ({ text: originalCode, encoding: fileEncoding } = await readTextFile(resolvedPath));
      } catch (e) {
        if (e.code === 'ENOENT') {
          return { success: false, message: `文件不存在: ${resolvedPath}` };
        }
        return { success: false, message: `读取文件失败: ${e.message}` };
      }
      const createBackup = p.createBackup !== false;

      if (createBackup) {
        const backupPath = resolvedPath + '.bak';
        await fs.promises.writeFile(backupPath, encodeText(originalCode, fileEncoding));
      }

      await fs.promises.writeFile(resolvedPath, encodeText(optimizedCode, fileEncoding));

      return {
        success: true,
        message: '代码已应用到文件',
        filePath: resolvedPath,
        encoding: fileEncoding,
        backupCreated: createBackup,
        backupPath: createBackup ? resolvedPath + '.bak' : null
      };
    },

    async self_update(p) {
      const updateType = p.updateType;
      const content = p.content;
      const autoConfirm = p.autoConfirm || false;

      if (!updateType) {
        return { success: false, message: '更新类型不能为空' };
      }
      if (!content) {
        return { success: false, message: '更新内容不能为空' };
      }

      const createResult = await selfUpdateManager.createUpdate(updateType, content, {
        description: p.description
      });

      if (!createResult.success) {
        return createResult;
      }

      return await selfUpdateManager.executeUpdate(createResult.updateId, { autoConfirm });
    },

    async update_from_ai(p) {
      const suggestion = p.suggestion;
      const autoConfirm = p.autoConfirm || false;
      const onProgress = p.onProgress;

      if (!suggestion) {
        return { success: false, message: '更新建议不能为空' };
      }

      return await selfUpdateManager.updateFromAISuggestion(suggestion, { autoConfirm, onProgress });
    },

    async list_updates(p) {
      const updates = await selfUpdateManager.listUpdates(p.status, p.limit || 20);
      return { success: true, updates };
    },

    async list_bootstrap_history(p) {
      const [updates, repairs] = await Promise.all([
        selfUpdateManager.listUpdates(p.status, p.limit || 20),
        selfRepairManager.listRepairs(null, p.status, p.limit || 20)
      ]);

      let allRecords = [...updates, ...repairs];

      if (p.type) {
        allRecords = allRecords.filter(r => r.type === p.type);
      }

      allRecords.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return { success: true, records: allRecords.slice(0, p.limit || 20) };
    },

    async rollback_update(p) {
      const updateId = p.updateId;

      if (!updateId) {
        return { success: false, message: '更新ID不能为空' };
      }

      return await rollbackManager.rollbackUpdate(updateId);
    },

    async self_repair(p) {
      const errorType = p.errorType;
      const errorMessage = p.errorMessage;
      const autoConfirm = p.autoConfirm || false;

      if (!errorType) {
        return { success: false, message: '错误类型不能为空' };
      }
      if (!errorMessage) {
        return { success: false, message: '错误信息不能为空' };
      }

      const error = new Error(errorMessage);
      error.code = errorType.toUpperCase();

      return await selfRepairManager.detectAndRepair(error, { autoConfirm });
    },

    async repair_from_ai(p) {
      const errorMessage = p.errorMessage;
      const errorStack = p.errorStack || '';
      const autoConfirm = p.autoConfirm || false;

      if (!errorMessage) {
        return { success: false, message: '错误信息不能为空' };
      }

      const error = new Error(errorMessage);
      error.stack = errorStack;

      return await selfRepairManager.repairFromAI(error, { autoConfirm });
    },

    async list_repairs(p) {
      const repairs = await selfRepairManager.listRepairs(p.errorType, p.status, p.limit || 20);
      return { success: true, repairs };
    },

    async create_backup(p) {
      const backupType = p.backupType;

      if (!backupType) {
        return { success: false, message: '备份类型不能为空' };
      }

      if (backupType === 'system') {
        return await rollbackManager.createFullSystemBackup({
          onProgress: p.onProgress,
          requestPermission: p.requestPermission
        });
      }

      return await rollbackManager.createBackup(backupType, process.cwd(), {
        description: p.description,
        onProgress: p.onProgress,
        requestPermission: p.requestPermission
      });
    },

    async list_backups(p) {
      const backups = await rollbackManager.listBackups(p.backupType, p.limit || 20);
      return { success: true, backups };
    },

    async sandbox_status(p) {
      const serviceName = p.serviceName || p.name;
      if (serviceName) {
        const status = sandboxManager.getServiceStatus(serviceName);
        if (!status) {
          return { success: false, message: `服务 ${serviceName} 不存在` };
        }
        return { success: true, service: status };
      }
      return { success: true, status: sandboxManager.getStatus() };
    },

    async sandbox_enable() {
      return await agent.enableSandbox();
    },

    async sandbox_disable() {
      return await agent.disableSandbox();
    },

    async sandbox_reload_service(p) {
      const serviceName = p.serviceName || p.name;
      const newVersion = p.newVersion || p.version;

      if (!serviceName) {
        return { success: false, message: '服务名称不能为空' };
      }

      return await agent.hotReloadService(serviceName, newVersion);
    }
  };
}

module.exports = { createToolHandlers };
