/**
 * 代码优化技能
 * 提供多种代码优化策略，包括自动修复和改进建议
 */

const Skill = require('../Skill');
const { logger } = require('../../utils/logger');
const { getFileLanguage } = require('../../utils/helpers');
const { knowledgeBase } = require('../../services/vector/knowledgeBase');

class CodeOptimizationSkill extends Skill {
  constructor() {
    super(
      'code-optimization',
      '代码优化技能 - 提供代码优化建议和自动修复',
      '1.0.0'
    );
    this.dependencies = ['code-detection', 'knowledge-base'];
    this.optimizationStrategies = [
      'remove-unused-imports',
      'remove-unused-variables',
      'remove-console-log',
      'remove-unnecessary-else',
      'extract-magic-numbers',
      'add-null-checks',
      'add-comments',
      'simplify-deep-nesting',
      'split-long-functions'
    ];
  }

  async init() {
    logger.info('代码优化技能初始化完成');
    return true;
  }

  canExecute(context = {}) {
    return this.enabled && (context.sourceCode || context.filePath || context.issues);
  }

  async execute(context = {}) {
    const { sourceCode, filePath, issues, options = {} } = context;

    if (!sourceCode && !filePath) {
      throw new Error('请提供源代码或文件路径');
    }

    const code = sourceCode || this._readFile(filePath);
    const language = options.language || getFileLanguage(filePath || '');

    return this._optimizeCode(code, filePath || 'unknown', language, issues, options);
  }

  async optimizeFile(filePath, options = {}) {
    const fs = require('fs');
    const sourceCode = fs.readFileSync(filePath, 'utf-8');
    return this.execute({ sourceCode, filePath, options });
  }

  async getOptimizationSuggestions(issues, context = {}) {
    const suggestions = [];
    const language = context.language || 'javascript';

    for (const issue of issues) {
      const suggestion = await this._getSuggestionForIssue(issue, language);
      if (suggestion) {
        suggestions.push(suggestion);
      }
    }

    return {
      success: true,
      totalSuggestions: suggestions.length,
      suggestions
    };
  }

  async applyAutoFix(issue, sourceCode) {
    const fixStrategy = this._getFixStrategy(issue.issueType);
    if (!fixStrategy) {
      return {
        success: false,
        message: `没有可用的自动修复策略: ${issue.issueType}`
      };
    }

    try {
      const result = fixStrategy.apply(sourceCode, issue);
      return {
        success: true,
        issueType: issue.issueType,
        originalCode: issue.codeSnippet,
        optimizedCode: result.fixedCode,
        explanation: result.explanation
      };
    } catch (error) {
      logger.error(`自动修复失败: ${issue.issueType}`, error);
      return {
        success: false,
        issueType: issue.issueType,
        error: error.message
      };
    }
  }

  getAvailableStrategies() {
    return this.optimizationStrategies;
  }

  _readFile(filePath) {
    // 编码自动检测读取（UTF-8/GBK/Big5/Shift_JIS 等）
    const decoded = require('../../utils/encoding').readTextFileSync(filePath);
    return decoded ? decoded.text : '';
  }

  async _optimizeCode(sourceCode, filePath, language, issues, options) {
    const startTime = Date.now();

    try {
      logger.debug(`开始优化代码: ${filePath}`);

      let detectionIssues = issues;

      if (!detectionIssues || detectionIssues.length === 0) {
        const codeDetection = require('../code-detection');
        const detectResult = await codeDetection.execute({
          sourceCode,
          filePath,
          options: { language }
        });
        detectionIssues = detectResult.issues || [];
      }

      const optimizableIssues = detectionIssues.filter(issue =>
        this._canAutoFix(issue.issueType)
      );

      const suggestions = await this._generateSuggestions(detectionIssues, language);

      let optimizedCode = sourceCode;
      const appliedFixes = [];

      if (options.autoFix !== false) {
        for (const issue of optimizableIssues) {
          const fixResult = await this.applyAutoFix(issue, optimizedCode);
          if (fixResult.success) {
            optimizedCode = fixResult.optimizedCode;
            appliedFixes.push(fixResult);
          }
        }
      }

      const knowledgeSuggestions = await this._getKnowledgeBaseSuggestions(
        detectionIssues,
        language
      );

      return {
        success: true,
        filePath,
        language,
        totalIssues: detectionIssues.length,
        autoFixable: optimizableIssues.length,
        appliedFixes: appliedFixes.length,
        suggestions: [...suggestions, ...knowledgeSuggestions],
        originalCode: sourceCode,
        optimizedCode,
        issues: detectionIssues,
        durationMs: Date.now() - startTime
      };
    } catch (error) {
      logger.error(`代码优化失败: ${filePath}`, error);
      return {
        success: false,
        message: error.message,
        filePath,
        durationMs: Date.now() - startTime
      };
    }
  }

  _canAutoFix(issueType) {
    const autoFixable = [
      'unused_import',
      'unused_variable',
      'console_log',
      'unnecessary_else',
      'magic_number'
    ];
    return autoFixable.includes(issueType);
  }

  _getFixStrategy(issueType) {
    const strategies = {
      unused_import: {
        apply: (code, issue) => {
          const lines = code.split('\n');
          const lineIndex = issue.lineStart - 1;
          if (lineIndex >= 0 && lineIndex < lines.length) {
            lines.splice(lineIndex, 1);
            return {
              fixedCode: lines.join('\n'),
              explanation: '删除了未使用的导入语句'
            };
          }
          return { fixedCode: code, explanation: '无法定位导入语句' };
        }
      },
      unused_variable: {
        apply: (code, issue) => {
          const lines = code.split('\n');
          const lineIndex = issue.lineStart - 1;
          if (lineIndex >= 0 && lineIndex < lines.length) {
            lines.splice(lineIndex, 1);
            return {
              fixedCode: lines.join('\n'),
              explanation: '删除了未使用的变量声明'
            };
          }
          return { fixedCode: code, explanation: '无法定位变量声明' };
        }
      },
      unused_function: {
        apply: (code, issue) => {
          const lines = code.split('\n');
          const startLine = issue.lineStart - 1;
          const endLine = issue.lineEnd || startLine + 5;
          if (startLine >= 0 && startLine < lines.length) {
            lines.splice(startLine, endLine - startLine + 1);
            return {
              fixedCode: lines.join('\n'),
              explanation: '删除了未使用的函数定义'
            };
          }
          return { fixedCode: code, explanation: '无法定位函数定义' };
        }
      },
      console_log: {
        apply: (code, issue) => {
          const lines = code.split('\n');
          const lineIndex = issue.lineStart - 1;
          if (lineIndex >= 0 && lineIndex < lines.length) {
            lines[lineIndex] = `// ${lines[lineIndex].trim()}`;
            return {
              fixedCode: lines.join('\n'),
              explanation: '注释掉了调试用的 console.log'
            };
          }
          return { fixedCode: code, explanation: '无法定位 console.log' };
        }
      },
      unnecessary_else: {
        apply: (code, issue) => {
          const lines = code.split('\n');
          const lineIndex = issue.lineStart - 1;
          if (lineIndex >= 0 && lineIndex < lines.length) {
            const line = lines[lineIndex];
            const elseMatch = line.match(/^\s*else\s*\{?/);
            if (elseMatch) {
              lines[lineIndex] = line.replace(/^\s*else\s*\{?/, '');
              return {
                fixedCode: lines.join('\n'),
                explanation: '移除了 return 后的不必要 else 语句'
              };
            }
          }
          return { fixedCode: code, explanation: '建议手动移除 return 后的 else 语句' };
        }
      },
      magic_number: {
        apply: (code, issue) => {
          const number = issue.magicNumber;
          const constantName = this._generateConstantName(number);
          const lines = code.split('\n');
          const firstLine = lines[0] || '';
          
          let constantLine = '';
          if (firstLine.startsWith('import') || firstLine.startsWith('const') || firstLine.startsWith('let') || firstLine.startsWith('var')) {
            constantLine = `const ${constantName} = ${number};\n`;
            lines.unshift(constantLine);
          } else {
            constantLine = `const ${constantName} = ${number};\n`;
            lines.unshift(constantLine);
          }
          
          for (let i = 0; i < lines.length; i++) {
            lines[i] = lines[i].replace(new RegExp(`\\b${number}\\b`, 'g'), constantName);
          }
          
          return {
            fixedCode: lines.join('\n'),
            explanation: `将魔法数字 ${number} 提取为常量 ${constantName}`
          };
        }
      },
      null_check: {
        apply: (code, issue) => {
          const lines = code.split('\n');
          const lineIndex = issue.lineStart - 1;
          if (lineIndex >= 0 && lineIndex < lines.length) {
            const line = lines[lineIndex];
            const variableName = issue.variable;
            if (variableName && !line.includes('null') && !line.includes('undefined')) {
              lines[lineIndex] = `if (${variableName} == null) return;\n` + line;
              return {
                fixedCode: lines.join('\n'),
                explanation: `添加了 ${variableName} 的空值检查`
              };
            }
          }
          return { fixedCode: code, explanation: '建议添加空值检查' };
        }
      }
    };

    return strategies[issueType] || null;
  }

  _generateConstantName(number) {
    const nameMap = {
      '0': 'ZERO',
      '1': 'ONE',
      '2': 'TWO',
      '100': 'PERCENT',
      '1000': 'THOUSAND',
      '1024': 'KILOBYTE',
      '200': 'SUCCESS_STATUS',
      '400': 'BAD_REQUEST_STATUS',
      '404': 'NOT_FOUND_STATUS',
      '500': 'ERROR_STATUS'
    };
    return nameMap[number] || `MAGIC_NUMBER_${number}`;
  }

  async _generateSuggestions(issues, language) {
    const suggestions = [];
    const seenTypes = new Set();

    for (const issue of issues) {
      if (!seenTypes.has(issue.issueType)) {
        seenTypes.add(issue.issueType);
        suggestions.push({
          type: issue.issueType,
          severity: issue.severity,
          title: this._getIssueTitle(issue.issueType),
          description: issue.suggestion,
          count: issues.filter(i => i.issueType === issue.issueType).length,
          autoFixable: this._canAutoFix(issue.issueType)
        });
      }
    }

    return suggestions.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
  }

  _getIssueTitle(issueType) {
    const titles = {
      unused_variable: '未使用的变量',
      unused_import: '未使用的导入',
      unused_function: '未使用的函数',
      magic_number: '魔法数字',
      long_function: '过长函数',
      high_complexity: '圈复杂度过高',
      deep_nesting: '嵌套层级过深',
      null_check: '缺少空值检查',
      unnecessary_else: '不必要的 else 语句',
      console_log: '调试 console.log',
      duplicate_code: '重复代码',
      missing_comment: '缺少注释'
    };
    return titles[issueType] || issueType;
  }

  async _getKnowledgeBaseSuggestions(issues, language) {
    const suggestions = [];

    try {
      if (issues.length > 0) {
        const topIssues = issues.slice(0, 3);
        for (const issue of topIssues) {
          const query = `${issue.issueType} ${issue.message} best practices`;
          const knowledgeResults = await knowledgeBase.search(query, {
            language,
            limit: 2
          });

          if (knowledgeResults && knowledgeResults.length > 0) {
            suggestions.push({
              type: 'knowledge-base',
              severity: 'info',
              title: `知识库建议: ${this._getIssueTitle(issue.issueType)}`,
              description: `找到 ${knowledgeResults.length} 条相关知识`,
              relatedKnowledge: knowledgeResults
            });
          }
        }
      }
    } catch (error) {
      logger.debug('知识库建议获取失败:', error.message);
    }

    return suggestions;
  }
}

const codeOptimizationSkill = new CodeOptimizationSkill();

module.exports = codeOptimizationSkill;
