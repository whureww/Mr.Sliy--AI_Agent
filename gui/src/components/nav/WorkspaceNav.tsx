import { useEffect, useRef, useState } from 'react';
import { FileNode, searchWorkspace, SearchHit } from '../../ipc/client';
import { openContextMenu, copyText } from '../../lib/contextMenu';
import { t, useLang } from '../../lib/i18n';

export interface Workspace {
  path: string;
  name: string;
  /** 会话别名（重命名后的显示名；未设置时用目录名） */
  alias?: string;
  locked?: boolean; // 锁定后：不可删除、会话只读
  archived?: boolean; // 归档：默认隐藏，可展开查看（不可扫描）
  scheduleMinutes?: number; // 定时自动扫描间隔（0/undefined = 关闭）
}

/** 文件树过滤/全文搜索时跳过的重目录（与后端搜索口径一致） */
const NAV_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  '__pycache__', '.venv', 'venv', '.next', 'coverage', '.idea', '.vscode', 'obj', 'bin'
]);

interface Props {
  workspaces: Workspace[];
  activeWs: string | null;
  currentFile: { path: string } | null;
  /** 读取目录（由 Workbench 提供，包装 IPC listDir） */
  loadDir: (path: string) => Promise<FileNode[]>;
  onAdd: (path: string) => Promise<string | null>; // 返回错误信息或 null
  onRemove: (path: string) => void;
  onRename: (path: string, alias: string) => void; // 别名为空串表示恢复默认名
  onToggleLock: (path: string) => void;
  onArchive: (path: string) => void;
  onSchedule: (path: string, minutes: number) => void;
  onProjectScan: () => void;
  onSelect: (path: string) => void;
  /** 打开文件；line 存在时定位到该行；opts.analyze 为 true 时打开后自动切到分析模式 */
  onOpenFile: (node: { path: string; name?: string; is_dir?: boolean }, line?: number, opts?: { analyze?: boolean }) => void;
  /** 折叠为窄条（宽度由 Workbench 布局状态控制） */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

/** 左侧导航：会话列表（每个目录 = 一个独立对话）+ 新建 + 折叠式文件树 + 全文搜索 */
export default function WorkspaceNav({
  workspaces,
  activeWs,
  currentFile,
  loadDir,
  onAdd,
  onRemove,
  onRename,
  onToggleLock,
  onArchive,
  onSchedule,
  onProjectScan,
  onSelect,
  onOpenFile,
  collapsed,
  onToggleCollapse
}: Props) {
  useLang();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [dialogErr, setDialogErr] = useState('');
  const [browsing, setBrowsing] = useState(false);
  /** 会话搜索与归档展开 */
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  /** 会话重命名弹层 */
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  // 文件树状态：子目录缓存 / 展开集合 / 加载中集合
  const [children, setChildren] = useState<Record<string, FileNode[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [loadErr, setLoadErr] = useState<Record<string, string>>({});

  /** 文件树过滤（B2）：输入即递归过滤出匹配文件/目录 */
  const [filter, setFilter] = useState('');
  const [filterHits, setFilterHits] = useState<{ node: FileNode; rel: string }[]>([]);
  const [filtering, setFiltering] = useState(false);
  const filterSeq = useRef(0);

  /** 全文搜索面板（B1） */
  const [searchOpen, setSearchOpen] = useState(false);
  const [kw, setKw] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [hitTrunc, setHitTrunc] = useState(false);
  const [searchErr, setSearchErr] = useState('');

  /** 切换工作区时重置树并加载根目录 */
  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    setLoading(new Set());
    setLoadErr({});
    setFilter('');
    setFilterHits([]);
    setSearchOpen(false);
    setHits(null);
    if (activeWs) fetchDir(activeWs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWs]);

  const fetchDir = async (path: string) => {
    setLoading((s) => new Set(s).add(path));
    try {
      const nodes = await loadDir(path);
      setChildren((c) => ({ ...c, [path]: nodes }));
      setLoadErr((e) => {
        const n = { ...e };
        delete n[path];
        return n;
      });
    } catch {
      setLoadErr((e) => ({ ...e, [path]: t('nav.loadFail') }));
    } finally {
      setLoading((s) => {
        const n = new Set(s);
        n.delete(path);
        return n;
      });
    }
  };

  const toggle = (node: FileNode) => {
    const isOpen = expanded.has(node.path);
    if (isOpen) {
      setExpanded((s) => {
        const n = new Set(s);
        n.delete(node.path);
        return n;
      });
    } else {
      setExpanded((s) => new Set(s).add(node.path));
      if (!children[node.path]) fetchDir(node.path);
    }
  };

  // ---------- 文件树过滤（B2） ----------
  useEffect(() => {
    const q = filter.trim().toLowerCase();
    if (!q || !activeWs) {
      setFilterHits([]);
      setFiltering(false);
      return;
    }
    const seq = ++filterSeq.current;
    setFiltering(true);
    const timer = setTimeout(async () => {
      const out: { node: FileNode; rel: string }[] = [];
      let visits = 0;
      const walk = async (dir: string, rel: string) => {
        if (out.length >= 200 || visits >= 80) return;
        visits++;
        let nodes: FileNode[];
        try {
          nodes = await loadDir(dir);
        } catch {
          return;
        }
        for (const n of nodes) {
          if (out.length >= 200) return;
          const nrel = rel ? `${rel}/${n.name}` : n.name;
          if (n.name.toLowerCase().includes(q)) out.push({ node: n, rel: nrel });
          if (n.is_dir && !NAV_SKIP_DIRS.has(n.name.toLowerCase())) await walk(n.path, nrel);
        }
      };
      await walk(activeWs, '');
      if (filterSeq.current === seq) {
        setFilterHits(out);
        setFiltering(false);
      }
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, activeWs]);

  // ---------- 全文搜索（B1） ----------
  const runSearch = async () => {
    const k = kw.trim();
    if (!activeWs || k.length < 2 || searching) return;
    setSearching(true);
    setSearchErr('');
    try {
      const r = await searchWorkspace(activeWs, k);
      setHits(r.matches);
      setHitTrunc(r.truncated);
    } catch (e) {
      setSearchErr((e as Error).message || t('nav.searchFail'));
      setHits(null);
    } finally {
      setSearching(false);
    }
  };

  /** 搜索命中的相对路径 → 绝对路径（Windows 工作区用反斜杠拼接） */
  const absHitPath = (relFile: string): string => {
    if (!activeWs) return relFile;
    const sep = activeWs.includes('\\') ? '\\' : '/';
    return activeWs.replace(/[\\/]+$/, '') + sep + relFile.replace(/\//g, sep);
  };

  const browseFolder = async () => {
    setBrowsing(true);
    setDialogErr('');
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === 'string') setDraft(picked);
    } catch {
      setDialogErr('文件夹选择失败（需在应用窗口内使用）');
    } finally {
      setBrowsing(false);
    }
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setDraft('');
    setDialogErr('');
  };

  const confirmAdd = async () => {
    const p = draft.trim();
    if (!p) return;
    setDialogErr('');
    const err = await onAdd(p);
    if (err) setDialogErr(err);
    else closeDialog();
  };

  const confirmRename = () => {
    if (!renaming) return;
    onRename(renaming.path, renameDraft.trim());
    setRenaming(null);
  };

  // 折叠态：48px 窄条（展开按钮 + 竖排标题）
  if (collapsed) {
    return (
      <aside className="card" style={{ padding: '10px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, minHeight: 0, flex: 1 }}>
        <button
          className="btn-ghost"
          onClick={onToggleCollapse}
          title={t('nav.expand')}
          style={{ width: 30, height: 30, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}
        >
          »
        </button>
        <div className="muted" style={{ writingMode: 'vertical-rl', fontSize: 10.5, letterSpacing: 1.5 }}>
          WORKSPACE
        </div>
      </aside>
    );
  }

  const navInputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid var(--border-hairline)',
    borderRadius: 8,
    padding: '8px 12px',
    fontSize: 13,
    outline: 'none',
    background: 'var(--bg-card)',
    color: 'var(--text-primary)'
  };

  return (
    <aside className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="muted" style={{ fontSize: 11, letterSpacing: 1.2 }}>WORKSPACE</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={() => setDialogOpen(true)}
            title={t('nav.newTip')}
            style={{
              background: 'var(--accent-tint)',
              color: 'var(--accent)',
              fontSize: 12,
              fontWeight: 650,
              padding: '3px 10px',
              borderRadius: 7
            }}
          >
            + 新建
          </button>
          <button
            className="btn-ghost"
            onClick={onToggleCollapse}
            title={t('nav.collapse')}
            style={{ width: 22, height: 22, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}
          >
            «
          </button>
        </div>
      </div>

      {/* 会话搜索 */}
      <div style={{ marginBottom: 8 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('nav.searchPh')}
          style={navInputStyle}
        />
      </div>

      {/* 项目级扫描入口（作用于当前激活工作区） */}
      <button
        className="btn-ghost"
        disabled={!activeWs}
        title={activeWs ? t('nav.scanProjectTip') : t('nav.pickWorkspace')}
        onClick={onProjectScan}
        style={{ fontSize: 12.5, marginBottom: 8, width: '100%' }}
      >
        {t('nav.scanProject')}
      </button>

      {/* 会话列表 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 12, maxHeight: 200, overflow: 'auto' }}>
        {workspaces.length === 0 && (
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.7, padding: '4px 6px' }}>
            {t('nav.emptyTitle')}{t('nav.emptyDesc')}
          </div>
        )}
        {workspaces
          .filter((ws) => {
            const q = query.trim().toLowerCase();
            const hit = !q || (ws.alias || ws.name).toLowerCase().includes(q) || ws.path.toLowerCase().includes(q);
            if (!hit) return false;
            return showArchived || !ws.archived || ws.path === activeWs;
          })
          .map((ws) => {
          const active = ws.path === activeWs;
          return (
            <div
              key={ws.path}
              onClick={() => onSelect(ws.path)}
              onContextMenu={(e) =>
                openContextMenu(e, [
                  { label: t('nav.switchTo'), disabled: active, onClick: () => onSelect(ws.path) },
                  { label: t('nav.copyPath'), onClick: () => copyText(ws.path) },
                  { separator: true },
                  {
                    label: t('nav.rename'),
                    onClick: () => {
                      setRenaming(ws);
                      setRenameDraft(ws.alias || ws.name);
                    }
                  },
                  { label: t('nav.resetName'), disabled: !ws.alias, onClick: () => onRename(ws.path, '') },
                  { separator: true },
                  { label: ws.locked ? t('nav.unlock') : t('nav.lock'), onClick: () => onToggleLock(ws.path) },
                  { label: ws.archived ? t('nav.unarchive') : t('nav.archive'), onClick: () => onArchive(ws.path) },
                  { separator: true },
                  {
                    label: ws.scheduleMinutes ? t('nav.schedOffCur', { n: ws.scheduleMinutes }) : t('nav.schedOff'),
                    disabled: !ws.scheduleMinutes,
                    onClick: () => onSchedule(ws.path, 0)
                  },
                  ...[5, 15, 30, 60].map((m) => ({
                    label: `${t('nav.schedEvery', { n: m })}${ws.scheduleMinutes === m ? ' ✓' : ''}`,
                    onClick: () => onSchedule(ws.path, m)
                  })),
                  { separator: true },
                  {
                    label: t('nav.scanProject'),
                    disabled: !active,
                    title: !active ? t('nav.switchToUse') : undefined,
                    onClick: () => onProjectScan()
                  },
                  {
                    label: t('nav.removeWs'),
                    danger: true,
                    disabled: ws.locked,
                    title: ws.locked ? t('nav.lockedRemoveTip') : undefined,
                    onClick: () => onRemove(ws.path)
                  }
                ])
              }
              title={ws.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 10px',
                borderRadius: 8,
                cursor: 'pointer',
                fontSize: 13,
                background: active ? 'var(--accent-tint)' : 'transparent',
                color: active ? 'var(--accent)' : 'inherit',
                transition: 'background 0.3s ease'
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: 2, flexShrink: 0, background: active ? 'var(--accent)' : '#CFCDC7' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontWeight: active ? 650 : 400, opacity: ws.archived && !active ? 0.55 : 1 }}>
                {ws.alias || ws.name}
              </span>
              {ws.scheduleMinutes ? (
                <span title={t('nav.schedEvery', { n: ws.scheduleMinutes })} style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--accent)' }}>
                  ⏰{ws.scheduleMinutes}
                </span>
              ) : null}
              {ws.archived && (
                <span title={t('nav.archivedTip')} style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--text-muted)' }}>
                  {t('nav.archived')}
                </span>
              )}
              {ws.locked && (
                <span
                  title={t('nav.lockedTip')}
                  style={{ flexShrink: 0, fontSize: 11, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center' }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <rect x="4.5" y="10.5" width="15" height="10" rx="2.4" />
                    <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
                  </svg>
                </span>
              )}
              {!ws.locked && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(ws.path);
                  }}
                title={t('nav.removeWsTip')}
                className="muted"
                style={{
                  background: 'transparent',
                  fontSize: 14,
                  lineHeight: 1,
                  padding: '0 3px',
                  opacity: 0,
                  transition: 'opacity 0.3s ease'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '0')}
              >
                ×
              </button>
              )}
            </div>
          );
        })}
        {workspaces.filter((w) => w.archived).length > 0 && (
          <button
            className="muted"
            onClick={() => setShowArchived((v) => !v)}
            title={showArchived ? t('nav.hideArchived') : t('nav.showArchived')}
            style={{ background: 'transparent', border: 'none', fontSize: 11.5, textAlign: 'left', padding: '6px 8px', cursor: 'pointer' }}
          >
            {showArchived ? '▾' : '▸'} {t('nav.archivedCount', { n: workspaces.filter((w) => w.archived).length })}
          </button>
        )}
      </div>

      {/* 折叠式文件树 / 全文搜索面板 */}
      <div style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 10, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="mono muted" style={{ fontSize: 11.5, marginBottom: 8, wordBreak: 'break-all' }}>
          {activeWs || '—'}
        </div>

        {/* 工具行：文件过滤 + 全文搜索开关 */}
        {activeWs && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('nav.filterPh')}
              title={t('nav.filterTip')}
              style={{ ...navInputStyle, padding: '5px 10px', fontSize: 12.5, flex: 1 }}
            />
            <button
              className="btn-ghost"
              onClick={() => {
                setSearchOpen((v) => !v);
                setHits(null);
                setSearchErr('');
              }}
              title={t('nav.searchTip')}
              style={{
                width: 28,
                padding: 0,
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                ...(searchOpen ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : {})
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <line x1="16.2" y1="16.2" x2="21" y2="21" />
              </svg>
            </button>
          </div>
        )}

        {/* 全文搜索面板：命中行列表，点击打开文件并跳到该行 */}
        {activeWs && searchOpen && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input
                autoFocus
                value={kw}
                onChange={(e) => setKw(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                placeholder={t('nav.searchPh2')}
                style={{ ...navInputStyle, padding: '5px 10px', fontSize: 12.5, flex: 1 }}
              />
              <button className="btn-primary" style={{ fontSize: 12.5, padding: '4px 12px', flexShrink: 0 }} disabled={searching || kw.trim().length < 2} onClick={runSearch}>
                {searching ? t('nav.searching') : t('nav.searchGo')}
              </button>
            </div>
            <div style={{ overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {searchErr && <div style={{ color: 'var(--danger)', fontSize: 12, padding: '4px 6px' }}>{searchErr}</div>}
              {hits && hits.length === 0 && !searchErr && <div className="muted" style={{ fontSize: 12, padding: '4px 6px' }}>{t('nav.searchNoHit')}</div>}
              {(hits || []).map((h, i) => (
                <div
                  key={i}
                  className="selectable"
                  onClick={() => onOpenFile({ path: absHitPath(h.file), name: h.file.split('/').pop(), is_dir: false }, h.line)}
                  title={`${h.file}:${h.line}`}
                  style={{
                    padding: '5px 8px',
                    borderRadius: 6,
                    fontSize: 12,
                    cursor: 'pointer',
                    background: 'transparent',
                    lineHeight: 1.5
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-recessed)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                    <span className="mono" style={{ color: 'var(--accent)', fontSize: 11, flexShrink: 0 }}>{h.file.split('/').pop()}:{h.line}</span>
                    <span className="muted" style={{ fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.file}</span>
                  </div>
                  <div className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text-primary)', fontSize: 11.5 }}>{h.text.trim()}</div>
                </div>
              ))}
              {hitTrunc && <div className="muted" style={{ fontSize: 11.5, padding: '4px 6px' }}>{t('nav.searchTrunc')}</div>}
            </div>
          </div>
        )}

        {/* 文件树（全文搜索面板打开时隐藏） */}
        <div style={{ overflow: 'auto', flex: 1, display: searchOpen ? 'none' : undefined }}>
          {!activeWs && <div className="muted" style={{ fontSize: 12, padding: '4px 6px' }}>{t('nav.browseAfterPick')}</div>}
          {activeWs && filter.trim() && (
            <>
              {filtering && <div className="muted" style={{ fontSize: 12, padding: '4px 6px' }}>{t('nav.filtering')}</div>}
              {!filtering && filterHits.length === 0 && <div className="muted" style={{ fontSize: 12, padding: '4px 6px' }}>{t('nav.filterNoHit')}</div>}
              {filterHits.map(({ node, rel }) => (
                <div
                  key={node.path}
                  onClick={() => !node.is_dir && onOpenFile(node, undefined, { analyze: true })}
                  title={rel}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 8px',
                    borderRadius: 6,
                    cursor: node.is_dir ? 'default' : 'pointer',
                    fontSize: 12.5
                  }}
                  onMouseEnter={(e) => !node.is_dir && (e.currentTarget.style.background = 'var(--bg-recessed)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ width: 12, textAlign: 'center', color: node.is_dir ? 'var(--text-muted)' : 'var(--accent)', fontSize: 11, flexShrink: 0 }}>
                    {node.is_dir ? '▸' : '·'}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
                  <span className="muted" style={{ fontSize: 10.5, marginLeft: 'auto', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {rel}
                  </span>
                </div>
              ))}
            </>
          )}
          {activeWs && !filter.trim() &&
            (children[activeWs] || []).map((n) => (
              <TreeNode
                key={n.path}
                node={n}
                depth={0}
                expanded={expanded}
                childrenMap={children}
                loading={loading}
                loadErr={loadErr}
                currentFile={currentFile}
                onToggle={toggle}
                onOpenFile={onOpenFile}
              />
            ))}
          {activeWs && !filter.trim() && loading.has(activeWs) && !children[activeWs] && (
            <div className="muted" style={{ fontSize: 12, padding: '4px 8px' }}>{t('nav.loading')}</div>
          )}
          {activeWs && !filter.trim() && loadErr[activeWs] && (
            <div style={{ color: 'var(--danger)', fontSize: 12, padding: '4px 8px' }}>{loadErr[activeWs]}</div>
          )}
        </div>
      </div>

      {/* 新建工作区弹层 */}
      {dialogOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(38,37,35,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100
          }}
          onClick={closeDialog}
        >
          <div
            className="card"
            style={{ width: 460, padding: 20 }}
            onClick={(e) => e.stopPropagation()}
          >
            <strong style={{ fontSize: 15 }}>{t('nav.newWsTitle')}</strong>
            <div className="muted" style={{ fontSize: 12.5, margin: '6px 0 14px' }}>
              {t('nav.newWsDesc')}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && confirmAdd()}
                placeholder="D:\projects\my-app"
                style={navInputStyle}
              />
              <button className="btn-ghost" onClick={browseFolder} disabled={browsing}>
                {browsing ? t('nav.opening') : t('nav.browse')}
              </button>
            </div>
            {dialogErr && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 8 }}>{dialogErr}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button className="btn-ghost" onClick={closeDialog}>{t('common.cancel')}</button>
              <button className="btn-primary" onClick={confirmAdd} disabled={!draft.trim()}>
                {t('common.add')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 会话重命名弹层 */}
      {renaming && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(38,37,35,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100
          }}
          onClick={() => setRenaming(null)}
        >
          <div className="card" style={{ width: 400, padding: 20 }} onClick={(e) => e.stopPropagation()}>
            <strong style={{ fontSize: 15 }}>{t('nav.renameTitle')}</strong>
            <div className="muted" style={{ fontSize: 12.5, margin: '6px 0 12px', wordBreak: 'break-all' }}>{renaming.path}</div>
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && confirmRename()}
              placeholder={renaming.name}
              style={navInputStyle}
            />
            <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>{t('nav.renameHint')}</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button className="btn-ghost" onClick={() => setRenaming(null)}>{t('common.cancel')}</button>
              <button className="btn-primary" onClick={confirmRename}>{t('common.save')}</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

/** 折叠树节点：目录点击展开/收起（懒加载子目录），文件点击打开 */
function TreeNode({
  node,
  depth,
  expanded,
  childrenMap,
  loading,
  loadErr,
  currentFile,
  onToggle,
  onOpenFile
}: {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  childrenMap: Record<string, FileNode[]>;
  loading: Set<string>;
  loadErr: Record<string, string>;
  currentFile: { path: string } | null;
  onToggle: (node: FileNode) => void;
  onOpenFile: (node: { path: string; name?: string; is_dir?: boolean }, line?: number) => void;
}) {
  useLang();
  const active = currentFile?.path === node.path;
  const isOpen = expanded.has(node.path);
  const kids = childrenMap[node.path];

  return (
    <>
      <div
        onClick={() => (node.is_dir ? onToggle(node) : onOpenFile(node))}
        onContextMenu={(e) =>
          node.is_dir
            ? openContextMenu(e, [
                { label: isOpen ? t('nav.collapseDir') : t('nav.expandDir'), onClick: () => onToggle(node) },
                { label: t('nav.copyDirPath'), onClick: () => copyText(node.path) }
              ])
            : openContextMenu(e, [
                { label: t('nav.openFile'), disabled: active, onClick: () => onOpenFile(node) },
                { label: t('nav.copyFilePath'), onClick: () => copyText(node.path) },
                { label: t('nav.copyFileName'), onClick: () => copyText(node.name) }
              ])
        }
        title={node.path}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 8px',
          paddingLeft: 6 + depth * 14,
          borderRadius: 6,
          cursor: 'pointer',
          fontSize: 13,
          background: active ? 'var(--accent-tint)' : 'transparent',
          color: active ? 'var(--accent)' : 'inherit',
          whiteSpace: 'nowrap'
        }}
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.background = 'var(--bg-recessed)';
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.background = 'transparent';
        }}
      >
        {node.is_dir ? (
          <span
            style={{
              width: 12,
              display: 'inline-block',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 10,
              transition: 'transform 0.25s ease',
              transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              flexShrink: 0
            }}
          >
            ▶
          </span>
        ) : (
          <span style={{ width: 12, textAlign: 'center', color: 'var(--disabled-text)', fontSize: 12, flexShrink: 0 }}>·</span>
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: node.is_dir ? 550 : 400 }}>
          {node.name}
        </span>
      </div>
      {node.is_dir && isOpen && (
        <div>
          {loading.has(node.path) && !kids && (
            <div className="muted" style={{ fontSize: 12, padding: '3px 8px', paddingLeft: 20 + depth * 14 }}>
              {t('nav.loading')}
            </div>
          )}
          {loadErr[node.path] && (
            <div style={{ color: 'var(--danger)', fontSize: 12, padding: '3px 8px', paddingLeft: 20 + depth * 14 }}>
              {loadErr[node.path]}
            </div>
          )}
          {(kids || []).map((k) => (
            <TreeNode
              key={k.path}
              node={k}
              depth={depth + 1}
              expanded={expanded}
              childrenMap={childrenMap}
              loading={loading}
              loadErr={loadErr}
              currentFile={currentFile}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
            />
          ))}
          {kids && kids.length === 0 && (
            <div className="muted" style={{ fontSize: 12, padding: '3px 8px', paddingLeft: 20 + depth * 14 }}>
              {t('nav.emptyDir')}
            </div>
          )}
        </div>
      )}
    </>
  );
}
