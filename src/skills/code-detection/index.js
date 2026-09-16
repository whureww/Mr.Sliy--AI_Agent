/**
 * 代码检测技能
 * 基于 AST 静态分析检测代码中的各种问题和不规范之处
 */

const Skill = require('../Skill');
const { logger } = require('../../utils/logger');
const { parseCode } = require('../../services/ast/parser');
const { getFileLanguage } = require('../../utils/helpers');
const { getEnabledRules, getRuleConfig } = require('./rules');

class CodeDetectionSkill extends Skill {
  constructor() {
    super(
      'code-detection',
      '代码缺陷检测技能 - 基于AST静态分析检测代码问题',
      '1.0.0'
    );
    this.dependencies = ['ast-parser'];
    this.enabledRules = [];
  }

  async init() {
    this.enabledRules = getEnabledRules();
    logger.info(`代码检测技能初始化完成，启用 ${this.enabledRules.length} 条检测规则`);
    return true;
  }

  canExecute(context = {}) {
    return this.enabled && (context.sourceCode || context.filePath);
  }

  async execute(context = {}) {
    const { sourceCode, filePath, options = {} } = context;

    if (!sourceCode && !filePath) {
      throw new Error('请提供源代码或文件路径');
    }

    const code = sourceCode || this._readFile(filePath);
    const language = options.language || getFileLanguage(filePath || '');

    return this._detectIssues(code, filePath || 'unknown', language, options);
  }

  async detectFile(filePath, options = {}) {
    const fs = require('fs');
    const sourceCode = fs.readFileSync(filePath, 'utf-8');
    return this.execute({ sourceCode, filePath, options });
  }

  async detectSource(sourceCode, language = 'javascript', options = {}) {
    return this.execute({ sourceCode, language, options });
  }

  async batchDetect(filePaths, options = {}) {
    const fs = require('fs');
    const results = [];
    const startTime = Date.now();

    for (const filePath of filePaths) {
      try {
        const sourceCode = fs.readFileSync(filePath, 'utf-8');
        const result = await this.execute({ sourceCode, filePath, options });
        results.push(result);
      } catch (error) {
        logger.error(`批量检测文件失败: ${filePath}`, error);
        results.push({
          success: false,
          message: error.message,
          filePath
        });
      }
    }

    return {
      success: true,
      totalFiles: filePaths.length,
      scannedFiles: results.filter(r => r.success).length,
      failedFiles: results.filter(r => !r.success).length,
      totalIssues: results.reduce((sum, r) => sum + (r.totalIssues || 0), 0),
      results,
      durationMs: Date.now() - startTime
    };
  }

  getRules() {
    return this.enabledRules;
  }

  _readFile(filePath) {
    // 编码自动检测读取（UTF-8/GBK/Big5/Shift_JIS 等）
    const decoded = require('../../utils/encoding').readTextFileSync(filePath);
    return decoded ? decoded.text : '';
  }

  async _detectIssues(sourceCode, filePath, language, options = {}) {
    const startTime = Date.now();

    try {
      logger.debug(`开始检测: ${filePath} [${language}]`);

      const parseResult = await parseCode(sourceCode, language);

      if (!parseResult.success) {
        return {
          success: false,
          message: parseResult.error,
          filePath,
          language
        };
      }

      const tree = parseResult.tree;
      const issues = [];

      for (const rule of this.enabledRules) {
        try {
          const ruleConfig = getRuleConfig(rule.id);
          if (!ruleConfig.enabled) continue;

          const ruleModule = require(`./rules/${this._ruleIdToFileName(rule.id)}`);
          const ruleIssues = ruleModule.detect(tree, sourceCode, filePath, ruleConfig);
          issues.push(...ruleIssues);
        } catch (ruleError) {
          logger.warn(`规则 ${rule.id} 执行失败: ${ruleError.message}`);
        }
      }

      const result = {
        success: true,
        filePath,
        language,
        totalIssues: issues.length,
        issueCounts: {
          critical: issues.filter(i => i.severity === 'critical').length,
          high: issues.filter(i => i.severity === 'high').length,
          medium: issues.filter(i => i.severity === 'medium').length,
          low: issues.filter(i => i.severity === 'low').length
        },
        issues,
        rulesApplied: this.enabledRules.map(r => r.id),
        durationMs: Date.now() - startTime
      };

      logger.debug(`检测完成: ${filePath}, 发现 ${issues.length} 个问题`);
      return result;
    } catch (error) {
      logger.error(`检测失败: ${filePath}`, error);
      return {
        success: false,
        message: error.message,
        filePath,
        language,
        durationMs: Date.now() - startTime
      };
    }
  }

  _ruleIdToFileName(ruleId) {
    return ruleId.replace(/_/g, '-');
  }
}

const codeDetectionSkill = new CodeDetectionSkill();

module.exports = codeDetectionSkill;
