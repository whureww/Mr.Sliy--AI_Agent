/**
 * RAG代码优化Agent服务
 * 基于检索增强生成技术的代码智能优化
 */

const { config } = require('../../config');
const { logger } = require('../../utils/logger');
const { generateUUID, retry } = require('../../utils/helpers');
const { getDatabase } = require('../../utils/database');
const {
  providerManager,
  OPTIMIZATION_SYSTEM_PROMPT,
  buildOptimizationPrompt
} = require('../llm/providers');
const { knowledgeBase } = require('../vector/knowledgeBase');

// 代码片段向量存储（简化版）
const codeVectorStore = new Map();

// 优化历史记录缓存
const optimizationHistory = [];

/**
 * AI API客户端
 * 使用真实的LLM提供商进行代码优化
 */
class AIClient {
  constructor() {
    this.providerManager = providerManager;
  }

  /**
   * 调用真实AI API进行代码优化
   * 提示词与 providers.js 共用同一稳定前缀（前缀缓存命中的前提）
   */
  async optimizeCode(codeSnippet, context) {
    const provider = this.providerManager.getActiveProvider();
    if (!provider) {
      return {
        success: false,
        message: '未配置可用的LLM提供商，无法使用AI优化功能'
      };
    }

    try {
      const prompt = buildOptimizationPrompt(codeSnippet, context);
      const messages = [
        { role: 'system', content: OPTIMIZATION_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ];

      // 输出上限按输入规模动态放大：优化结果为整段代码的 JSON 转义串（约 1.3 倍膨胀），
      // 固定 2000 在文件稍大时必然截断 → JSON 解析失败 → 空结果。上限 8000（主流模型安全值）。
      const maxTokens = Math.min(8000, Math.max(2000, Math.ceil(codeSnippet.length / 2) + 2000));

      const result = await provider.chat(messages, {
        temperature: 0.3,
        maxTokens,
        jsonMode: true
      });

      // 解析AI返回的结果
      let optimizedCode = '';
      let explanation = '';
      let suggestions = [];
      if (typeof result.content === 'object' && result.content !== null) {
        // AI直接返回了JSON对象（兼容字段名变体：optimized_code / code）
        optimizedCode = result.content.optimizedCode || result.content.optimized_code || result.content.code || '';
        explanation = result.content.explanation || '';
        suggestions = result.content.suggestions || [];
      } else if (typeof result.rawContent === 'string') {
        // 从文本中解析JSON
        try {
          const jsonMatch = result.rawContent.match(/```json\s*([\s\S]*?)\s*```/) || result.rawContent.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            optimizedCode = parsed.optimizedCode || parsed.optimized_code || parsed.code || '';
            explanation = parsed.explanation || '';
            suggestions = parsed.suggestions || [];
          } else {
            // 无法解析JSON，使用原始文本作为说明
            explanation = result.rawContent;
          }
        } catch (parseError) {
          explanation = result.rawContent;
        }
      }

      // 空结果必须显式失败：透传空串会让前端按"整文件删除"渲染 diff
      if (!optimizedCode || typeof optimizedCode !== 'string') {
        logger.warn('AI优化返回内容为空或解析失败（可能输出被截断）');
        return {
          success: false,
          message: 'AI 返回的优化结果为空或解析失败（可能因输出长度限制被截断），请重试或分段处理大文件'
        };
      }

      return {
        success: true,
        optimizedCode,
        explanation,
        suggestions,
        tokensUsed: result.tokensUsed || 0,
        usage: result.usage || null,
        model: result.model || null
      };
    } catch (error) {
      logger.error('AI优化调用失败:', error);
      return {
        success: false,
        message: error.message
      };
    }
  }
}

const aiClient = new AIClient();

/**
 * 代码片段索引（简化版向量存储）
 */
function indexCodeSnippet(snippet, metadata) {
  const id = generateUUID();
  
  // 简化的特征提取（实际应使用embedding模型）
  const features = extractFeatures(snippet);
  
  codeVectorStore.set(id, {
    id,
    snippet,
    features,
    metadata,
    indexedAt: new Date()
  });
  
  logger.info(`索引代码片段: ${id}`);
  return id;
}

/**
 * 提取代码特征（简化版）
 */
function extractFeatures(code) {
  const features = {
    length: code.length,
    lines: code.split('\n').length,
    keywords: extractKeywords(code),
    complexity: calculateComplexity(code)
  };
  
  return features;
}

/**
 * 提取关键词
 */
function extractKeywords(code) {
  const keywords = [];
  const patterns = [
    /\b(function|const|let|var|if|else|for|while|return|class|import|export)\b/g,
    /\b(async|await|try|catch|throw|new|this)\b/g
  ];
  
  patterns.forEach(pattern => {
    const matches = code.match(pattern);
    if (matches) {
      keywords.push(...matches);
    }
  });
  
  return keywords;
}

/**
 * 计算代码复杂度（简化版）
 */
function calculateComplexity(code) {
  let complexity = 1;
  
  // 计算控制流语句
  const controlPatterns = [
    /\bif\b/g,
    /\belse\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bswitch\b/g,
    /\bcatch\b/g
  ];
  
  controlPatterns.forEach(pattern => {
    const matches = code.match(pattern);
    if (matches) {
      complexity += matches.length;
    }
  });
  
  return complexity;
}

/**
 * 检索相似代码片段
 */
function retrieveSimilarSnippets(querySnippet, topK = 5) {
  const queryFeatures = extractFeatures(querySnippet);
  const results = [];
  
  codeVectorStore.forEach((value, id) => {
    const similarity = calculateSimilarity(queryFeatures, value.features);
    results.push({
      id,
      snippet: value.snippet,
      similarity,
      metadata: value.metadata
    });
  });
  
  // 按相似度排序
  results.sort((a, b) => b.similarity - a.similarity);
  
  return results.slice(0, topK);
}

/**
 * 计算相似度（简化版）
 */
function calculateSimilarity(features1, features2) {
  let similarity = 0;
  
  // 长度相似度
  const lengthSim = 1 - Math.abs(features1.length - features2.length) / Math.max(features1.length, features2.length);
  similarity += lengthSim * 0.3;
  
  // 关键词相似度
  const keywordIntersection = features1.keywords.filter(k => features2.keywords.includes(k));
  const keywordSim = keywordIntersection.length / Math.max(features1.keywords.length, features2.keywords.length);
  similarity += keywordSim * 0.4;
  
  // 复杂度相似度
  const complexitySim = 1 - Math.abs(features1.complexity - features2.complexity) / Math.max(features1.complexity, features2.complexity);
  similarity += complexitySim * 0.3;
  
  return similarity;
}

/**
 * RAG优化流程
 */
async function optimizeWithRAG(issue, context) {
  const startTime = Date.now();
  
  try {
    // 1. 检索相似代码片段
    const similarSnippets = retrieveSimilarSnippets(issue.codeSnippet, 3);
    
    // 2. 构建增强上下文
    const enhancedContext = {
      ...context,
      similarExamples: similarSnippets.map(s => ({
        snippet: s.snippet,
        similarity: s.similarity
      }))
    };
    
    // 3. 调用AI进行优化
    const aiResult = await retry(
      () => aiClient.optimizeCode(issue.codeSnippet, enhancedContext),
      3,
      1000
    );
    
    if (!aiResult.success) {
      return aiResult;
    }

    // 出口兜底：空代码视为失败，杜绝空串流向下沉管线（diff 全删 / MCP 返回空优化）
    if (!aiResult.optimizedCode || typeof aiResult.optimizedCode !== 'string') {
      return {
        success: false,
        message: 'AI 优化结果为空，请重试',
        durationMs: Date.now() - startTime
      };
    }
    
    // 4. 记录优化历史
    const optimizationRecord = {
      id: generateUUID(),
      issueId: issue.id,
      taskId: context.taskId,
      originalCode: issue.codeSnippet,
      optimizedCode: aiResult.optimizedCode,
      explanation: aiResult.explanation,
      suggestions: aiResult.suggestions,
      similarSnippetsCount: similarSnippets.length,
      tokensUsed: aiResult.tokensUsed,
      durationMs: Date.now() - startTime,
      createdAt: new Date()
    };
    
    // 存储到数据库
    saveOptimizationRecord(optimizationRecord);
    
    // 索引优化后的代码
    indexCodeSnippet(aiResult.optimizedCode, {
      type: 'optimized',
      issueType: context.issueType,
      language: context.language
    });
    
    logger.info(`RAG优化完成: ${optimizationRecord.id}`);
    
    return {
      success: true,
      optimizationId: optimizationRecord.id,
      optimizedCode: aiResult.optimizedCode,
      explanation: aiResult.explanation,
      suggestions: aiResult.suggestions,
      similarSnippets: similarSnippets,
      tokensUsed: aiResult.tokensUsed,
      usage: aiResult.usage || null,
      model: aiResult.model || null,
      durationMs: Date.now() - startTime
    };
  } catch (error) {
    logger.error('RAG优化失败:', error);
    return {
      success: false,
      message: error.message,
      durationMs: Date.now() - startTime
    };
  }
}

/**
 * 存储优化记录到数据库
 */
function saveOptimizationRecord(record) {
  try {
    const { getDatabase } = require('../../utils/database');
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO ai_optimize_record
      (issue_id, task_id, original_code, optimized_code, explanation,
       optimization_type, ai_model, tokens_used, api_latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      parseInt(record.issueId) || 0,
      parseInt(record.taskId) || 0,
      record.originalCode || '',
      record.optimizedCode || '',
      record.explanation || '',
      record.optimizationType || 'refactor',
      record.aiModel || config.ai?.model || '',
      parseInt(record.tokensUsed) || 0,
      parseInt(record.durationMs) || 0
    );
    
    optimizationHistory.push(record);
  } catch (error) {
    logger.error('存储优化记录失败:', error);
  }
}

/**
 * 获取优化历史
 */
function getOptimizationHistory(limit = 10) {
  return optimizationHistory.slice(0, limit);
}

/**
 * 清空向量存储
 */
function clearVectorStore() {
  codeVectorStore.clear();
  logger.info('向量存储已清空');
}

async function optimizeOffline(codeSnippet, context) {
  const startTime = Date.now();
  
  try {
    const kbResult = await knowledgeBase.applyOptimizationPattern(codeSnippet, {
      language: context.language
    });

    if (kbResult.success) {
      const optimizationRecord = {
        id: generateUUID(),
        issueId: context.issueId,
        taskId: context.taskId,
        originalCode: codeSnippet,
        optimizedCode: kbResult.optimizedCode,
        explanation: kbResult.explanation,
        suggestions: kbResult.suggestions,
        durationMs: Date.now() - startTime,
        createdAt: new Date()
      };

      saveOptimizationRecord(optimizationRecord);

      logger.info(`离线优化完成: ${optimizationRecord.id}`);

      return {
        success: true,
        optimizationId: optimizationRecord.id,
        optimizedCode: kbResult.optimizedCode,
        explanation: kbResult.explanation,
        suggestions: kbResult.suggestions,
        appliedPatterns: kbResult.appliedPatterns,
        similarCases: kbResult.similarCases,
        mode: 'offline',
        durationMs: Date.now() - startTime
      };
    }

    const ruleResult = applyStaticRules(codeSnippet, context);
    
    if (ruleResult.success) {
      const optimizationRecord = {
        id: generateUUID(),
        issueId: context.issueId,
        taskId: context.taskId,
        originalCode: codeSnippet,
        optimizedCode: ruleResult.optimizedCode,
        explanation: ruleResult.explanation,
        suggestions: ruleResult.suggestions,
        durationMs: Date.now() - startTime,
        createdAt: new Date()
      };

      saveOptimizationRecord(optimizationRecord);

      logger.info(`静态规则优化完成: ${optimizationRecord.id}`);

      return {
        success: true,
        optimizationId: optimizationRecord.id,
        optimizedCode: ruleResult.optimizedCode,
        explanation: ruleResult.explanation,
        suggestions: ruleResult.suggestions,
        mode: 'static_rules',
        durationMs: Date.now() - startTime
      };
    }

    return {
      success: false,
      message: '离线模式下未找到可应用的优化方案',
      optimizedCode: codeSnippet,
      mode: 'offline',
      durationMs: Date.now() - startTime
    };
  } catch (error) {
    logger.error('离线优化失败:', error);
    return {
      success: false,
      message: error.message,
      mode: 'offline',
      durationMs: Date.now() - startTime
    };
  }
}

function applyStaticRules(codeSnippet, context) {
  const rules = [
    {
      name: 'remove-console-log',
      pattern: /console\.(log|debug|info|warn|error)\([^)]*\);?/g,
      replacement: '',
      explanation: '移除调试日志语句'
    },
    {
      name: 'const-instead-of-var',
      pattern: /\bvar\s+(\w+)\s*=\s*(?!function|new)/g,
      replacement: 'const $1 =',
      explanation: '将var替换为const'
    },
    {
      name: 'let-instead-of-var',
      pattern: /\bvar\s+(\w+)\s*=\s*(?!function|new)/g,
      replacement: 'let $1 =',
      explanation: '将var替换为let'
    },
    {
      name: 'arrow-function',
      pattern: /function\s*\(\)\s*\{/g,
      replacement: '() => {',
      explanation: '使用箭头函数简化代码'
    },
    {
      name: 'template-literals',
      pattern: /(["'])\+\s*(\w+)\s*\+\s*(["'])/g,
      replacement: '`${$2}`',
      explanation: '使用模板字符串替代字符串拼接'
    },
    {
      name: 'remove-unused-var',
      pattern: /^(?:const|let|var)\s+\w+\s*=\s*undefined;?$/gm,
      replacement: '',
      explanation: '移除未使用的变量声明'
    },
    {
      name: 'short-circuit-assignment',
      pattern: /if\s*\(\s*(!)?\s*(\w+)\s*\)\s*\{?\s*\2\s*=\s*(.+?)\s*;?\s*\}?/g,
      replacement: '$2 = $2 || $3;',
      explanation: '使用短路赋值简化条件判断'
    },
    {
      name: 'object-shorthand',
      pattern: /(\w+)\s*:\s*(\w+)\s*(?=,|})/g,
      replacement: '$1',
      explanation: '使用对象属性简写'
    }
  ];

  let optimizedCode = codeSnippet;
  const appliedRules = [];

  for (const rule of rules) {
    const original = optimizedCode;
    optimizedCode = optimizedCode.replace(rule.pattern, rule.replacement);
    
    if (optimizedCode !== original) {
      appliedRules.push({
        rule: rule.name,
        explanation: rule.explanation
      });
    }
  }

  const changed = optimizedCode !== codeSnippet;

  return {
    success: changed,
    optimizedCode: changed ? optimizedCode : codeSnippet,
    explanation: changed 
      ? `应用了${appliedRules.length}个静态优化规则` 
      : '未找到可应用的静态优化规则',
    suggestions: appliedRules.map(r => r.explanation),
    appliedRules
  };
}

async function smartOptimize(codeSnippet, context) {
  const hasProvider = providerManager.getActiveProvider() !== null;
  
  if (hasProvider) {
    try {
      const onlineResult = await optimizeWithRAG({ codeSnippet, id: context.issueId }, context);
      if (onlineResult.success) {
        return { ...onlineResult, mode: 'online' };
      }
    } catch (e) {
      logger.warn('在线优化失败，回退到离线模式:', e.message);
    }
  }

  return optimizeOffline(codeSnippet, context);
}

module.exports = {
  indexCodeSnippet,
  retrieveSimilarSnippets,
  optimizeWithRAG,
  optimizeOffline,
  smartOptimize,
  getOptimizationHistory,
  clearVectorStore,
  AIClient
};