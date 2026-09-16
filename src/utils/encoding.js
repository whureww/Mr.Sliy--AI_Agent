/**
 * 文件编码检测与转换（Node 后端共用）：
 * 智能体读文件（扫描/修复/搜索）不再假设 UTF-8——自动识别
 * UTF-8(BOM)/UTF-16/GBK/GB18030/Big5/Shift_JIS/EUC-KR/Windows-125x 等常见编码，
 * 并支持按原编码写回，避免对非 UTF-8 文件读到乱码或保存时转码破坏文件。
 *
 * 纯 JS 实现（chardet 统计检测 + iconv-lite 编解码），不依赖 ICU，CLI / 桌面端行为一致。
 */

const fs = require('fs');
const iconv = require('iconv-lite');

/** BOM 常量 */
const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);

/**
 * chardet 返回的字符集名 → iconv-lite 标签。
 * chardet v1 返回 string、v2 返回 { name }，两者都兼容。
 */
function normalizeDetected(result) {
  const raw = typeof result === 'string' ? result : result && result.name;
  if (!raw || typeof raw !== 'string') return null;
  const label = raw.trim().toLowerCase();
  if (!label) return null;
  // chardet 对 GBK 家族可能报 GBK / GB18030 / GB2312，统一走 gb18030（超集）
  if (label === 'gbk' || label === 'gb2312') return 'gb18030';
  return label;
}

/**
 * CJK 解码干净度评分：CJK/东亚字符占比 + 替换符/坏字符计数。
 * 用于短样本时在 gb18030/big5/shift_jis/euc-kr 等多字节候选间择优（chardet 短样本不可靠）。
 */
function scoreCjk(text) {
  let cjk = 0, bad = 0, total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) continue;
    total++;
    if ((cp >= 0x3400 && cp <= 0x9fff) || // CJK 统一表意
        (cp >= 0x3040 && cp <= 0x30ff) || // 日文假名
        (cp >= 0xac00 && cp <= 0xd7af) || // 韩文谚文
        (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
        (cp >= 0xff00 && cp <= 0xffef)) { // 全角字符
      cjk++;
    } else if (cp === 0xfffd || (cp >= 0x80 && cp <= 0xa0)) {
      bad++;
    }
  }
  return { cjk, bad, total };
}

/** CJK 多字节候选（gb18030 优先：中文用户基数最大；chardet 命中的候选置前） */
function cjkCandidates(chardetLabel) {
  const seeded = chardetLabel && /^(gb|big5|shift_jis|euc-(kr|jp)|iso-2022)/.test(chardetLabel) ? [chardetLabel] : [];
  return [...new Set([...seeded, 'gb18030', 'big5', 'shift_jis', 'euc-kr'])];
}

/**
 * 从字节缓冲检测编码标签。
 * 优先级：BOM → 严格 UTF-8 校验 → CJK 多字节候选评分（短样本兜底）→ chardet 结果 → windows-1252。
 */
function detectEncodingFromBuffer(buf) {
  if (!buf || buf.length === 0) return 'utf-8';
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8-bom';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  // 严格 UTF-8：ASCII 与标准 UTF-8 直接命中（覆盖绝大多数文件）
  let isStrictUtf8 = true;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x80) continue;
    let extra = 0;
    if (b >= 0xc2 && b <= 0xdf) extra = 1;
    else if (b >= 0xe0 && b <= 0xef) extra = 2;
    else if (b >= 0xf0 && b <= 0xf4) extra = 3;
    else { isStrictUtf8 = false; break; }
    if (i + extra >= buf.length) { isStrictUtf8 = false; break; }
    let ok = true;
    for (let j = 1; j <= extra; j++) {
      if ((buf[i + j] & 0xc0) !== 0x80) { ok = false; break; }
    }
    if (!ok) { isStrictUtf8 = false; break; }
    i += extra;
  }
  if (isStrictUtf8) return 'utf-8';

  let chardetLabel = null;
  try {
    const chardet = require('chardet');
    chardetLabel = normalizeDetected(chardet.detect(buf));
  } catch {
    // chardet 加载/检测失败：走评分与兜底
  }

  // 非 UTF-8 且含足够多非 ASCII 字节 → CJK 多字节候选评分（取前 64KB 样本）
  let nonAscii = 0;
  const sample = buf.subarray(0, 65536);
  for (let i = 0; i < sample.length; i++) if (sample[i] >= 0x80) nonAscii++;
  if (nonAscii >= 4) {
    let best = null;
    for (const enc of cjkCandidates(chardetLabel)) {
      if (!iconv.encodingExists(enc)) continue;
      const s = scoreCjk(iconv.decode(sample, enc));
      if (s.total < 4 || s.bad !== 0) continue;
      const ratio = s.cjk / s.total;
      if (!best || ratio > best.ratio) best = { enc, ratio };
      if (best.ratio >= 0.99) break; // 干净解码即采纳
    }
    if (best) return best.enc;
  }

  // CJK 评分未命中（拉丁/西里尔等单字节）：采信 chardet；iso-8859-1 系泛化结果按 cp1252 解码
  if (chardetLabel && iconv.encodingExists(chardetLabel) && !chardetLabel.startsWith('iso-8859-1')) {
    return chardetLabel;
  }
  return 'windows-1252';
}

/**
 * 解码文件缓冲为文本。二进制（前 8KB 含 NUL）返回 null，调用方按需跳过。
 * @returns {{ text: string, encoding: string } | null}
 */
function decodeBuffer(buf) {
  if (!buf || buf.length === 0) return { text: '', encoding: 'utf-8' };
  // BOM 判定必须先于二进制 NUL 检查：UTF-16 的 ASCII 字符低位字节就是 0x00
  const head = buf.subarray(0, 8192);
  const hasBom =
    (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ||
    (buf.length >= 2 && (buf[0] === 0xff || buf[0] === 0xfe) && buf[1] === (buf[0] === 0xff ? 0xfe : 0xff));
  if (!hasBom && head.includes(0)) return null; // 二进制
  const encoding = detectEncodingFromBuffer(buf);
  if (encoding === 'utf-8') {
    return { text: buf.toString('utf8'), encoding };
  }
  if (encoding === 'utf-8-bom') {
    return { text: buf.subarray(3).toString('utf8'), encoding };
  }
  // utf-16le/be 与其余标签：iconv 解码；显式端序可能残留 BOM 字符，手动去除
  let text = iconv.decode(buf, encoding);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, encoding };
}

/**
 * 读取文本文件并检测编码。
 * @returns {Promise<{ text: string, encoding: string }>} 读取失败时抛错（由调用方处理 ENOENT 等）
 */
async function readTextFile(filePath) {
  const buf = await fs.promises.readFile(filePath);
  const decoded = decodeBuffer(buf);
  if (decoded === null) {
    const err = new Error(`二进制文件不支持文本读取: ${filePath}`);
    err.code = 'EBINARY';
    throw err;
  }
  return decoded;
}

/** 同步版本（skills 同步 _readFile 沿用） */
function readTextFileSync(filePath) {
  return decodeBuffer(fs.readFileSync(filePath));
}

/**
 * 以指定编码写盘。encoding 缺省按 UTF-8；utf-8-bom / utf-16le / utf-16be 恒写 BOM。
 * 不支持的编码抛错（不静默转 UTF-8，避免误写）。
 */
async function writeTextFile(filePath, text, encoding) {
  await fs.promises.writeFile(filePath, encodeText(text, encoding));
}

/** 同步版本 */
function writeTextFileSync(filePath, text, encoding) {
  fs.writeFileSync(filePath, encodeText(text, encoding));
}

/** 文本 → 指定编码的 Buffer */
function encodeText(text, encoding) {
  const enc = (encoding || 'utf-8').toLowerCase();
  if (enc === 'utf-8') return Buffer.from(text, 'utf8');
  if (enc === 'utf-8-bom') return Buffer.concat([BOM_UTF8, Buffer.from(text, 'utf8')]);
  if (!iconv.encodingExists(enc)) {
    throw new Error(`不支持的编码: ${encoding}`);
  }
  return iconv.encode(text, enc, { addBOM: enc === 'utf-16le' || enc === 'utf-16be' });
}

module.exports = {
  detectEncodingFromBuffer,
  decodeBuffer,
  readTextFile,
  readTextFileSync,
  writeTextFile,
  writeTextFileSync,
  encodeText
};
