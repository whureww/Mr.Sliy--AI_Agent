﻿/**
 * 文件编码检测与转换单元测试
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const iconv = require('iconv-lite');
const {
  detectEncodingFromBuffer,
  decodeBuffer,
  readTextFile,
  readTextFileSync,
  writeTextFile,
  writeTextFileSync,
  encodeText
} = require('../../src/utils/encoding');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mrsliy-enc-'));
const writeBin = (dir, name, text, enc) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, encodeText(text, enc));
  return p;
};

describe('detectEncodingFromBuffer', () => {
  test('UTF-8 无 BOM', () => {
    expect(detectEncodingFromBuffer(Buffer.from('const x = 1; // 中文注释', 'utf8'))).toBe('utf-8');
  });

  test('UTF-8 BOM / UTF-16 LE / UTF-16 BE 识别', () => {
    expect(detectEncodingFromBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ok')]))).toBe('utf-8-bom');
    expect(detectEncodingFromBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ok')]))).toBe('utf-16le');
    expect(detectEncodingFromBuffer(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('ok')]))).toBe('utf-16be');
  });

  test('GBK 编码中文统计检测（无 BOM）', () => {
    const buf = iconv.encode('这是一个用于验证编码自动检测的中文字符串，长度足够让统计检测器收敛判定。', 'gb18030');
    expect(detectEncodingFromBuffer(buf)).toBe('gb18030');
  });

  test('空缓冲回落 utf-8', () => {
    expect(detectEncodingFromBuffer(Buffer.alloc(0))).toBe('utf-8');
  });
});

describe('decodeBuffer / readTextFile', () => {
  test('GBK 中文解码正确', () => {
    const text = '你好，世界 // hello world';
    const { text: out, encoding } = decodeBuffer(iconv.encode(text, 'gb18030'));
    expect(out).toBe(text);
    expect(encoding).toBe('gb18030');
  });

  test('Big5 / Shift_JIS / EUC-KR 解码正确', () => {
    for (const [enc, text] of [
      ['big5', '中文測試碼優化器這是一段較長的繁體中文樣本字串，用於讓編碼檢測器收斂判定，避免極短樣本在單雙字節候選間產生歧義誤判。'],
      ['shift_jis', 'コード最適化テスト用の日本語サンプル文字列です。十分な長さを持たせて文字コード判定を収束させます。'],
      ['euc-kr', '코드 최적화 테스트를 위한 한국어 샘플 문자열입니다. 충분한 길이로 인코딩 판별을 수렴시킵니다.']
    ]) {
      const { text: out, encoding } = decodeBuffer(iconv.encode(text, enc));
      expect(out).toBe(text);
      expect(encoding).toBe(enc);
    }
  });

  test('UTF-8 BOM 去除后解码', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('fn main() {}')]);
    const { text, encoding } = decodeBuffer(buf);
    expect(text).toBe('fn main() {}');
    expect(encoding).toBe('utf-8-bom');
  });

  test('二进制（含 NUL）返回 null', () => {
    const buf = Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from('abc')]);
    expect(decodeBuffer(buf)).toBeNull();
  });

  test('readTextFile 异步读取 GBK 文件', async () => {
    const dir = tmpDir();
    try {
      const p = writeBin(dir, 'gbk.txt', '编码往返测试内容，长度足够判定。', 'gb18030');
      const { text, encoding } = await readTextFile(p);
      expect(encoding).toBe('gb18030');
      expect(text).toContain('编码往返测试内容');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放，清理失败忽略 */ }
    }
  });

  test('readTextFileSync 同步读取一致', () => {
    const dir = tmpDir();
    try {
      const p = writeBin(dir, 'b5.txt', '繁體中文測試字串', 'big5');
      const { text, encoding } = readTextFileSync(p);
      expect(encoding).toBe('big5');
      expect(text).toBe('繁體中文測試字串');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放，清理失败忽略 */ }
    }
  });
});

describe('writeTextFile / encodeText', () => {
  test('GBK 写入后读回一致', async () => {
    const dir = tmpDir();
    try {
      const p = path.join(dir, 'out.txt');
      await writeTextFile(p, '写入的中文字符串内容', 'gb18030');
      const { text, encoding } = await readTextFile(p);
      expect(encoding).toBe('gb18030');
      expect(text).toBe('写入的中文字符串内容');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放，清理失败忽略 */ }
    }
  });

  test('utf-8-bom 写入含 BOM', () => {
    const buf = encodeText('x', 'utf-8-bom');
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  test('utf-16le 写入含 BOM 且读回一致', () => {
    const buf = encodeText('abc 中文', 'utf-16le');
    expect([...buf.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    const { text } = decodeBuffer(buf);
    expect(text).toBe('abc 中文');
  });

  test('不支持的编码抛错', () => {
    expect(() => encodeText('x', 'not-a-real-enc')).toThrow(/不支持的编码/);
  });

  test('writeTextFileSync 同步写入', () => {
    const dir = tmpDir();
    try {
      const p = path.join(dir, 's.txt');
      writeTextFileSync(p, '同步写入内容', 'gb18030');
      const { text } = readTextFileSync(p);
      expect(text).toBe('同步写入内容');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放，清理失败忽略 */ }
    }
  });
});
