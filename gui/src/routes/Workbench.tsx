import { useCallback, useEffect, useRef, useState } from 'react';
import { analyzeFile, AnalysisMode, AnalyzeResult, Issue, listDir, readFile, saveFile, loadState, saveState, chatWithAIStream, getLlmProviders, projectScan, generateReport, ProjectScanResult, isMemoryCrossChat, memoryScopeFor } from '../ipc/client';
import { DiffPayload } from '../App';
import { optimizeCode } from '../ipc/client';
import { openContextMenu, copyText } from '../lib/contextMenu';
import { ModProposal, parseReply } from '../lib/modProposal';
import { modHighlightLines } from '../lib/lineDiff';
import AnalysisView from './AnalysisView';
import AIDock from '../components/chat/AIDock';
import CodeEditor, { CodeEditorApi } from '../components/editor/CodeEditor';
import ResizeHandle from '../components/common/ResizeHandle';
import QuickOpen, { QuickOpenItem, walkWorkspaceFiles } from '../components/common/QuickOpen';
import ShortcutSheet from '../components/common/ShortcutSheet';
import WorkspaceNav, { Workspace } from '../components/nav/WorkspaceNav';
import {
  WorkbenchMode,
  ChatMessage,
  AnalysisStep,
  StepStatus,
  fileName,
  isHigh,
  nowTime,
  sanitizeMessages,
  severityColor,
  chatToMarkdown
} from '../lib/analysis';
import { t, useLang } from '../lib/i18n';

export type { WorkbenchMode };

interface Props {
  mode: WorkbenchMode;
  onModeChange: (m: WorkbenchMode) => void;
  onOpenDiff: (p: DiffPayload) => void;
  analysisMode: AnalysisMode;
  /** 首屏数据(工作区/会话恢复)就绪后回调,页面切换过渡据此收场 */
  onReady?: () => void;
}

/** 编辑器多标签页：每个标签持有独立内容/磁盘基线/扫描结果/文件编码 */
interface EditorTab {
  path: string;
  content: string;
  disk: string;
  result: AnalyzeResult | null;
  encoding?: string;
}

/** 编辑器支持保存/重载的文件编码（Rust 侧 encoding_rs 全量支持，此处列出常用集） */
const ENCODINGS: { value: string; label: string }[] = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'utf-8-bom', label: 'UTF-8 (BOM)' },
  { value: 'utf-16le-bom', label: 'UTF-16 LE' },
  { value: 'utf-16be-bom', label: 'UTF-16 BE' },
  { value: 'gbk', label: 'GBK / GB2312' },
  { value: 'gb18030', label: 'GB18030' },
  { value: 'big5', label: 'Big5 (繁体中文)' },
  { value: 'shift_jis', label: 'Shift_JIS (日语)' },
  { value: 'euc-jp', label: 'EUC-JP (日语)' },
  { value: 'iso-2022-jp', label: 'ISO-2022-JP (日语)' },
  { value: 'euc-kr', label: 'EUC-KR (韩语)' },
  { value: 'windows-1252', label: 'Windows-1252 (西欧)' },
  { value: 'windows-1251', label: 'Windows-1251 (西里尔)' },
  { value: 'windows-1250', label: 'Windows-1250 (中欧)' },
  { value: 'koi8-r', label: 'KOI8-R (俄语)' },
  { value: 'iso-8859-7', label: 'ISO-8859-7 (希腊)' },
  { value: 'ibm866', label: 'IBM866 (西里尔)' }
];

interface Session {
  currentFile: { path: string; content: string } | null;
  result: AnalyzeResult | null;
  messages: ChatMessage[];
  tabs?: EditorTab[];
}

/** 流水线步骤：label/detail 存 i18n key，渲染时经 t() 翻译 */
const PIPELINE: Omit<AnalysisStep, 'done'>[] = [
  { label: 'wb.pipeline.parse', detail: 'wb.pipeline.parseD' },
  { label: 'wb.pipeline.ast', detail: 'wb.pipeline.astD' },
  { label: 'wb.pipeline.rules', detail: 'wb.pipeline.rulesD' },
  { label: 'wb.pipeline.kb', detail: 'wb.pipeline.kbD' },
  { label: 'wb.pipeline.conclude', detail: 'wb.pipeline.concludeD' }
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 可调布局 ----------
/** 布局状态：侧栏/问题面板宽度与折叠，持久化到 localStorage（独立于会话数据 guiState） */
interface LayoutState {
  navWidth: number;
  panelWidth: number;
  navCollapsed: boolean;
  panelCollapsed: boolean;
}
const LAYOUT_KEY = 'mrsliy.layout';
const NAV_DEFAULT = 240;
const NAV_MIN = 180;
const NAV_MAX = 400;
const PANEL_DEFAULT = 320;
const PANEL_MIN = 260;
const PANEL_MAX = 560;
/** 折叠后的窄条宽度 */
const COLLAPSED_W = 48;

const clampW = (v: unknown, min: number, max: number, dft: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dft;
};

function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const p = JSON.parse(raw) || {};
      return {
        navWidth: clampW(p.navWidth, NAV_MIN, NAV_MAX, NAV_DEFAULT),
        panelWidth: clampW(p.panelWidth, PANEL_MIN, PANEL_MAX, PANEL_DEFAULT),
        navCollapsed: Boolean(p.navCollapsed),
        panelCollapsed: Boolean(p.panelCollapsed)
      };
    }
  } catch {
    /* 损坏数据走默认 */
  }
  return { navWidth: NAV_DEFAULT, panelWidth: PANEL_DEFAULT, navCollapsed: false, panelCollapsed: false };
}

export default function Workbench({ mode, onModeChange, onOpenDiff, analysisMode, onReady }: Props) {
  useLang(); // 订阅语言切换，触发重渲染
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWs, setActiveWs] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<{ path: string; content: string } | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [scanning, setScanning] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const [error, setError] = useState('');
  /** 磁盘基线内容：用于未保存标记（dirty = 编辑内容 ≠ 磁盘内容） */
  const [diskContent, setDiskContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  /** 编辑器多标签页（编辑模式）：与 currentFile 双向同步 */
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  /** 在途打开守卫：记录正在 readFile 的路径（小写），防止双击/连点产生重复标签 */
  const openingRef = useRef<Set<string>>(new Set());
  /** 标签栏溢出检测:溢出时收起为下拉面板(▼ n),未溢出正常平铺 */
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  const [tabOverflow, setTabOverflow] = useState(false);
  /** 溢出时平铺区能完整显示的标签数量(其余收进 ▼ 下拉),不溢出时等于 tabs.length */
  const [tabVisibleCount, setTabVisibleCount] = useState(0);
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  /** 各平铺标签元素引用(visibility:hidden 仍保留布局,offsetWidth 可测) */
  const tabElsRef = useRef<(HTMLDivElement | null)[]>([]);
  /** 上次溢出判定(measure 闭包内读最新值用) */
  const tabOverflowRef = useRef(false);
  /** 聊天/扫描中断控制器：停止按钮使用 */
  const chatAbort = useRef<AbortController | null>(null);
  const scanAbort = useRef<AbortController | null>(null);
  const msgId = useRef(1);
  const sessionMap = useRef<Map<string, Session>>(new Map());
  const restoring = useRef(false);
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------- 编辑器行跳转 / 行内 Diff / 快速打开 ----------
  /** 编辑器命令句柄：问题卡片跳转行、AI 修改高亮 */
  const editorApiRef = useRef<CodeEditorApi | null>(null);
  /** 行内 Diff：当前高亮的行号（AI 修改涉及的行，手动编辑/切换文件后清除） */
  const [highlightLines, setHighlightLines] = useState<number[]>([]);
  /** Ctrl+P 快速打开 */
  const [quickOpen, setQuickOpen] = useState(false);
  /** Ctrl+/ 快捷键速查表 */
  const [cheat, setCheat] = useState(false);
  const collectFilesCb = useCallback(
    (root: string) => walkWorkspaceFiles(root, listDir),
    []
  );
  /** 拖拽处理引用最新闭包（onDragDropEvent 只注册一次，见下方赋值） */
  const dropRef = useRef<{ handleDrop: (p: string) => Promise<void>; openFile: (p: string) => Promise<void> } | null>(null);

  // ---------- 可调布局状态 ----------
  const [layout, setLayout] = useState<LayoutState>(loadLayout);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  /** 拖拽中仅更新内存态；mouseup 提交时统一持久化 */
  const persistLayout = useCallback(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutRef.current));
    } catch {
      /* 存储不可用忽略 */
    }
  }, []);
  const patchLayout = useCallback((patch: Partial<LayoutState>) => {
    setLayout((l) => {
      const next = { ...l, ...patch };
      layoutRef.current = next;
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  /** 持久化（防抖 600ms）到 ~/.mr-sliy/gui-state/guiState.json */
  const scheduleSave = useCallback(() => {
    if (!loaded.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const sessions: Record<string, Session> = {};
      sessionMap.current.forEach((v, k) => (sessions[k] = v));
      saveState('guiState', JSON.stringify({ workspaces, activeWs, sessions })).catch(() => {});
    }, 600);
  }, [workspaces, activeWs]);

  /** 标签栏溢出检测:只把放不下的标签收进 ▼ 下拉,放得下的保持平铺。
   *  测量目标为内层 overflow:hidden 包裹层;收起用 visibility 保留占位,
   *  scrollWidth/offsetWidth 恒定 → 判定结果稳定不震荡。 */
  useEffect(() => {
    const el = tabBarRef.current;
    if (!el) {
      setTabOverflow(false);
      setTabVisibleCount(0);
      return;
    }
    const GAP = 4;
    /** 溢出时 ▼ 按钮 + 渐变底需要的预留宽度 */
    const RESERVE = 76;
    const measure = () => {
      // 容器不可见(宽 0,如分析模式/折叠)时跳过,避免误判
      if (el.clientWidth === 0 || tabs.length === 0) return;
      // 全部标签能完整放下 → 平铺
      if (el.scrollWidth <= el.clientWidth + 1) {
        tabOverflowRef.current = false;
        setTabOverflow(false);
        setTabVisibleCount(tabs.length);
        return;
      }
      // 放不下 → 预留 ▼ 按钮宽度,算平铺区能容纳几个(至少 1 个)
      let acc = 0;
      let count = 0;
      for (let i = 0; i < tabs.length; i++) {
        const w = tabElsRef.current[i]?.offsetWidth || 0;
        const next = acc + w + (i > 0 ? GAP : 0);
        if (next > el.clientWidth - RESERVE) break;
        acc = next;
        count = i + 1;
      }
      count = Math.max(1, count);
      // 首次进入溢出时收起打开中的下拉,避免面板指向过期的溢出集合
      if (!tabOverflowRef.current && count < tabs.length) setTabMenuOpen(false);
      tabOverflowRef.current = true;
      setTabOverflow(true);
      setTabVisibleCount(count);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs]);

  /** 会话内容（文件/结果/消息/标签页）变化时写回当前工作区的会话缓存 */
  useEffect(() => {
    if (!activeWs || restoring.current) return;
    sessionMap.current.set(activeWs, { currentFile, result, messages, tabs });
    scheduleSave();
  }, [currentFile, result, messages, tabs, activeWs, scheduleSave]);

  const newId = () => msgId.current++;

  const emptySession = (): Session => ({ currentFile: null, result: null, messages: [] });

  /** 切换激活工作区：保存当前会话 → 恢复目标会话（文件树由 WorkspaceNav 自行加载） */
  const switchTo = async (path: string) => {
    if (path === activeWs) return;
    restoring.current = true;
    if (activeWs) {
      sessionMap.current.set(activeWs, { currentFile, result, messages, tabs });
    }
    setActiveWs(path);
    const s = sessionMap.current.get(path) || emptySession();
    setCurrentFile(s.currentFile);
    setDiskContent(s.currentFile?.content ?? null);
    setResult(s.result);
    setMessages(sanitizeMessages(s.messages));
    setTabs(s.tabs || (s.currentFile ? [{ path: s.currentFile.path, content: s.currentFile.content, disk: s.currentFile.content, result: s.result }] : []));
    setError('');
    restoring.current = false;
    scheduleSave();
  };

  /** 新建工作区：验证目录可读 → 加入列表 → 激活为新对话 */
  const addWorkspace = async (raw: string): Promise<string | null> => {
    const p = raw.trim().replace(/[\\/]+$/, '');
    if (!p) return t('wb.needPath');
    if (workspaces.some((w) => w.path.toLowerCase() === p.toLowerCase())) return t('wb.dupPath');
    try {
      await listDir(p);
    } catch {
      return t('wb.badPath');
    }
    const ws: Workspace = { path: p, name: fileName(p) };
    setWorkspaces((w) => [...w, ws]);
    sessionMap.current.set(p, {
      currentFile: null,
      result: null,
      messages: [
        {
          id: newId(),
          role: 'assistant',
          text: t('wb.wsCreated', { name: ws.name }),
          time: nowTime()
        }
      ]
    });
    restoring.current = true;
    setActiveWs(p);
    setCurrentFile(null);
    setDiskContent(null);
    setResult(null);
    setTabs([]);
    setMessages(sessionMap.current.get(p)!.messages);
    setError('');
    restoring.current = false;
    scheduleSave();
    return null;
  };

  const removeWorkspace = (p: string) => {
    if (workspaces.find((w) => w.path === p)?.locked) return; // 锁定中不可移除
    sessionMap.current.delete(p);
    const next = workspaces.filter((w) => w.path !== p);
    setWorkspaces(next);
    if (p === activeWs) {
      if (next.length) switchTo(next[0].path);
      else {
        setActiveWs(null);
        setCurrentFile(null);
        setDiskContent(null);
        setResult(null);
        setTabs([]);
        setMessages([]);
      }
    }
    scheduleSave();
  };

  /** 锁定/解锁工作区：锁定后不可移除，会话内容只读（防误删误操作） */
  const toggleLock = (p: string) => {
    setWorkspaces((ws) => ws.map((w) => (w.path === p ? { ...w, locked: !w.locked } : w)));
    scheduleSave();
  };

  /** 会话重命名：设置显示别名；alias 为空串时恢复目录默认名 */
  const renameWorkspace = (p: string, alias: string) => {
    setWorkspaces((ws) => ws.map((w) => (w.path === p ? { ...w, alias: alias || undefined } : w)));
    scheduleSave();
  };

  /** 当前会话是否锁定 */
  const activeLocked = !!workspaces.find((w) => w.path === activeWs)?.locked;

  /** 未保存标记：编辑内容 ≠ 磁盘内容 */
  const dirty = !!currentFile && currentFile.content !== diskContent;

  /** 以文件当前编码写盘：优先标签页记录的编码；无记录（旧会话）时按磁盘文件自动检测并缓存——"自动识别、原格式保存" */
  const savePreservingEncoding = async (path: string, content: string) => {
    let enc = tabs.find((x) => x.path === path)?.encoding;
    if (!enc) {
      try {
        enc = (await readFile(path)).encoding;
        setTabs((t) => t.map((x) => (x.path === path ? { ...x, encoding: enc } : x)));
      } catch {
        enc = undefined; // 读不到磁盘文件时回落 UTF-8
      }
    }
    await saveFile(path, content, enc);
  };

  /** 保存编辑内容到磁盘文件 */
  const saveToDisk = async () => {
    if (!currentFile || saving || activeLocked) return;
    setSaving(true);
    try {
      await savePreservingEncoding(currentFile.path, currentFile.content);
      setDiskContent(currentFile.content);
      setTabs((t) => t.map((x) => (x.path === currentFile.path ? { ...x, disk: currentFile.content, content: currentFile.content } : x)));
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1600);
    } catch (e) {
      setError(t('wb.saveFail', { msg: (e as Error).message || t('wb.cannotWrite') }));
    } finally {
      setSaving(false);
    }
  };

  /** 编辑内容更新：currentFile 与对应标签页同步（手动编辑后清除行内 Diff 高亮） */
  const updateContent = (v: string) => {
    setHighlightLines([]);
    setCurrentFile((f) => {
      if (!f) return f;
      setTabs((t) => t.map((x) => (x.path === f.path ? { ...x, content: v } : x)));
      return { ...f, content: v };
    });
  };

  /** 当前文件编码（未记录过视为 UTF-8） */
  const currentEncoding = (currentFile && tabs.find((x) => x.path === currentFile.path)?.encoding) || 'utf-8';

  /** 切换文件编码：未修改时按所选编码重读文件（相当于"以编码重新打开"），已修改时仅作为保存编码 */
  const changeEncoding = async (enc: string) => {
    if (!currentFile) return;
    const target = currentFile.path;
    setTabs((t) => t.map((x) => (x.path === target ? { ...x, encoding: enc } : x)));
    if (currentFile.content !== diskContent) return;
    try {
      const { content } = await readFile(target, enc);
      setCurrentFile((f) => (f && f.path === target ? { ...f, content } : f));
      setDiskContent(content);
      setTabs((t) => t.map((x) => (x.path === target ? { ...x, content, disk: content } : x)));
      setHighlightLines([]);
    } catch {
      setError(t('wb.readFail'));
    }
  };

  /** 定时自动扫描：激活工作区开启定时后，按间隔触发当前文件的静默扫描 */
  useEffect(() => {
    const ws = workspaces.find((w) => w.path === activeWs);
    const minutes = ws?.scheduleMinutes || 0;
    if (!minutes || mode !== 'analysis') return;
    const timer = setInterval(() => {
      if (!scanning && !activeLocked && currentFile) {
        void runScan(t('wb.scheduledScan', { n: minutes, file: fileName(currentFile.path) }));
      }
    }, minutes * 60 * 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, activeWs, mode, scanning, activeLocked, currentFile]);

  /** 门控确认：将 AI 建议的代码修改应用到当前文件（定位替换并保存），返回错误信息或 null（成功） */
  const applyCodeChange = async (originalCode: string, modifiedCode: string): Promise<string | null> => {
    if (!currentFile) return t('wb.needFile');
    if (activeLocked) return t('wb.lockedNoEdit');
    const content = currentFile.content;
    const norm = (s: string) => s.replace(/\r\n/g, '\n');
    let next: string | null = null;
    let hitOffset = -1;
    let base = content;
    const i1 = content.indexOf(originalCode);
    if (i1 >= 0) {
      hitOffset = i1;
      next = content.slice(0, i1) + modifiedCode + content.slice(i1 + originalCode.length);
    } else {
      // 行尾风格不一致（CRLF/LF）时按归一化匹配（整文件统一为 LF）
      const nc = norm(content);
      const i2 = nc.indexOf(norm(originalCode));
      if (i2 >= 0) {
        hitOffset = i2;
        base = nc;
        next = nc.slice(0, i2) + norm(modifiedCode) + nc.slice(i2 + norm(originalCode).length);
      }
    }
    if (next === null) return t('wb.locateFail');
    // 行内 Diff：标记本次修改涉及的行（手动编辑或切换文件时自动清除）
    setHighlightLines(modHighlightLines(originalCode, modifiedCode, hitOffset, base));
    const updated = { ...currentFile, content: next };
    setCurrentFile(updated);
    setTabs((t) => t.map((x) => (x.path === updated.path ? { ...x, content: updated.content, disk: updated.content } : x)));
    try {
      await savePreservingEncoding(updated.path, updated.content);
      setDiskContent(updated.content);
      return null;
    } catch (e) {
      return t('wb.writeFail', { msg: (e as Error).message || t('wb.unknownErr') });
    }
  };

  /** 打开文件；line 存在时（全文搜索/树过滤/问题卡片）打开后定位到该行 */
  const openFile = async (
    node: { path: string; name?: string; is_dir?: boolean },
    line?: number,
    opts?: { analyze?: boolean }
  ) => {
    if (!activeWs) return;
    if (activeLocked) {
      setError(t('wb.lockedUnlockFirst'));
      return;
    }
    setError('');
    setHighlightLines([]);
    // 过滤命中/搜索直达：打开后自动切到分析模式（编辑模式的常规文件树点击仍留在编辑器）
    if (opts?.analyze && mode === 'editor') onModeChange('analysis');
    // 已在标签页中打开 → 直接激活（保留编辑内容与扫描结果）
    const existing = tabs.find((t) => t.path.toLowerCase() === node.path.toLowerCase());
    if (existing) {
      setCurrentFile({ path: existing.path, content: existing.content });
      setDiskContent(existing.disk);
      setResult(existing.result);
      if (line) setTimeout(() => editorApiRef.current?.revealLine(line), 80);
      return;
    }
    // 双击/连点防抖：查重发生在 await 之前，两次快速调用都会通过上面的
    // existing 检查；不加在途守卫的话，await 返回后会各追加一个标签页，
    // 造成同一文件"多开"出多个标签。
    const pathKey = node.path.toLowerCase();
    if (openingRef.current.has(pathKey)) return;
    openingRef.current.add(pathKey);
    try {
      const { content, encoding } = await readFile(node.path);
      setCurrentFile({ path: node.path, content });
      setDiskContent(content);
      setResult(null);
      // 提交时再查重：在途期间标签可能已由其他入口加入
      setTabs((t) =>
        t.some((x) => x.path.toLowerCase() === pathKey)
          ? t
          : [...t, { path: node.path, content, disk: content, result: null, encoding }]
      );
      setMessages((m) => [
        ...m,
        {
          id: newId(),
          role: 'assistant',
          text: t('wb.fileOpened', { file: fileName(node.path) }),
          time: nowTime()
        }
      ]);
      if (line) setTimeout(() => editorApiRef.current?.revealLine(line), 80);
    } catch {
      setError(t('wb.readFail'));
    } finally {
      openingRef.current.delete(pathKey);
    }
  };

  /** 切换编辑器标签页：同步内容/基线/结果 */
  const switchTab = (path: string) => {
    const t = tabs.find((x) => x.path === path);
    if (!t) return;
    setHighlightLines([]);
    setCurrentFile({ path: t.path, content: t.content });
    setDiskContent(t.disk);
    setResult(t.result);
  };

  /** 关闭标签页：活动标签关闭时切换到相邻标签 */
  const closeTab = (path: string) => {
    const idx = tabs.findIndex((t) => t.path === path);
    const next = tabs.filter((t) => t.path !== path);
    setTabs(next);
    if (currentFile?.path === path) {
      const fallback = next[Math.min(idx, next.length - 1)];
      if (fallback) {
        setCurrentFile({ path: fallback.path, content: fallback.content });
        setDiskContent(fallback.disk);
        setResult(fallback.result);
      } else {
        setCurrentFile(null);
        setDiskContent(null);
        setResult(null);
      }
    }
  };

  // ---------- 全局快捷键：Ctrl+P 快速打开 / Ctrl+/ 速查表 ----------
  // 捕获阶段监听：优先于任何组件的 keydown/stopPropagation，保证全局快捷键始终可达
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        setQuickOpen(true);
      } else if (e.ctrlKey && e.key === '/') {
        e.preventDefault();
        setCheat((v) => !v);
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  // ---------- 拖拽打开文件 / 文件夹（Tauri 桌面端）----------
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const fn = await getCurrentWebview().onDragDropEvent((ev) => {
          if (ev.payload.type !== 'drop') return;
          for (const p of ev.payload.paths || []) void dropRef.current?.handleDrop(p);
        });
        if (cancelled) fn();
        else unlisten = fn;
      } catch {
        /* 非 Tauri 环境 / API 不可用 */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  /** 拖拽落点处理：目录→添加工作区；文件→所属工作区内打开（无归属时父目录入列再打开）。
      每次渲染后刷新引用，保证拖拽回调读到最新的工作区/激活会话状态 */
  useEffect(() => {
    const openDroppedFile = async (p: string) => {
      await openFile({ path: p, name: fileName(p), is_dir: false });
    };
    const handleDrop = async (p: string) => {
      let isDir = false;
      try {
        await listDir(p);
        isDir = true;
      } catch {
        /* 非目录 → 按文件处理 */
      }
      if (isDir) {
        const err = await addWorkspace(p);
        if (err) setError(err);
        return;
      }
      const norm = p.replace(/\\/g, '/').toLowerCase();
      const hit = workspaces.find((w) => {
        const wp = w.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        return norm.startsWith(wp + '/');
      });
      if (hit) {
        if (hit.path !== activeWs) await switchTo(hit.path);
        await openDroppedFile(p);
        return;
      }
      const parent = p.replace(/[\\/][^\\/]+$/, '');
      const err = await addWorkspace(parent);
      if (err) {
        setError(err);
        return;
      }
      // 等新工作区的状态提交渲染后，用最新闭包打开文件
      await sleep(0);
      await dropRef.current?.openFile(p);
    };
    dropRef.current = { handleDrop, openFile: openDroppedFile };
  });

  /** 执行分析：分析模式下以对话流 + 流水线时间线呈现（步骤状态：pending/active/done + 耗时）；支持中途停止 */
  const runScan = async (userText?: string) => {
    if (!currentFile || scanning) return;
    if (activeLocked) {
      setError(t('wb.lockedUnlockFirst'));
      return;
    }
    setScanning(true);
    setError('');
    const uid = newId();
    const aid = newId();
    const started = Date.now();
    setMessages((m) => [
      ...m,
      { id: uid, role: 'user', text: userText || t('wb.analyzeFile', { file: fileName(currentFile.path) }), time: nowTime() },
      {
        id: aid,
        role: 'assistant',
        time: nowTime(),
        steps: PIPELINE.map((s) => ({ label: t(s.label), detail: t(s.detail), done: false, status: 'pending' as const }))
      }
    ]);
    const patch = (fn: (steps: AnalysisStep[]) => AnalysisStep[]) =>
      setMessages((m) => m.map((msg) => (msg.id === aid ? { ...msg, steps: fn(msg.steps || []) } : msg)));
    const mark = (i: number, status: StepStatus, ms?: number) =>
      patch((ss) => ss.map((s, j) => (j === i ? { ...s, status, done: status === 'done', ms: ms ?? s.ms } : s)));

    const controller = new AbortController();
    scanAbort.current = controller;
    try {
      const req = analyzeFile(currentFile.path, currentFile.content, analysisMode, controller.signal);
      // 前四步按节奏点亮，最后一步等待真实请求返回
      for (let i = 0; i < PIPELINE.length - 1; i++) {
        mark(i, 'active');
        const t = Date.now();
        await sleep(420);
        mark(i, 'done', Date.now() - t);
      }
      const last = PIPELINE.length - 1;
      mark(last, 'active');
      const t4 = Date.now();
      const r = await req;
      mark(last, 'done', Math.max(Date.now() - t4, 420));
      setResult(r);
      // 同步结果到对应标签页
      setTabs((t) => t.map((x) => (x.path === currentFile.path ? { ...x, result: r } : x)));
      setMessages((m) =>
        m.map((msg) =>
          msg.id === aid
            ? {
                ...msg,
                steps: PIPELINE.map((s, j) => ({
                  label: t(s.label),
                  detail: t(s.detail),
                  done: true,
                  status: 'done' as const,
                  ms: msg.steps?.[j]?.ms
                })),
                issues: r.issues,
                total: r.totalIssues,
                lang: r.language,
                tag: analysisMode === 'cloud' ? 'cloud' : 'local',
                elapsed: Date.now() - started,
                llm: r.llmUsage
                  ? {
                      tokens: r.llmUsage.totalTokens || 0,
                      cacheHitRate: r.llmUsage.cacheHitRate ?? null,
                      requests: r.llmUsage.requests || 0,
                      model: r.llmUsage.model || null
                    }
                  : undefined
              }
            : msg
        )
      );
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      patch((ss) => ss.map((s) => (s.status === 'active' ? { ...s, status: 'done', done: true } : s)));
      setMessages((m) =>
        m.map((msg) =>
          msg.id === aid
            ? {
                ...msg,
                error: aborted ? t('wb.scanStopped') : t('wb.analyzeFail'),
                elapsed: Date.now() - started
              }
            : msg
        )
      );
      if (!aborted) setError(t('wb.scanFail'));
    } finally {
      scanAbort.current = null;
      setScanning(false);
    }
  };

  /** 中断当前扫描/流式回复（停止按钮） */
  const stopAll = () => {
    chatAbort.current?.abort();
    scanAbort.current?.abort();
  };

  /** 本地规则兜底回复（未配置大模型或调用失败时） */
  const cannedReply = (): string => {
    if (!currentFile) {
      return t('wb.cannedNoFile');
    }
    if (!result) {
      return t('wb.cannedNoResult', { file: fileName(currentFile.path) });
    }
    const high = (result.issues || []).filter((i) => isHigh(i.severity)).length;
    return t('wb.cannedSummary', { file: fileName(currentFile.path), total: result.totalIssues, high });
  };

  /** 随聊天注入的工作区上下文：当前文件 + 扫描结果概览 */
  const chatContext = () => ({
    fileName: currentFile ? fileName(currentFile.path) : undefined,
    language: result?.language,
    totalIssues: result?.totalIssues,
    topIssues: result?.issues?.slice(0, 5).map((i) => ({ type: i.issueType, message: i.message, line: i.line }))
  });

  /** 分析模式自由消息：配置了大模型即走真实流式对话（与分析模式无关），否则本地兜底 */
  const sendChat = async (text: string) => {
    if (!text.trim() || scanning) return;
    if (activeLocked) {
      setError(t('wb.lockedUnlockFirst'));
      return;
    }
    const uid = newId();
    const aid = newId();
    const started = Date.now();
    setMessages((m) => [
      ...m,
      { id: uid, role: 'user', text, time: nowTime() },
      { id: aid, role: 'assistant', typing: true, time: nowTime() }
    ]);

    try {
      const prov = await getLlmProviders();
      if (prov.active) {
        // 完整历史交给服务端（服务端负责压缩早期对话为摘要）；本地只做防失控截断
        const hist = [
          ...messages.filter((x) => (x.role === 'user' || x.role === 'assistant') && x.text && !x.typing && !x.error).slice(-40).map((x) => ({ role: x.role, content: (x.raw ?? x.text)!.slice(0, 2000) })),
          { role: 'user' as const, content: text }
        ];
        const controller = new AbortController();
        chatAbort.current = controller;
        // 流式：先移除打字动画，创建流式气泡逐字填充
        setMessages((m) => m.map((msg) => (msg.id === aid ? { ...msg, typing: false, text: '', streaming: true } : msg)));
        const res = await chatWithAIStream(hist, chatContext(), {
          signal: controller.signal,
          onDelta: (d) => setMessages((m) => m.map((msg) => (msg.id === aid ? { ...msg, text: (msg.text || '') + d } : msg))),
          // 跨对话记忆关闭时按工作区隔离记忆;开启时空串=全局
          memoryScope: memoryScopeFor(isMemoryCrossChat(), activeWs)
        });
        const raw = res.reply;
        const parsed = parseReply(raw);
        const note = parsed.parseFailed ? '\n\n' + t('wb.modParseFail') : '';
        // 用量换算：与服务端 scanRoutes 的 cacheHitRate 口径一致
        const u = (res.usage || null) as { totalTokens?: number; cacheHitTokens?: number; cacheMissTokens?: number } | null;
        const cacheTotal = u ? (u.cacheHitTokens || 0) + (u.cacheMissTokens || 0) : 0;
        setMessages((m) =>
          m.map((msg) =>
            msg.id === aid
              ? {
                  ...msg,
                  streaming: false,
                  text: parsed.text + note,
                  raw,
                  mod: parsed.mod,
                  modStatus: parsed.mod ? 'pending' : undefined,
                  elapsed: Date.now() - started,
                  llm:
                    u && (u.totalTokens || 0) > 0
                      ? {
                          tokens: u.totalTokens || 0,
                          cacheHitRate: cacheTotal > 0 ? Math.round(((u.cacheHitTokens || 0) / cacheTotal) * 1000) / 10 : null,
                          requests: 1,
                          model: prov.active
                        }
                      : undefined
                }
              : msg
          )
        );
        return;
      }
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      setMessages((m) =>
        m.map((msg) =>
          msg.id === aid
            ? {
                ...msg,
                streaming: false,
                typing: false,
                elapsed: Date.now() - started,
                text: aborted
                  ? (msg.text || '') + '\n\n' + t('wb.stoppedGen')
                  : (msg.text || '') || cannedReply() + '\n\n' + t('wb.llmFallback')
              }
            : msg
        )
      );
      return;
    } finally {
      chatAbort.current = null;
    }

    // 未配置大模型：本地轻量提示
    setMessages((m) =>
      m.map((msg) => (msg.id === aid ? { ...msg, typing: false, text: cannedReply() } : msg))
    );
  };

  /** 门控动作：应用/取消/换思路/撤销（主会话助手气泡内的代码修改卡片） */
  const onModAction = async (action: 'apply' | 'reject' | 'more' | 'undo' | 'verify', msgId: number, mod: ModProposal) => {
    if (action === 'reject') {
      setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, modStatus: 'rejected' } : x)));
      return;
    }
    if (action === 'more') {
      setMessages((m) => m.map((x) => (x.modStatus === 'pending' ? { ...x, modStatus: 'superseded' } : x)));
      void sendChat(t('wb.moreAsk'));
      return;
    }
    if (action === 'verify') {
      void runScan(t('wb.verifyAsk'));
      return;
    }
    if (action === 'undo') {
      const msg = messages.find((x) => x.id === msgId);
      if (msg?.modPrevContent === undefined) {
        setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, applyError: t('wb.noBackup') } : x)));
        return;
      }
      if (!currentFile) return;
      const restored = { ...currentFile, content: msg.modPrevContent };
      setCurrentFile(restored);
      setTabs((t) => t.map((x) => (x.path === restored.path ? { ...x, content: restored.content, disk: restored.content } : x)));
      try {
        await savePreservingEncoding(restored.path, restored.content);
        setDiskContent(restored.content);
        setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, modStatus: 'undone' } : x)));
      } catch (e) {
        setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, applyError: t('wb.undoFail', { msg: (e as Error).message }) } : x)));
      }
      return;
    }
    // apply
    let err: string | null;
    let prevContent: string | undefined;
    if (!currentFile) err = t('wb.needFile');
    else if (activeLocked) err = t('wb.lockedNoEdit');
    else {
      const content = currentFile.content;
      prevContent = content;
      const norm = (s: string) => s.replace(/\r\n/g, '\n');
      let next: string | null = null;
      const i1 = content.indexOf(mod.originalCode);
      if (i1 >= 0) {
        next = content.slice(0, i1) + mod.modifiedCode + content.slice(i1 + mod.originalCode.length);
      } else {
        const nc = norm(content);
        const no = norm(mod.originalCode);
        const i2 = nc.indexOf(no);
        if (i2 >= 0) next = nc.slice(0, i2) + norm(mod.modifiedCode) + nc.slice(i2 + no.length);
      }
      if (next === null) {
        err = t('wb.locateFail');
      } else {
        const updated = { ...currentFile, content: next };
        setCurrentFile(updated);
        setTabs((t) => t.map((x) => (x.path === updated.path ? { ...x, content: updated.content, disk: updated.content } : x)));
        try {
          await savePreservingEncoding(updated.path, updated.content);
          setDiskContent(updated.content);
          err = null;
        } catch (e) {
          err = t('wb.writeFail', { msg: (e as Error).message || t('wb.unknownErr') });
        }
      }
    }
    setMessages((m) =>
      m.map((x) =>
        x.id === msgId
          ? { ...x, modStatus: err ? 'failed' : 'applied', applyError: err ?? undefined, modPrevContent: err ? undefined : prevContent }
          : x
      )
    );
  };

  /** 项目级扫描：聚合检测整个工作区目录（结果以卡片消息呈现，支持一键导出报告） */
  const runProjectScan = async () => {
    if (!activeWs || scanning) return;
    if (activeLocked) {
      setError(t('wb.lockedUnlockFirst'));
      return;
    }
    const aid = newId();
    setMessages((m) => [
      ...m,
      { id: aid, role: 'assistant', typing: true, time: nowTime(), text: t('wb.scanningProject', { file: fileName(activeWs) }) }
    ]);
    try {
      const r = await projectScan(activeWs, analysisMode);
      setMessages((m) =>
        m.map((msg) => (msg.id === aid ? { ...msg, typing: false, text: '', projScan: r } : msg))
      );
    } catch (e) {
      setMessages((m) =>
        m.map((msg) => (msg.id === aid ? { ...msg, typing: false, text: t('wb.projScanFail', { msg: (e as Error).message || t('wb.unknownErr') }) } : msg))
      );
    }
  };

  /** 导出项目扫描报告（HTML 落盘 ~/.mr-sliy/reports/） */
  const exportReport = async (r: ProjectScanResult) => {
    const aid = newId();
    setMessages((m) => [
      ...m,
      { id: aid, role: 'assistant', typing: true, time: nowTime(), text: t('wb.generatingReport') }
    ]);
    try {
      const out = await generateReport({
        title: fileName(r.projectPath),
        projectPath: r.projectPath,
        summary: {
          totalFiles: r.totalFiles,
          scannedFiles: r.scannedFiles,
          failedFiles: r.failedFiles,
          totalIssues: r.totalIssues,
          durationMs: r.durationMs
        },
        files: r.results,
        format: 'html'
      });
      setMessages((m) =>
        m.map((msg) =>
          msg.id === aid
            ? { ...msg, typing: false, text: t('wb.reportDone', { path: out.path }) }
            : msg
        )
      );
    } catch (e) {
      setMessages((m) =>
        m.map((msg) => (msg.id === aid ? { ...msg, typing: false, text: t('wb.reportFail', { msg: (e as Error).message }) } : msg))
      );
    }
  };

  /** 导出当前会话对话为 Markdown（Tauri 弹保存框落盘；浏览器调试走 Blob 下载） */
  const exportChat = async () => {
    if (!messages.length) {
      setError(t('wb.exportChatEmpty'));
      return;
    }
    const ws = workspaces.find((w) => w.path === activeWs);
    const title = ws?.alias || (activeWs ? fileName(activeWs) : t('an.title'));
    const md = chatToMarkdown(title, messages);
    const fname = `mrsliy-chat-${new Date().toISOString().slice(0, 10)}.md`;
    try {
      if ('__TAURI_INTERNALS__' in window) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const target = await save({ defaultPath: fname, filters: [{ name: 'Markdown', extensions: ['md'] }] });
        if (!target) return;
        await saveFile(target, md);
        setMessages((m) => [...m, { id: newId(), role: 'assistant', text: t('wb.exportChatDone', { path: target }), time: nowTime() }]);
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
        a.download = fname;
        a.click();
        URL.revokeObjectURL(a.href);
        setMessages((m) => [...m, { id: newId(), role: 'assistant', text: t('wb.exportChatDone', { path: fname }), time: nowTime() }]);
      }
    } catch (e) {
      setError(t('wb.exportChatFail', { msg: (e as Error).message || t('wb.unknownErr') }));
    }
  };

  const fix = async (issue: Issue) => {
    if (!currentFile) return;
    if (activeLocked) {
      setError(t('wb.lockedUnlockFirst'));
      return;
    }
    setFixing(issue.issueType);
    try {
      const opt = await optimizeCode(
        currentFile.content,
        currentFile.path,
        result?.language || 'javascript',
        issue.issueType,
        issue.message,
        issue.line
      );
      // 空结果不进入对比页（全删零增的 diff 无意义）
      if (!opt?.optimizedCode) throw new Error(t('wb.optimizeEmpty'));
      onOpenDiff({ filePath: currentFile.path, language: result?.language || 'javascript', originalCode: currentFile.content, result: opt });
    } catch (e) {
      setError((e as Error).message || t('wb.optimizeFail'));
    } finally {
      setFixing(null);
    }
  };

  // 启动时从状态文件恢复工作区列表、激活会话与各会话内容
  useEffect(() => {
    (async () => {
      let state: { workspaces?: Workspace[]; activeWs?: string | null; sessions?: Record<string, Session> } | null = null;
      try {
        const raw = await loadState('guiState');
        if (raw) state = JSON.parse(raw);
      } catch {
        state = null;
      }
      const ws = [...(state?.workspaces || [])];
      // 迁移旧版 localStorage 数据
      if (!ws.length) {
        try {
          const legacy = JSON.parse(localStorage.getItem('mrsliy.workspaces') || '[]');
          if (Array.isArray(legacy) && legacy.length) ws.push(...legacy);
        } catch { /* 忽略 */ }
      }
      restoring.current = true;
      if (ws.length) {
        for (const [k, v] of Object.entries(state?.sessions || {})) {
          sessionMap.current.set(k, { ...v, messages: sanitizeMessages(v.messages || []) });
        }
        setWorkspaces(ws);
        const target = ws.find((w) => w.path === state?.activeWs)?.path || ws[0].path;
        setActiveWs(target);
        const s = sessionMap.current.get(target);
        if (s) {
          setCurrentFile(s.currentFile);
          setDiskContent(s.currentFile?.content ?? null);
          setResult(s.result);
          setMessages(s.messages);
          setTabs(s.tabs || (s.currentFile ? [{ path: s.currentFile.path, content: s.currentFile.content, disk: s.currentFile.content, result: s.result }] : []));
        }
      }
      restoring.current = false;
      loaded.current = true;
      onReady?.();
    })();
  }, []);

  const nav = (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
      <WorkspaceNav
        workspaces={workspaces}
        activeWs={activeWs}
        currentFile={currentFile}
        loadDir={listDir}
        onAdd={addWorkspace}
        onRemove={removeWorkspace}
        onToggleLock={toggleLock}
        onRename={renameWorkspace}
        onArchive={(p) => {
          setWorkspaces((ws) => ws.map((w) => (w.path === p ? { ...w, archived: !w.archived } : w)));
          scheduleSave();
        }}
        onSchedule={(p, minutes) => {
          setWorkspaces((ws) => ws.map((w) => (w.path === p ? { ...w, scheduleMinutes: minutes } : w)));
          scheduleSave();
        }}
        onProjectScan={runProjectScan}
        onSelect={(p) => switchTo(p)}
        onOpenFile={openFile}
        collapsed={layout.navCollapsed}
        onToggleCollapse={() => patchLayout({ navCollapsed: !layoutRef.current.navCollapsed })}
      />
      {!layout.navCollapsed && (
        <ResizeHandle
          dir="right"
          width={layout.navWidth}
          min={NAV_MIN}
          max={NAV_MAX}
          onWidth={(w) => setLayout((l) => ({ ...l, navWidth: w }))}
          onCommit={persistLayout}
          onReset={() => patchLayout({ navWidth: NAV_DEFAULT, navCollapsed: false })}
        />
      )}
    </div>
  );

  /** 聊天/扫描进行中（用于停止按钮） */
  const busy = scanning || messages.some((x) => x.streaming || x.typing);

  if (mode === 'analysis') {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: layout.navCollapsed ? `${COLLAPSED_W}px 1fr` : `${layout.navWidth}px 1fr`, gap: 16, height: '100%' }}>
        {nav}
        <AnalysisView
          currentFile={currentFile}
          messages={messages}
          scanning={scanning}
          fixing={fixing}
          error={error}
          locked={activeLocked}
          onSend={(t) => void sendChat(t)}
          onModAction={onModAction}
          onExportReport={exportReport}
          onExportChat={exportChat}
          onStop={stopAll}
          busy={busy}
          onScan={() => runScan()}
          onFix={fix}
        />
      </div>
    );
  }

  const panelCol = layout.panelCollapsed ? `${COLLAPSED_W}px` : `${layout.panelWidth}px`;
  return (
    // 中栏必须 minmax(0,1fr):默认 1fr 的 min-content 会被长文件路径(不换行)撑大,
    // 问题栏展开时 grid 整体溢出,中栏被压扁、头部按钮被 overflow:hidden 裁掉
    <div style={{ display: 'grid', gridTemplateColumns: `${layout.navCollapsed ? `${COLLAPSED_W}px` : `${layout.navWidth}px`} minmax(0, 1fr) ${panelCol}`, gap: 16, height: '100%', position: 'relative' }}>
      {nav}

      {/* 中栏 · 编辑器（编辑模式主区域）：彩色语法高亮 + 可编辑任意行 */}
      <section className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--border-hairline)', minWidth: 0 }}>
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentFile?.path || t('wb.noFile')}
          </span>
          {dirty && (
            <span title={t('wb.unsaved')} style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', flex: 'none' }} />
          )}
          {activeLocked && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>· {t('wb.locked')}</span>}
          <div style={{ flex: 1 }} />
          {currentFile && (
            <select
              value={currentEncoding}
              onChange={(e) => void changeEncoding(e.target.value)}
              title={t('wb.encoding')}
              style={{ padding: '3px 6px', fontSize: 11.5, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-recessed)', color: 'var(--text-primary)', flexShrink: 0 }}
            >
              {ENCODINGS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
              {/* 自动检测出列表外编码（如 windows-1254）时追加显示，保证与保存行为一致 */}
              {!ENCODINGS.some((o) => o.value === currentEncoding) && (
                <option value={currentEncoding}>{currentEncoding.toUpperCase()}</option>
              )}
            </select>
          )}
          {currentFile && (
            <button
              className="btn-ghost"
              style={{ fontSize: 12.5, flexShrink: 0 }}
              onClick={saveToDisk}
              disabled={!dirty || saving || activeLocked}
              title={activeLocked ? t('wb.locked') : `${t('wb.save')} (Ctrl+S)`}
            >
              {saving ? t('wb.saving') : savedFlash ? `${t('wb.saved')} ✓` : dirty ? t('wb.saveChanges') : t('wb.saved')}
            </button>
          )}
          <button className="btn-primary" style={{ flexShrink: 0 }} onClick={() => runScan()} disabled={!currentFile || scanning || activeLocked} title={activeLocked ? t('wb.locked') : undefined}>
            {scanning ? t('wb.scanning') : t('wb.scanFile')}
          </button>
        </div>
        {/* 多标签页：同一会话可同时打开多个文件;溢出时收起为 ▼ 下拉面板选择。
            外层不裁剪(下拉面板要伸出容器之外);内层包裹层 overflow:hidden 只裁平铺标签。 */}
        {tabs.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--border-hairline)', position: 'relative', minHeight: 34 }}>
            <div
              ref={tabBarRef}
              style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', flex: 1, minWidth: 0 }}
            >
            {tabs.map((tab, i) => {
              const active = currentFile?.path === tab.path;
              const tabDirty = tab.content !== tab.disk;
              // 部分折叠:只隐藏平铺区放不下的标签(visibility 保留占位,测量值稳定)
              const hidden = tabOverflow && i >= tabVisibleCount;
              return (
                <div
                  key={tab.path}
                  ref={(n) => {
                    tabElsRef.current[i] = n;
                  }}
                  onClick={() => switchTab(tab.path)}
                  onContextMenu={(e) =>
                    openContextMenu(e, [
                      { label: t('wb.closeTab'), onClick: () => closeTab(tab.path) },
                      { label: t('nav.copyFilePath'), onClick: () => copyText(tab.path) }
                    ])
                  }
                  style={{
                    display: 'flex',
                    // 必须用 visibility(保留占位)。display:none 会塌空内容导致
                    // scrollWidth 归零 → 判定翻转 → ResizeObserver 无限震荡卡死
                    visibility: hidden ? 'hidden' : 'visible',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 10px',
                    borderRadius: 8,
                    fontSize: 12,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    maxWidth: 180,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    background: active ? 'var(--accent-tint)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-muted)',
                    fontWeight: active ? 600 : 400
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{fileName(tab.path)}</span>
                  {tabDirty && <span title={t('wb.tabUnsaved')} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', flex: 'none' }} />}
                  <span
                    title={t('win.close')}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.path);
                    }}
                    style={{ opacity: 0.55, padding: '0 2px', flex: 'none' }}
                  >
                    ×
                  </span>
                </div>
              );
            })}
            </div>

            {/* 溢出指示与下拉面板:列出全部已开文件供选择(挂外层,不被裁剪)。
                zIndex 必须显式高于编辑器输入层(z-index:20):覆盖层带 transform 自成
                堆叠上下文,面板的 z-index 被困在内部;不提升的话整层被编辑器
                textarea 盖住——面板可见但点击全部落空 */}
            {tabOverflow && (
              <div style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', background: 'linear-gradient(90deg, transparent, var(--bg-card) 28%)', paddingLeft: 22, zIndex: 30 }}>
                <div style={{ position: 'relative' }}>
                  <button
                    className="btn-ghost"
                    title={t('wb.tabOverflow')}
                    onClick={() => setTabMenuOpen((v) => !v)}
                    style={{ fontSize: 11.5, padding: '3px 9px', display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    {tabMenuOpen ? '▲' : '▼'} {tabs.length - tabVisibleCount}
                  </button>
                  {tabMenuOpen && (
                    <div
                      className="selectable"
                      style={{
                        position: 'absolute',
                        right: 0,
                        top: 'calc(100% + 6px)',
                        zIndex: 60,
                        minWidth: 240,
                        maxHeight: 320,
                        overflowY: 'auto',
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border-hairline)',
                        borderRadius: 10,
                        boxShadow: 'var(--menu-shadow)',
                        padding: 5
                      }}
                    >
                      {tabs.map((tab) => {
                        const active = currentFile?.path === tab.path;
                        const tabDirty = tab.content !== tab.disk;
                        return (
                          <div
                            key={tab.path}
                            onClick={() => {
                              switchTab(tab.path);
                              setTabMenuOpen(false);
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 7,
                              padding: '6px 9px',
                              borderRadius: 7,
                              fontSize: 12,
                              cursor: 'pointer',
                              background: active ? 'var(--accent-tint)' : 'transparent',
                              color: active ? 'var(--accent)' : 'var(--text-primary)',
                              fontWeight: active ? 600 : 400
                            }}
                          >
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={tab.path}>
                              {fileName(tab.path)}
                            </span>
                            {tabDirty && <span title={t('wb.tabUnsaved')} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', flex: 'none' }} />}
                            <span
                              title={t('win.close')}
                              onClick={(e) => {
                                e.stopPropagation();
                                closeTab(tab.path);
                              }}
                              style={{ opacity: 0.55, padding: '0 3px', flex: 'none' }}
                            >
                              ×
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 0, display: 'flex', flexDirection: 'column' }}>
          {error && <div style={{ color: 'var(--danger)', padding: '8px 14px 0', fontSize: 13 }}>{error}</div>}
          {currentFile ? (
            <div style={{ flex: 1, minHeight: 0 }}>
              <CodeEditor
                ref={editorApiRef}
                path={currentFile.path}
                value={currentFile.content}
                readOnly={activeLocked}
                highlightLines={highlightLines}
                onChange={updateContent}
                onSave={saveToDisk}
                onContextMenu={(e, sel) => {
                  openContextMenu(e, [
                    { label: t('wb.copySel'), disabled: !sel, onClick: () => copyText(sel) },
                    {
                      label: t('wb.selectAllCode'),
                      onClick: () => {
                        const ta = document.querySelector<HTMLTextAreaElement>('.ce-input');
                        ta?.select();
                      }
                    },
                    { separator: true },
                    { label: scanning ? t('wb.scanning') : t('wb.scanFile'), disabled: scanning || activeLocked, title: activeLocked ? t('wb.locked') : undefined, onClick: () => runScan() },
                    ...(dirty
                      ? [{ label: saving ? t('wb.saving') : t('wb.saveChanges'), disabled: saving || activeLocked, onClick: () => saveToDisk() }]
                      : [])
                  ]);
                }}
              />
            </div>
          ) : (
            <div className="muted" style={{ textAlign: 'center', marginTop: 80 }}>
              {activeWs ? t('wb.emptyEditor') : t('wb.emptyNoWs')}
            </div>
          )}
        </div>
      </section>

      {/* 右栏 · 问题精简面板：分析过程只显示部分；可拖拽调宽 / 折叠为窄条 */}
      {layout.panelCollapsed ? (
        <aside className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '10px 0', minHeight: 0 }}>
          <button
            className="btn-ghost"
            onClick={() => patchLayout({ panelCollapsed: false })}
            title={t('wb.panelExpand')}
            style={{ width: 30, height: 30, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}
          >
            »
          </button>
          <div className="muted" style={{ writingMode: 'vertical-rl', fontSize: 10.5, letterSpacing: 1.5 }}>
            {t('wb.issues')}
          </div>
        </aside>
      ) : (
        <aside className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, padding: 14, position: 'relative' }}>
          <ResizeHandle
            dir="left"
            width={layout.panelWidth}
            min={PANEL_MIN}
            max={PANEL_MAX}
            onWidth={(w) => setLayout((l) => ({ ...l, panelWidth: w }))}
            onCommit={persistLayout}
            onReset={() => patchLayout({ panelWidth: PANEL_DEFAULT, panelCollapsed: false })}
          />
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
            <strong style={{ fontSize: 14 }}>{t('wb.issues')}</strong>
            {result && <span className="muted" style={{ fontSize: 12 }}>{t('wb.issueCount', { n: result.totalIssues, lang: result.language })}</span>}
            <div style={{ flex: 1 }} />
            <button
              className="btn-ghost"
              onClick={() => patchLayout({ panelCollapsed: true })}
              title={t('wb.panelCollapse')}
              style={{ width: 22, height: 22, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}
            >
              «
            </button>
          </div>
          <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.7, marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid var(--border-hairline)' }}>
            {scanning ? (
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{t('wb.analyzingPipeline')}</span>
            ) : (
              t('wb.pipelineDesc')
            )}
          </div>
          <div style={{ overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {!result && !scanning && <div className="muted" style={{ fontSize: 13 }}>{t('wb.scanToSee')}</div>}
            {scanning && (
              <div style={{ background: 'var(--accent-tint)', borderRadius: 10, padding: 12, fontSize: 12.5, color: 'var(--accent)', lineHeight: 1.7 }}>
                {t('wb.analyzingFile', { file: currentFile ? fileName(currentFile.path) : '' })}
              </div>
            )}
            {result?.issues?.slice(0, 3).map((iss, i) => (
              <div key={i} style={{ background: 'var(--bg-recessed)', borderRadius: 10, padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: severityColor(iss.severity) }} />
                  <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{iss.issueType}</span>
                  {iss.line != null && <span className="muted" style={{ fontSize: 11 }}>L{iss.line}</span>}
                </div>
                <div style={{ fontSize: 12.5, marginBottom: 10, lineHeight: 1.6 }}>{iss.message}</div>
                <button
                  className="btn-primary"
                  style={{ fontSize: 12, padding: '5px 12px' }}
                  onClick={() => fix(iss)}
                  disabled={fixing !== null}
                >
                  {fixing === iss.issueType ? t('wb.optimizing') : t('an.fix')}
                </button>
              </div>
            ))}
            {result && result.totalIssues === 0 && (
              <div style={{ color: 'var(--success)', fontSize: 13 }}>{t('wb.noIssues')}</div>
            )}
          </div>
          {result && (result.issues?.length || 0) > 3 && (
            <button
              className="btn-ghost"
              style={{ marginTop: 10, fontSize: 12.5 }}
              onClick={() => onModeChange('analysis')}
            >
              {t('wb.moreIssues', { n: (result.issues?.length || 0) - 3 })}
            </button>
          )}
        </aside>
      )}

      {/* 编辑模式专属：AI 悬浮小框 */}
      <AIDock currentFile={currentFile} result={result} scanning={scanning} analysisMode={analysisMode} locked={activeLocked} onApplyCode={applyCodeChange} memoryScope={memoryScopeFor(isMemoryCrossChat(), activeWs)} />

      {/* Ctrl+P 快速打开 / Ctrl+/ 快捷键速查表 */}
      <QuickOpen
        open={quickOpen}
        collectFiles={collectFilesCb}
        workspacePath={activeWs}
        onClose={() => setQuickOpen(false)}
        onPick={(it: QuickOpenItem) => void openFile(it)}
      />
      <ShortcutSheet open={cheat} onClose={() => setCheat(false)} />
    </div>
  );
}
