/**
 * 代码分析技能
 * 提供代码统计、结构分析、复杂度评估等功能
 */

const Skill = require('../Skill');
const { logger } = require('../../utils/logger');
const { getFileLanguage, countLines } = require('../../utils/helpers');
const { parseCode, extractFunctions, extractVariables, extractImports } = require('../../services/ast/parser');
const complexityAnalysis = require('./complexityAnalysis');
const securityDetection = require('./securityDetection');
const performanceOptimization = require('./performanceOptimization');

class CodeAnalysisSkill extends Skill {
  constructor() {
    super(
      'code-analysis',
      '代码分析技能 - 代码统计、结构分析和复杂度评估',
      '1.0.0'
    );
    this.dependencies = ['ast-parser'];
    this.subSkills = {
      complexity: complexityAnalysis,
      security: securityDetection,
      performance: performanceOptimization
    };
  }

  async init() {
    logger.info('代码分析技能初始化完成');
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

    return this._analyzeCode(code, filePath || 'unknown', language, options);
  }

  async analyzeFile(filePath, options = {}) {
    const fs = require('fs');
    const sourceCode = fs.readFileSync(filePath, 'utf-8');
    return this.execute({ sourceCode, filePath, options });
  }

  async analyzeProject(dirPath, options = {}) {
    const fs = require('fs');
    const path = require('path');
    const { scanExtensions, excludeDirs, excludeFiles } = require('../../config').config.scan;

    const files = this._collectFiles(dirPath, scanExtensions, excludeDirs, excludeFiles);
    const results = [];
    const summary = {
      totalFiles: files.length,
      totalLines: 0,
      totalFunctions: 0,
      totalClasses: 0,
      languages: {},
      fileTypes: {}
    };

    for (const file of files) {
      try {
        const sourceCode = fs.readFileSync(file, 'utf-8');
        const relPath = path.relative(dirPath, file);
        const result = await this.execute({
          sourceCode,
          filePath: relPath,
          options
        });

        if (result.success) {
          results.push(result);
          summary.totalLines += result.metrics.totalLines;
          summary.totalFunctions += result.metrics.functionCount;

          const lang = result.language;
          summary.languages[lang] = (summary.languages[lang] || 0) + 1;

          const ext = path.extname(file);
          summary.fileTypes[ext] = (summary.fileTypes[ext] || 0) + 1;
        }
      } catch (error) {
        logger.debug(`分析文件失败: ${file}`, error.message);
      }
    }

    return {
      success: true,
      projectPath: dirPath,
      summary,
      files: results,
      totalFiles: files.length,
      analyzedFiles: results.length
    };
  }

  async analyzeComplexity(sourceCode, language = 'javascript') {
    return await complexityAnalysis.execute({ sourceCode, language });
  }

  async analyzeSecurity(sourceCode, language = 'javascript') {
    return await securityDetection.execute({ sourceCode, language });
  }

  async analyzePerformance(sourceCode, language = 'javascript') {
    return await performanceOptimization.execute({ sourceCode, language });
  }

  async getMetrics(sourceCode, language = 'javascript') {
    const lines = countLines(sourceCode);
    const parseResult = await parseCode(sourceCode, language);

    if (!parseResult.success) {
      return { totalLines: lines };
    }

    const tree = parseResult.tree;
    const functions = extractFunctions(tree, sourceCode);
    const variables = extractVariables(tree, sourceCode);
    const imports = extractImports(tree, sourceCode);

    const avgFunctionLength = functions.length > 0
      ? Math.round(functions.reduce((sum, f) => sum + (f.endLine - f.startLine + 1), 0) / functions.length)
      : 0;

    const maxFunctionLength = functions.length > 0
      ? Math.max(...functions.map(f => f.endLine - f.startLine + 1))
      : 0;

    const commentLines = this._countCommentLines(sourceCode, language);
    const commentRatio = lines > 0 ? (commentLines / lines * 100).toFixed(1) : 0;

    return {
      totalLines: lines,
      codeLines: lines - commentLines,
      commentLines,
      commentRatio: `${commentRatio}%`,
      functionCount: functions.length,
      variableCount: variables.length,
      importCount: imports.length,
      avgFunctionLength,
      maxFunctionLength,
      functions: functions.map(f => ({
        name: f.name,
        startLine: f.startLine,
        endLine: f.endLine,
        lineCount: f.endLine - f.startLine + 1
      }))
    };
  }

  async getStructure(sourceCode, language = 'javascript') {
    const parseResult = await parseCode(sourceCode, language);

    if (!parseResult.success) {
      return { success: false, error: parseResult.error };
    }

    const tree = parseResult.tree;
    const functions = extractFunctions(tree, sourceCode);
    const imports = extractImports(tree, sourceCode);
    const variables = extractVariables(tree, sourceCode);

    return {
      success: true,
      language,
      structure: {
        imports: imports.map(i => i.name),
        functions: functions.map(f => ({
          name: f.name,
          line: f.startLine,
          params: f.params || [],
          isAsync: f.isAsync || false
        })),
        variables: variables.map(v => ({
          name: v.name,
          line: v.line,
          type: v.kind || 'var'
        }))
      }
    };
  }

  _readFile(filePath) {
    // 编码自动检测读取（UTF-8/GBK/Big5/Shift_JIS 等）
    const decoded = require('../../utils/encoding').readTextFileSync(filePath);
    return decoded ? decoded.text : '';
  }

  async _analyzeCode(sourceCode, filePath, language, options) {
    const startTime = Date.now();

    try {
      logger.debug(`开始分析代码: ${filePath}`);

      const metrics = await this.getMetrics(sourceCode, language);
      const structure = await this.getStructure(sourceCode, language);

      return {
        success: true,
        filePath,
        fileName: filePath.split(/[/\\]/).pop(),
        language,
        metrics,
        structure: structure.structure || {},
        durationMs: Date.now() - startTime
      };
    } catch (error) {
      logger.error(`代码分析失败: ${filePath}`, error);
      return {
        success: false,
        message: error.message,
        filePath,
        durationMs: Date.now() - startTime
      };
    }
  }

  _countCommentLines(sourceCode, language) {
    const lines = sourceCode.split('\n');
    let commentLines = 0;
    let inBlockComment = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (inBlockComment) {
        commentLines++;
        if (trimmed.includes('*/')) {
          inBlockComment = false;
        }
        continue;
      }

      if (trimmed.startsWith('//')) {
        commentLines++;
      } else if (trimmed.startsWith('/*')) {
        commentLines++;
        if (!trimmed.includes('*/')) {
          inBlockComment = true;
        }
      } else if (trimmed.startsWith('#') && ['python', 'ruby'].includes(language)) {
        commentLines++;
      }
    }

    return commentLines;
  }

  _collectFiles(dirPath, extensions, excludeDirs, excludeFiles) {
    const fs = require('fs');
    const path = require('path');
    const files = [];

    function scanDirectory(currentPath) {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          if (!excludeDirs.includes(entry.name)) {
            scanDirectory(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (extensions.includes(ext) && !excludeFiles.some(ef => entry.name.endsWith(ef))) {
            files.push(fullPath);
          }
        }
      }
    }

    scanDirectory(dirPath);
    return files;
  }
}

const codeAnalysisSkill = new CodeAnalysisSkill();

module.exports = codeAnalysisSkill;
