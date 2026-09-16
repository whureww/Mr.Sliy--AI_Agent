/**
 * 双模工作引擎
 * 核心特色：离线AST + 本地RAG知识库 / 在线AST + 云端大模型
 * 自适应切换，AI为扩展功能，不依赖核心检测业务
 */

const { detectIssues, batchDetect } = require('../services/detection/detector');
const { knowledgeBase } = require('../services/vector/knowledgeBase');
const { providerManager } = require('../services/llm/providers');
const { logger } = require('../utils/logger');
const { generateUUID, getFileLanguage } = require('../utils/helpers');
const { isOnlineMode, checkNetworkConnectivity, getNetworkStatus } = require('../config');
const { readTextFile } = require('../utils/encoding');
const { ProgressBar } = require('../utils/progress');
const { runWithConcurrency } = require('../utils/taskQueue');
const fs = require('fs');
const path = require('path');

/**
 * 双模引擎类
 */
class DualModeEngine {
  constructor() {
    this.mode = 'auto'; // 'offline', 'online', 'auto'
    this.initialized = false;
  }

  /**
   * 初始化引擎
   */
  async init() {
    if (this.initialized) return;
    
    await knowledgeBase.init();
    knowledgeBase.seedDefaultKnowledge();
    
    try {
      await providerManager.refreshProviderStatus();
      logger.info('提供商状态刷新完成');
    } catch (e) {
      logger.debug('刷新提供商状态失败: ' + e.message);
    }
    
    // 启动时自动初始化 MySQL 连接（从保存的配置加载）
    try {
      const mysql = require('../utils/mysql');
      const config = require('../config');
      
      if (config.mysql.enabled && config.mysql.host) {
        await mysql.initDatabase();
        await mysql.checkConnectionHealth();
        logger.info('MySQL数据库自动初始化完成');
      }
    } catch (e) {
      logger.debug('MySQL自动初始化失败: ' + e.message);
    }
    
    if (this.mode === 'auto') {
      try {
        const isConnected = await checkNetworkConnectivity();
        logger.info(`网络连接状态: ${isConnected ? '已连接' : '未连接'}`);
      } catch (e) {
        logger.debug('网络检测失败: ' + e.message);
      }
    } else {
      try {
        await checkNetworkConnectivity();
      } catch (e) {
        logger.debug('网络检测失败: ' + e.message);
      }
    }
    
    this.initialized = true;
    logger.info('双模引擎初始化完成');
  }

  /**
   * 设置工作模式
   */
  setMode(mode) {
    const validModes = ['offline', 'online', 'auto'];
    if (!validModes.includes(mode)) {
      throw new Error(`无效模式: ${mode}，可选: ${validModes.join(', ')}`);
    }
    this.mode = mode;
    logger.info(`工作模式切换为: ${mode}`);
  }

  /**
   * 获取当前实际工作模式（同步，使用缓存的网络状态）
   */
  getActualMode() {
    if (this.mode === 'auto') {
      const networkStatus = getNetworkStatus();
      
      if (networkStatus.connected === null) {
        return 'offline';
      }
      
      if (networkStatus.connected === false) {
        return 'offline';
      }
      
      const availableProviders = providerManager.getAvailableProviders();
      const hasOnlineProvider = availableProviders.some(p => p.available && p.name !== 'ollama');
      
      if (!hasOnlineProvider) {
        return 'offline';
      }
      
      return 'online';
    }
    return this.mode;
  }

  async refreshNetworkStatus() {
    try {
      await checkNetworkConnectivity();
    } catch (e) {
      logger.debug('刷新网络状态失败: ' + e.message);
    }
  }

  async refreshProviderStatus() {
    try {
      await providerManager.refreshProviderStatus();
    } catch (e) {
      logger.debug('刷新提供商状态失败: ' + e.message);
    }
  }

  /**
   * 获取当前实际工作模式（异步，强制检测网络）
   */
  async getActualModeAsync() {
    if (this.mode !== 'auto') {
      return this.mode;
    }
    
    const availableProviders = providerManager.getAvailableProviders();
    const hasOnlineProvider = availableProviders.some(p => p.available && p.name !== 'ollama');
    
    if (!hasOnlineProvider) {
      logger.debug('自动模式: 无可用云端提供商，切换为离线模式');
      return 'offline';
    }
    
    const isConnected = await checkNetworkConnectivity();
    
    if (isConnected) {
      logger.debug('自动模式: 网络连接正常，使用在线模式');
      return 'online';
    } else {
      logger.debug('自动模式: 网络不可用，切换为离线模式');
      return 'offline';
    }
  }

  /**
   * 检测并优化单个文件（双模入口）
   */
  async analyzeFile(filePath, options = {}) {
    await this.init();
    const startTime = Date.now();
    const actualMode = this.mode === 'auto' ? await this.getActualModeAsync() : this.getActualMode();
    const onProgress = options.onProgress;

    logger.info(`开始分析文件: ${filePath} [模式: ${actualMode}]`);

    try {
      if (onProgress) onProgress({ phase: 'reading', status: '读取文件', filePath });
      await this._delay(150);

      // 编码自动检测读取（UTF-8/GBK/Big5/Shift_JIS 等），不再假设 UTF-8
      const { text: sourceCode } = await readTextFile(filePath);
      const language = getFileLanguage(filePath);

      if (onProgress) onProgress({ phase: 'parsing', status: `解析语法树 (${language})`, filePath, language });
      await this._delay(200);

      const detectionResult = await detectIssues(sourceCode, filePath);

      if (!detectionResult.success) {
        return {
          success: false,
          message: detectionResult.message,
          filePath,
          mode: actualMode
        };
      }

      const totalIssues = detectionResult.totalIssues;
      if (onProgress) onProgress({
        phase: 'optimizing',
        status: `优化 ${totalIssues} 个问题`,
        filePath,
        totalIssues,
        current: 0
      });
      await this._delay(100);

      const optimizedIssues = [];

      for (let i = 0; i < detectionResult.issues.length; i++) {
        const issue = detectionResult.issues[i];
        if (onProgress) onProgress({
          phase: 'optimizing',
          status: `优化: ${issue.message.substring(0, 20)}`,
          filePath,
          totalIssues,
          current: i + 1
        });
        await this._delay(80);
        const optimization = await this.optimizeIssue(issue, sourceCode, actualMode);
        optimizedIssues.push({
          ...issue,
          optimization
        });
      }

      if (onProgress) onProgress({ phase: 'done', status: '分析完成', filePath, totalIssues });
      await this._delay(200);

      const result = {
        success: true,
        filePath,
        language,
        mode: actualMode,
        totalIssues: detectionResult.totalIssues,
        issueCounts: detectionResult.issueCounts,
        issues: optimizedIssues,
        durationMs: Date.now() - startTime
      };

      logger.info(`文件分析完成: ${filePath}, 发现 ${detectionResult.totalIssues} 个问题`);
      return result;

    } catch (error) {
      logger.error(`分析文件失败: ${filePath}`, error);
      return {
        success: false,
        message: error.message,
        filePath,
        mode: actualMode
      };
    }
  }

  /**
   * 延迟函数，用于让进度条可见
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 分析代码片段（用于交互式使用）
   */
  async analyzeSnippet(codeSnippet, language = 'javascript', options = {}) {
    await this.init();
    const startTime = Date.now();
    const actualMode = this.mode === 'auto' ? await this.getActualModeAsync() : this.getActualMode();
    const onProgress = options.onProgress;

    logger.info(`开始分析代码片段 [模式: ${actualMode}]`);

    try {
      if (onProgress) onProgress({ phase: 'parsing', status: '解析代码语法树' });
      await this._delay(200);

      const detectionResult = await detectIssues(codeSnippet, `snippet.${language === 'javascript' ? 'js' : language}`);

      const totalIssues = detectionResult.issues.length;
      if (onProgress) onProgress({ phase: 'optimizing', status: `优化 ${totalIssues} 个问题`, totalIssues, current: 0 });
      await this._delay(100);

      const optimizedIssues = [];

      for (let i = 0; i < detectionResult.issues.length; i++) {
        const issue = detectionResult.issues[i];
        if (onProgress) onProgress({
          phase: 'optimizing',
          status: `优化: ${issue.message.substring(0, 20)}`,
          totalIssues,
          current: i + 1
        });
        await this._delay(80);

        const optimization = await this.optimizeIssue(issue, codeSnippet, actualMode);
        optimizedIssues.push({
          ...issue,
          optimization
        });
      }

      if (detectionResult.issues.length === 0 && options.generalOptimize) {
        if (onProgress) onProgress({ phase: 'general_optimize', status: '生成一般性优化建议' });
        await this._delay(150);

        const generalOptimization = await this.optimizeIssue(
          { codeSnippet, issueType: 'general', message: '一般性优化' },
          codeSnippet,
          actualMode
        );
        optimizedIssues.push({
          id: generateUUID(),
          issueType: 'general_optimization',
          severity: 'low',
          message: '建议进行一般性代码优化',
          codeSnippet,
          optimization: generalOptimization
        });
      }

      if (onProgress) onProgress({ phase: 'done', status: '优化完成' });
      await this._delay(200);

      return {
        success: true,
        mode: actualMode,
        totalIssues: optimizedIssues.length,
        issues: optimizedIssues,
        durationMs: Date.now() - startTime
      };

    } catch (error) {
      logger.error('分析代码片段失败:', error);
      return {
        success: false,
        message: error.message,
        mode: actualMode
      };
    }
  }

  /**
   * 批量分析项目
   */
  async analyzeProject(projectPath, options = {}) {
    await this.init();
    const startTime = Date.now();
    const actualMode = this.mode === 'auto' ? await this.getActualModeAsync() : this.getActualMode();
    const onProgress = options.onProgress;
    
    logger.info(`开始分析项目: ${projectPath} [模式: ${actualMode}]`);

    if (onProgress) onProgress({ phase: 'collecting', status: '收集项目文件', projectPath });

    const files = await this.collectProjectFiles(projectPath, options.extensions);
    
    if (files.length === 0) {
      if (onProgress) onProgress({ phase: 'done', status: '未找到可分析文件', totalFiles: 0 });
      return {
        success: true,
        projectPath,
        mode: actualMode,
        totalFiles: 0,
        totalIssues: 0,
        results: [],
        durationMs: 0
      };
    }

    if (onProgress) onProgress({ phase: 'scanning', status: `分析 ${files.length} 个文件`, totalFiles: files.length, current: 0 });

    // 并发受限的批量分析：限制并发以平衡吞吐与 LLM 限流 / 内存占用
    const SCAN_CONCURRENCY = Math.min(4, Math.max(1, files.length));
    let totalIssues = 0;

    const results = await runWithConcurrency(files, SCAN_CONCURRENCY, async (file, i) => {
      const fileName = file.split(path.sep).pop();

      const fileOnProgress = onProgress ? (p) => {
        onProgress({
          ...p,
          phase: 'scanning',
          current: i,
          totalFiles: files.length,
          currentFile: file,
          currentFileName: fileName
        });
      } : undefined;

      const result = await this.analyzeFile(file, { ...options, onProgress: fileOnProgress });
      if (result.success) {
        totalIssues += result.totalIssues || 0;
      }

      if (onProgress) onProgress({
        phase: 'scanning',
        status: `分析: ${fileName}`,
        totalFiles: files.length,
        current: i + 1,
        currentFile: file,
        currentFileName: fileName,
        issuesFound: totalIssues
      });
      return result;
    });

    const successCount = results.filter(r => r.success).length;

    if (onProgress) onProgress({ 
      phase: 'done', 
      status: '扫描完成', 
      totalFiles: files.length,
      scannedFiles: successCount,
      failedFiles: files.length - successCount,
      totalIssues
    });

    return {
      success: true,
      projectPath,
      mode: actualMode,
      totalFiles: files.length,
      scannedFiles: successCount,
      failedFiles: files.length - successCount,
      totalIssues,
      results,
      durationMs: Date.now() - startTime
    };
  }

  /**
   * 优化单个问题（双模核心）
   * 离线模式：本地知识库RAG检索 + 规则匹配
   * 在线模式：云端大模型 + RAG增强
   */
  async optimizeIssue(issue, fullCode, mode) {
    const context = {
      language: issue.language || 'javascript',
      issueType: issue.issueType,
      message: issue.message,
      codeSnippet: issue.codeSnippet
    };

    if (mode === 'offline') {
      return this.optimizeOffline(issue, context);
    } else {
      return this.optimizeOnline(issue, context);
    }
  }

  /**
   * 离线优化：本地知识库RAG
   */
  async optimizeOffline(issue, context) {
    try {
      // 1. 检索相似案例
      const similarCases = await knowledgeBase.findSimilarCases(issue.codeSnippet, {
        language: context.language,
        issueType: context.issueType,
        topK: 3
      }) || [];

      // 2. 检索相关知识
      const relatedKnowledge = await knowledgeBase.searchEntries(
        `${context.issueType} ${context.message}`,
        {
          language: context.language,
          topK: 3
        }
      ) || [];

      // 3. 构建离线优化建议
      let optimizedCode = issue.codeSnippet;
      let explanation = '';
      const suggestions = [];

      if (Array.isArray(similarCases) && similarCases.length > 0 && similarCases[0].similarity > 0.5) {
        const bestCase = similarCases[0];
        optimizedCode = bestCase.optimizedCode;
        explanation = bestCase.explanation;
        suggestions.push(`参考相似案例(ID: ${bestCase.id})`);
        
        // 更新案例使用次数
        knowledgeBase.updateCaseUsage(bestCase.id, 5);
      } else {
        // 基于知识库生成建议
        optimizedCode = this.applyOfflineRules(issue);
        explanation = this.generateOfflineExplanation(issue, relatedKnowledge);
      }

      if (Array.isArray(relatedKnowledge)) {
        relatedKnowledge.forEach(k => {
          if (k.similarity > 0.3) {
            suggestions.push(k.content);
          }
        });
      }

      return {
        success: true,
        mode: 'offline',
        optimizedCode,
        explanation: explanation || '基于本地知识库规则的建议',
        suggestions: suggestions.length > 0 ? suggestions : ['建议参考编码规范进行优化'],
        similarCases: Array.isArray(similarCases) ? similarCases.slice(0, 3) : [],
        knowledgeSources: Array.isArray(relatedKnowledge) ? relatedKnowledge.slice(0, 3) : []
      };

    } catch (error) {
      logger.error('离线优化失败:', error);
      return {
        success: false,
        mode: 'offline',
        message: error.message,
        optimizedCode: issue.codeSnippet,
        explanation: '离线优化失败，建议切换在线模式',
        suggestions: []
      };
    }
  }

  /**
   * 在线优化：云端大模型 + RAG增强
   */
  async optimizeOnline(issue, context) {
    try {
      // 1. 先进行RAG检索（增强上下文）
      const similarCases = await knowledgeBase.findSimilarCases(issue.codeSnippet, {
        language: context.language,
        issueType: context.issueType,
        topK: 3
      }) || [];

      const relatedKnowledge = await knowledgeBase.searchEntries(
        `${context.issueType} ${context.message}`,
        {
          language: context.language,
          topK: 3
        }
      ) || [];

      // 2. 构建增强提示
      const enhancedContext = {
        ...context,
        similarCases: Array.isArray(similarCases) ? similarCases.filter(c => c.similarity > 0.3) : [],
        relatedKnowledge: Array.isArray(relatedKnowledge) ? relatedKnowledge.filter(k => k.similarity > 0.3) : []
      };

      // 3. 调用云端大模型
      const llmResult = await providerManager.optimizeCode(issue.codeSnippet, enhancedContext);

      // 4. 将优化结果存入知识库（持续学习）
      if (llmResult.content && llmResult.content.optimizedCode) {
        knowledgeBase.addCase(
          issue.codeSnippet,
          llmResult.content.optimizedCode,
          llmResult.content.explanation || 'AI优化建议',
          {
            language: context.language,
            issueType: context.issueType
          }
        );
      }

      return {
        success: true,
        mode: 'online',
        optimizedCode: llmResult.content?.optimizedCode || issue.codeSnippet,
        explanation: llmResult.content?.explanation || 'AI优化建议',
        suggestions: llmResult.content?.suggestions || [],
        rawResponse: llmResult.rawContent,
        tokensUsed: llmResult.tokensUsed,
        model: llmResult.model,
        similarCases: similarCases.slice(0, 3)
      };

    } catch (error) {
      logger.error('在线优化失败，回退到离线模式:', error);
      // 在线失败时自动回退到离线模式
      return this.optimizeOffline(issue, context);
    }
  }

  /**
   * 应用离线规则生成优化代码
   */
  applyOfflineRules(issue) {
    const code = issue.codeSnippet;
    
    switch (issue.issueType) {
      case 'unused_variable':
        return `// 建议删除未使用的变量\n// ${code}`;
      
      case 'unused_import':
        return `// 建议删除未使用的导入\n// ${code}`;
      
      case 'magic_number': {
        const match = code.match(/(\d+)/);
        const num = match ? match[1] : 'NUMBER';
        return code.replace(new RegExp(num, 'g'), `CONSTANT_${num}`);
      }
      
      case 'long_function':
        return `// 建议将函数拆分为多个小函数\n// ${code.substring(0, 50)}...`;
      
      default:
        return code;
    }
  }

  /**
   * 生成离线优化说明
   */
  generateOfflineExplanation(issue, knowledge) {
    let explanation = issue.suggestion || '';
    
    if (knowledge.length > 0) {
      explanation += '\n\n参考知识：';
      knowledge.slice(0, 2).forEach(k => {
        explanation += `\n- ${k.content}`;
      });
    }
    
    return explanation;
  }

  /**
   * 收集项目文件（异步，避免阻塞事件循环）
   */
  async collectProjectFiles(projectPath, extensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go']) {
    const files = [];
    const excludeDirs = new Set(['node_modules', 'dist', 'build', 'out', '.git', 'coverage', 'vendor', '__pycache__']);
    const path = require('path');

    const walk = async (dir) => {
      try {
        const items = await fs.promises.readdir(dir);
        // 并发收集子项状态，提升扫描吞吐
        const stats = await Promise.all(
          items.map(async (item) => {
            const fullPath = path.join(dir, item);
            try {
              const stat = await fs.promises.stat(fullPath);
              return { item, fullPath, stat };
            } catch (e) {
              return null;
            }
          })
        );
        for (const entry of stats) {
          if (!entry) continue;
          if (excludeDirs.has(entry.item)) continue;
          if (entry.stat.isDirectory()) {
            await walk(entry.fullPath);
          } else if (extensions.some(ext => entry.item.endsWith(ext))) {
            files.push(entry.fullPath);
          }
        }
      } catch (e) {
        // 忽略无权限访问的目录
      }
    };

    await walk(projectPath);
    return files;
  }

  /**
   * 获取引擎状态
   */
  getStatus() {
    const actualMode = this.getActualMode();
    const providers = providerManager.getAvailableProviders();
    const kbStats = knowledgeBase.getCachedStats();
    const networkStatus = getNetworkStatus();
    
    const mysql = require('../utils/mysql');
    const dbAdapter = require('../utils/dbAdapter').dbAdapter;
    
    const syncQueueCount = dbAdapter.getSyncQueueCount();
    
    return {
      mode: this.mode,
      actualMode,
      initialized: this.initialized,
      networkConnected: networkStatus.connected,
      networkStale: networkStatus.stale,
      providers: providers.map(p => ({
        name: p.name,
        available: p.available,
        model: p.model
      })),
      knowledgeBase: kbStats,
      databaseSync: {
        mysqlEnabled: mysql.isEnabled(),
        mysqlHealthy: mysql.isConnectionHealthy(),
        syncQueuePending: syncQueueCount
      }
    };
  }
}

// 单例实例
const engine = new DualModeEngine();

module.exports = {
  DualModeEngine,
  engine
};
