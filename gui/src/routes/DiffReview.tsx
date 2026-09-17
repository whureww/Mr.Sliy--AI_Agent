import { useEffect, useState } from 'react';
import { DiffPayload } from '../App';
import { optimizeCode, readFile, saveFile } from '../ipc/client';
import { openContextMenu, copyText } from '../lib/contextMenu';
import { t, useLang } from '../lib/i18n';

interface Props {
  payload: DiffPayload | null;
  onBack: () => void;
  /** 挂载即就绪(纯同步渲染),保持页面切换过渡协议一致 */
  onReady?: () => void;
}

/** 行级差异（LCS）：' '='相同 '+'新增 '-'删除 */
function diffLines(before: string, after: string): { type: ' ' | '+' | '-'; text: string }[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  // LCS 动态规划（代码片段规模有限，可接受）
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: { type: ' ' | '+' | '-'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: ' ', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: '-', text: a[i] });
      i++;
    } else {
      out.push({ type: '+', text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: '-', text: a[i++] });
  while (j < m) out.push({ type: '+', text: b[j++] });
  return out;
}

export default function DiffReview({ payload, onBack, onReady }: Props) {
  // 纯同步渲染:大差异 LCS 计算也在此完成,挂载即代表内容完整
  useEffect(() => {
    onReady?.();
  }, []);
  useLang();
  const [explanation, setExplanation] = useState<string>('');
  const [regenerating, setRegenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [err, setErr] = useState('');

  if (!payload) {
    return (
      <div className="card" style={{ padding: 40, textAlign: 'center' }}>
        <div className="muted" style={{ marginBottom: 16 }}>{t('diff.empty')}</div>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 16 }}>{t('diff.emptyDesc')}</div>
        <button className="btn-ghost" onClick={onBack}>{t('diff.back')}</button>
      </div>
    );
  }

  const { filePath, language, originalCode, result } = payload;
  const lines = diffLines(originalCode, result.optimizedCode || '');
  const added = lines.filter((l) => l.type === '+').length;
  const removed = lines.filter((l) => l.type === '-').length;

  const regenerate = async () => {
    setRegenerating(true);
    setErr('');
    try {
      const opt = await optimizeCode(originalCode, filePath, language, 'general', t('diff.regeneratePrompt'));
      if (!opt?.optimizedCode) throw new Error(t('wb.optimizeEmpty'));
      setExplanation(opt.explanation || '');
      result.optimizedCode = opt.optimizedCode;
      setApplied(false);
    } catch (e) {
      setErr((e as Error).message || t('diff.regenerateFail'));
    } finally {
      setRegenerating(false);
    }
  };

  const apply = async () => {
    if (!result.optimizedCode) return;
    setApplying(true);
    setErr('');
    try {
      // 自动识别磁盘文件当前编码并以相同格式保存（识别失败回落 UTF-8）
      let enc: string | undefined;
      try {
        enc = (await readFile(filePath)).encoding;
      } catch {
        enc = undefined;
      }
      await saveFile(filePath, result.optimizedCode, enc);
      setApplied(true);
    } catch (e) {
      setErr((e as Error).message || t('diff.applyFail'));
    } finally {
      setApplying(false);
    }
  };

  const lineColor = (t: ' ' | '+' | '-') =>
    t === '+' ? 'rgba(61, 154, 108, 0.14)' : t === '-' ? 'rgba(199, 84, 80, 0.12)' : 'transparent';
  const lineMark = (t: ' ' | '+' | '-') => (t === '+' ? '+ ' : t === '-' ? '- ' : '  ');

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, height: '100%', minHeight: 0 }}>
      {/* 左 · AI 审查说明 */}
      <aside className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflow: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong>{t('diff.reviewTitle')}</strong>
          <span style={{ background: 'var(--accent-tint)', color: 'var(--accent)', fontSize: 11, fontWeight: 650, padding: '2px 9px', borderRadius: 6 }}>
            {t('diff.llmTag')}
          </span>
        </div>
        <div className="mono muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>{filePath}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--success)', background: 'color-mix(in srgb, var(--success) 12%, var(--bg-card))', borderRadius: 8, padding: '3px 9px' }}>{t('diff.linesAdded', { n: added })}</span>
          <span style={{ fontSize: 12, color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, var(--bg-card))', borderRadius: 8, padding: '3px 9px' }}>{t('diff.linesRemoved', { n: removed })}</span>
        </div>
        {err && (
          <div style={{ fontSize: 12.5, color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, var(--bg-card))', borderRadius: 8, padding: '9px 12px', lineHeight: 1.6 }}>
            {err}
          </div>
        )}
        <div style={{ background: 'var(--accent-tint)', borderLeft: '3px solid var(--accent)', borderRadius: 8, padding: 12, fontSize: 13, lineHeight: 1.7 }}
          onContextMenu={(e) => {
            const exp = result.explanation || explanation;
            openContextMenu(e, [
              { label: t('diff.copyExplanation'), disabled: !exp, onClick: () => copyText(exp || '') },
              { label: t('diff.copyOptimized'), disabled: !result.optimizedCode, onClick: () => copyText(result.optimizedCode || '') }
            ]);
          }}
        >
          {result.explanation || explanation || t('diff.explainFallback')}
        </div>
        {result.suggestions && result.suggestions.length > 0 && (
          <div>
            <div className="muted" style={{ fontSize: 11, letterSpacing: 1.2, marginBottom: 8 }}>{t('diff.suggestions')}</div>
            {result.suggestions.map((s, i) => (
              <div key={i} style={{ fontSize: 12.5, marginBottom: 6, lineHeight: 1.6 }}>· {s}</div>
            ))}
          </div>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={regenerate} disabled={regenerating}>
          {regenerating ? t('diff.regenerating') : t('diff.regenerate')}
        </button>
        <button className="btn-ghost" onClick={onBack}>{t('close.back')}</button>
      </aside>

      {/* 右 · 差异对比 */}
      <section className="card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-hairline)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
          {t('diff.title')}
          <span className="muted" style={{ fontSize: 11 }}>{t('diff.legend')}</span>
          <div style={{ flex: 1 }} />
          {applied && <span style={{ fontSize: 12, color: 'var(--success)' }}>{t('diff.written')}</span>}
        </div>
        <pre
          className="mono selectable"
          style={{ flex: 1, overflow: 'auto', margin: 0, padding: 14, fontSize: 12.5, lineHeight: 1.75 }}
          onContextMenu={(e) => {
            const sel = String(window.getSelection() || '');
            openContextMenu(e, [
              { label: t('wb.copySel'), disabled: !sel, onClick: () => copyText(sel) },
              { label: t('diff.copyOptimized'), disabled: !result.optimizedCode, onClick: () => copyText(result.optimizedCode || '') },
              { separator: true },
              { label: applied ? t('diff.applied') : t('diff.apply'), disabled: applying || applied || !result.optimizedCode, onClick: apply }
            ]);
          }}
        >
          {lines.map((l, i) => (
            <div key={i} style={{ background: lineColor(l.type), whiteSpace: 'pre-wrap' }}>
              {lineMark(l.type)}
              {l.text}
            </div>
          ))}
        </pre>
        <div style={{ padding: 12, borderTop: '1px solid var(--border-hairline)', display: 'flex', gap: 10 }}>
          <button className="btn-primary" onClick={apply} disabled={applying || applied || !result.optimizedCode}>
            {applying ? t('diff.applying') : applied ? t('diff.appliedShort') : t('diff.apply')}
          </button>
          <button className="btn-ghost" onClick={onBack}>{t('diff.discard')}</button>
        </div>
      </section>
    </div>
  );
}
