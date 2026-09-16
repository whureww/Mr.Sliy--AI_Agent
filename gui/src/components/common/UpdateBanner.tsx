import { useEffect, useRef, useState } from 'react';
import {
  CheckUpdatePayload,
  DownloadState,
  getUpdateDownloadStatus,
  startUpdateDownload,
  cancelUpdateDownload,
  installUpdate,
  openExternal
} from '../../ipc/client';
import { t, useLang } from '../../lib/i18n';

const DISMISS_KEY = 'update-banner-dismissed';

function readDismissed(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) || '';
  } catch {
    return '';
  }
}

function fmtMB(n?: number): string {
  if (!n || n <= 0) return '0';
  return (n / 1024 / 1024).toFixed(1);
}

/**
 * 顶部更新提示条：发现新版本时显示。
 * 仅提示,不自动下载——用户点"下载"才开始;下载中显示进度并可取消;
 * 完成后"安装"一键启动安装器并退出应用。同一版本关闭后不再提示。
 */
export default function UpdateBanner({ info, onClose }: { info: CheckUpdatePayload; onClose: () => void }) {
  useLang();
  const [visible, setVisible] = useState(true);
  const [dl, setDl] = useState<DownloadState | null>(null);
  const [installing, setInstalling] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 挂载/新版本时恢复下载状态(仅恢复显示,绝不自动开始新下载)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const st = await getUpdateDownloadStatus().catch(() => null);
      if (cancelled || !st) return;
      // 仅当任务属于当前提示的版本时才接管显示,避免旧版本残留状态串场
      if ((st.status === 'downloading' || st.status === 'done') && (!st.version || st.version === info.latestVersion)) {
        setDl(st);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [info.latestVersion, info.download]);

  // 下载中轮询进度,终态停止
  useEffect(() => {
    if (dl?.status !== 'downloading') return;
    const timer = setInterval(async () => {
      const st = await getUpdateDownloadStatus().catch(() => null);
      if (st && aliveRef.current) setDl(st);
    }, 800);
    return () => clearInterval(timer);
  }, [dl?.status]);

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, info.latestVersion || '');
    } catch {}
    setVisible(false);
    onClose();
  };

  const install = async () => {
    if (!dl?.filePath) return;
    setInstalling(true);
    try {
      await installUpdate(dl.filePath);
      // 成功时应用会退出,正常不会执行到这里
    } catch (e) {
      setInstalling(false);
      setDl({ ...dl, status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  };

  if (!info.updateAvailable || !info.latestVersion) return null;
  if (dismissedVersion(info.latestVersion)) return null;
  if (!visible) return null;

  const phase: 'idle' | 'downloading' | 'done' | 'error' = dl?.status || 'idle';
  const percent = phase === 'done' ? 100 : dl?.percent || 0;
  const sizeText =
    dl?.total ? `${fmtMB(dl.received)} / ${fmtMB(dl.total)} MB` : dl?.received ? `${fmtMB(dl.received)} MB` : '';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 16px',
        background: 'var(--accent-tint)',
        borderBottom: '1px solid var(--border-hairline)',
        fontSize: 12.5
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--accent)',
          background: 'var(--bg-card)',
          borderRadius: 6,
          padding: '2px 8px',
          flexShrink: 0
        }}
      >
        {t('update.badge')}
      </span>
      <span style={{ fontWeight: 650, color: 'var(--accent)', flexShrink: 0 }}>v{info.latestVersion}</span>

      {phase === 'downloading' && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <span
            style={{
              flex: 1,
              maxWidth: 260,
              height: 5,
              borderRadius: 3,
              background: 'var(--border-hairline)',
              overflow: 'hidden'
            }}
          >
            <span
              style={{
                display: 'block',
                width: `${percent}%`,
                height: '100%',
                borderRadius: 3,
                background: 'var(--accent)',
                transition: 'width .3s ease'
              }}
            />
          </span>
          <span className="muted" style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
            {t('update.downloading')} {sizeText && `${sizeText} · `}
            {percent}%
          </span>
        </span>
      )}

      {phase === 'done' && (
        <span className="muted" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t('update.done', { ver: dl?.version ? t('update.doneVer', { ver: dl.version }) : '' })}
        </span>
      )}

      {phase === 'error' && (
        <span className="muted" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t('update.failed', { err: dl?.error || t('update.unknownReason') })}
        </span>
      )}

      {(phase === 'idle' || !info.download) && (
        <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {info.notes ? info.notes.slice(0, 80) : t('update.defaultNotes')}
        </span>
      )}

      {phase === 'done' && (
        <button
          className="btn-primary"
          style={{ fontSize: 12, padding: '4px 12px', flexShrink: 0 }}
          disabled={installing}
          onClick={install}
        >
          {installing ? t('update.installing') : t('update.install')}
        </button>
      )}

      {/* 手动开始下载:仅空闲且未开始时显示(用户点"下载"才开始,不再自动下载) */}
      {phase === 'idle' && info.download && (
        <button
          className="btn-primary"
          style={{ fontSize: 12, padding: '4px 12px', flexShrink: 0 }}
          onClick={async () => {
            const s = await startUpdateDownload(info.download!, info.latestVersion!, info.digest).catch(() => null);
            if (s) setDl(s);
          }}
        >
          {t('update.startDownload')}
        </button>
      )}

      {/* 下载中:可取消(终止请求并复位状态) */}
      {phase === 'downloading' && (
        <button
          className="btn-ghost"
          style={{ fontSize: 12, padding: '4px 12px', flexShrink: 0 }}
          onClick={async () => {
            await cancelUpdateDownload().catch(() => {});
            const st = await getUpdateDownloadStatus().catch(() => null);
            setDl(st && st.status !== 'idle' ? st : null);
          }}
        >
          {t('update.cancel')}
        </button>
      )}

      {phase === 'error' && info.download && (
        <button
          className="btn-primary"
          style={{ fontSize: 12, padding: '4px 12px', flexShrink: 0 }}
          onClick={async () => {
            const s = await startUpdateDownload(info.download!, info.latestVersion!, info.digest).catch(() => null);
            if (s) setDl(s);
          }}
        >
          {t('update.retry')}
        </button>
      )}

      {/* 逃生通道:自动下载反复失败(如网络无法直连 GitHub)时,引导用户浏览器手动下载 */}
      {(phase === 'error' || !info.download) && info.url && (
        <button
          className="btn-ghost"
          style={{ fontSize: 12, padding: '4px 12px', flexShrink: 0 }}
          onClick={() => openExternal(info.url!).catch(() => {})}
        >
          {t('update.goDownload')}
        </button>
      )}

      {/* 关闭:下载中点关闭视为放弃下载(先取消后台请求),其余状态直接收起 */}
      <button
        className="btn-ghost"
        title={t('update.dismissTip')}
        aria-label={t('update.dismissAria')}
        onClick={() => {
          if (phase === 'downloading') cancelUpdateDownload().catch(() => {});
          dismiss();
        }}
        style={{ width: 26, height: 26, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );

  function dismissedVersion(v: string): boolean {
    return readDismissed() === v;
  }
}
