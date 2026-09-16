/**
 * 工作区全文搜索（GUI"跨文件搜索"与 MCP 场景共用）：
 * 递归遍历目录 → 文本文件逐行匹配关键字 → 汇总匹配行。
 * 纯函数实现（fs 通过参数注入默认值），便于单元测试。
 */

const fs = require('fs');
const path = require('path');
const { decodeBuffer } = require('./encoding');

/** 跳过的目录名（依赖/构建产物/版本库等大噪声目录） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  'vendor', '__pycache__', '.venv', 'venv', '.next', '.nuxt', 'coverage',
  '.idea', '.vscode', '.gradle', 'bin', 'obj', '.mr-sliy'
]);

/** 视为二进制、不做文本搜索的扩展名 */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip',
  '.gz', '.tar', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.avi', '.mov',
  '.sqlite', '.db', '.wasm', '.class', '.jar', '.pyc', '.lock'
]);

/** 单文件大小上限（超过直接跳过） */
const MAX_FILE_BYTES = 1024 * 1024;
/** 默认目录递归深度上限 */
const MAX_DEPTH = 14;
/** 默认最多扫描文件数 */
const MAX_FILES = 3000;
/** 默认最多返回匹配行数 */
const MAX_MATCHES = 200;

/**
 * 判断是否应跳过该目录/文件名
 */
function shouldSkipName(name) {
  return SKIP_DIRS.has(name) || name.startsWith('mr-sliy-');
}

/**
 * 从根目录递归收集文本文件路径（相对路径，正斜杠）。
 * 返回 { files, truncated }；files 为绝对路径数组。
 */
function collectTextFiles(root, opts, state) {
  const { fsImpl, maxDepth, maxFiles } = opts;
  const { depth } = state;
  if (state.truncated || depth > maxDepth) return;
  let entries;
  try {
    entries = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // 无权限/已消失：静默跳过
  }
  // 目录优先入栈、文件后处理，结果顺序稳定
  const dirs = [];
  for (const ent of entries) {
    if (state.files.length >= maxFiles) {
      state.truncated = true;
      return;
    }
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      if (!shouldSkipName(ent.name)) dirs.push(full);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (BINARY_EXTS.has(ext)) continue;
      let size = 0;
      try {
        size = fsImpl.statSync(full).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES || size === 0) continue;
      state.files.push(full);
    }
  }
  for (const d of dirs) collectTextFiles(d, opts, state);
}

/**
 * 单文件逐行匹配。返回该文件的匹配行 [{line, text, column}]，异常/二进制返回 []。
 * 大小写不敏感的字面量匹配；keyword 为空返回 []。
 */
function matchInFile(absPath, keyword, fsImpl, maxLineLength = 400) {
  let content;
  try {
    const buf = fsImpl.readFileSync(absPath);
    // 编码自动检测解码（UTF-8/UTF-16/GBK/Big5/Shift_JIS 等）；二进制返回 null 跳过
    const decoded = decodeBuffer(buf);
    if (!decoded) return [];
    content = decoded.text;
  } catch {
    return [];
  }
  const kw = keyword.toLowerCase();
  const out = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].toLowerCase().indexOf(kw);
    if (idx === -1) continue;
    out.push({
      line: i + 1,
      column: idx + 1,
      text: lines[i].length > maxLineLength ? lines[i].slice(0, maxLineLength) + '…' : lines[i]
    });
    if (out.length >= 20) break; // 单文件最多 20 条命中，防单文件刷屏
  }
  return out;
}

/**
 * 工作区搜索主入口。
 * @param {object} p
 * @param {string} p.root 工作区根目录（绝对路径）
 * @param {string} p.keyword 搜索关键字（≥2 字符）
 * @param {object} [p.opts] 测试注入：fsImpl / maxDepth / maxFiles / maxMatches
 * @returns {{matches: Array, truncated: boolean, searchedFiles: number}}
 */
function searchWorkspace({ root, keyword, opts = {} }) {
  const fsImpl = opts.fsImpl || fs;
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const maxMatches = opts.maxMatches ?? MAX_MATCHES;
  const kw = String(keyword || '').trim();
  if (!root || kw.length < 2) {
    return { matches: [], truncated: false, searchedFiles: 0 };
  }

  const state = { files: [], truncated: false, depth: 0 };
  collectTextFiles(root, { fsImpl, maxDepth, maxFiles }, state);

  const matches = [];
  let searched = 0;
  for (const abs of state.files) {
    if (matches.length >= maxMatches) {
      state.truncated = true;
      break;
    }
    searched++;
    const hits = matchInFile(abs, kw, fsImpl);
    for (const h of hits) {
      if (matches.length >= maxMatches) {
        state.truncated = true;
        break;
      }
      matches.push({
        file: path.relative(root, abs).replace(/\\/g, '/'),
        line: h.line,
        column: h.column,
        text: h.text
      });
    }
  }
  return { matches, truncated: state.truncated, searchedFiles: searched };
}

module.exports = { searchWorkspace, shouldSkipName, BINARY_EXTS, SKIP_DIRS };
