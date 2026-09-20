import { invoke } from '@tauri-apps/api/core';
import { t } from '../lib/i18n';

const IS_TAURI = '__TAURI_INTERNALS__' in window;
const DEV_PORT = 3000; // 浏览器调试时直连本地 server
// dev 主机名跟随页面（服务器可能绑定 localhost/IPv6 ::1，硬编码 127.0.0.1 会连接被拒）
const DEV_HOST = window.location.hostname || '127.0.0.1';

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface Issue {
  id?: number;
  issueType: string;
  message: string;
  line?: number;
  severity?: string;
  ruleId?: string;
  [k: string]: unknown;
}

export interface LlmUsage {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  requests: number;
  model: string | null;
  provider: string | null;
  cacheHitRate: number | null;
}

export interface AnalyzeResult {
  filePath: string;
  language: string;
  totalIssues: number;
  issues: Issue[];
  optimizations?: unknown[];
  llmUsage?: LlmUsage | null;
}

export interface OptimizeResult {
  optimizationId?: number | null;
  optimizedCode: string;
  explanation?: string;
  suggestions?: string[];
  similarSnippets?: unknown[];
}

async function httpGet<T>(path: string): Promise<T> {
  const res = await fetch(`http://${DEV_HOST}:${DEV_PORT}${path}`);
  return res.json() as Promise<T>;
}

async function httpPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`http://${DEV_HOST}:${DEV_PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  return res.json() as Promise<T>;
}

/** sidecar 动态端口缓存（Tauri 模式下由 Rust 注入空闲端口） */
let sidecarPortCache: number | null = null;

async function sidecarPort(): Promise<number> {
  if (sidecarPortCache) return sidecarPortCache;
  sidecarPortCache = await invoke<number>('sidecar_port');
  return sidecarPortCache;
}

/** Tauri 模式下直连 sidecar HTTP（绕过 Rust 命令转发，便于扩展业务接口） */
export async function sidecarRequest<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const port = IS_TAURI ? await sidecarPort() : DEV_PORT;
  const host = IS_TAURI ? '127.0.0.1' : DEV_HOST; // sidecar 固定监听 127.0.0.1；dev 跟随页面主机名
  const res = await fetch(`http://${host}:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal
  });
  return res.json() as Promise<T>;
}

export async function health(): Promise<{ success: boolean }> {
  if (IS_TAURI) return invoke('sidecar_health');
  return httpGet('/health');
}

export async function listDir(path: string): Promise<FileNode[]> {
  return invoke<FileNode[]>('list_dir', { path });
}

export async function readFile(path: string, encoding?: string): Promise<{ content: string; language: string; encoding: string }> {
  return invoke('read_file', encoding ? { path, encoding } : { path });
}

export async function saveFile(path: string, content: string, encoding?: string): Promise<void> {
  return invoke('save_file', encoding ? { path, content, encoding } : { path, content });
}

/** 前端状态文件读写：~/.mr-sliy/gui-state/<name>.json（浏览器调试时回落 localStorage） */
export async function loadState(name: string): Promise<string | null> {
  if (!IS_TAURI) return localStorage.getItem(`mrsliy.${name}`);
  const file = await invoke<string>('state_file_path', { name });
  try {
    const { content } = await invoke<{ content: string }>('read_file', { path: file });
    return content;
  } catch {
    return null;
  }
}

export async function saveState(name: string, content: string): Promise<void> {
  if (!IS_TAURI) {
    localStorage.setItem(`mrsliy.${name}`, content);
    return;
  }
  const file = await invoke<string>('state_file_path', { name });
  await invoke('save_file', { path: file, content });
}

/** sidecar 业务接口返回 {success, code, message, data} 信封；解包 data 并在失败时抛错 */
function unwrapData<T>(raw: unknown): T {
  const env = raw as { success?: boolean; message?: string; data?: unknown } | null;
  if (env && typeof env === 'object' && 'success' in env) {
    if (env.success === false) throw new Error(env.message || t('err.requestFailed'));
    if (env.data && typeof env.data === 'object') return env.data as T;
  }
  return raw as T;
}

export type AnalysisMode = 'local' | 'cloud';

export async function analyzeFile(
  filePath: string,
  sourceCode: string,
  mode: AnalysisMode = 'local',
  signal?: AbortSignal
): Promise<AnalyzeResult> {
  const body = { filePath, sourceCode, mode: mode === 'cloud' ? 'online' : 'offline' };
  const raw = IS_TAURI
    ? await sidecarRequest<unknown>('POST', '/api/scan/file', body, signal)
    : await httpPost<unknown>('/api/scan/file', body, signal);
  return unwrapData<AnalyzeResult>(raw);
}

export async function optimizeCode(
  code: string,
  filePath: string,
  language: string,
  issueType?: string,
  message?: string,
  line?: number
): Promise<OptimizeResult> {
  const body = { code, filePath, language, issueType, message, line };
  const raw = IS_TAURI
    ? await sidecarRequest<unknown>('POST', '/api/ai/optimize', body)
    : await httpPost<unknown>('/api/ai/optimize', body);
  return unwrapData<OptimizeResult>(raw);
}

/** AI 助手对话：发送历史（user/assistant），返回模型回复 */
export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  reply: string;
  usage?: unknown;
}

export async function chatWithAI(messages: ChatMsg[], context?: ChatContext | null, signal?: AbortSignal, memoryScope?: string): Promise<ChatResult> {
  const raw = IS_TAURI
    ? await sidecarRequest<unknown>('POST', '/api/ai/chat', { messages, context, memoryScope }, signal)
    : await httpPost<unknown>('/api/ai/chat', { messages, context, memoryScope });
  return unwrapData<ChatResult>(raw);
}

/** 随聊天请求注入的工作区上下文（文件、问题概览），服务端拼入系统提示词 */
export interface ChatContext {
  fileName?: string;
  language?: string;
  totalIssues?: number;
  topIssues?: { type?: string; message?: string; line?: number }[];
}

/**
 * AI 流式对话（SSE）：逐 delta 回调，返回完整回复。
 * 支持通过 AbortSignal 中断（用户点击"停止"）。
 */
export async function chatWithAIStream(
  messages: ChatMsg[],
  context: ChatContext | null,
  opts: { onDelta: (delta: string) => void; signal?: AbortSignal; memoryScope?: string }
): Promise<{ reply: string; usage?: unknown }> {
  const port = IS_TAURI ? await sidecarPort() : DEV_PORT;
  const host = IS_TAURI ? '127.0.0.1' : DEV_HOST;
  const res = await fetch(`http://${host}:${port}/api/ai/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, context, memoryScope: opts.memoryScope }),
    signal: opts.signal
  });
  if (!res.ok || !res.body) {
    const env = await res.json().catch(() => null);
    throw new Error((env && (env.message || env.error)) || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let usage: unknown;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let parsed: { delta?: string; done?: boolean; usage?: unknown; error?: string };
      try {
        parsed = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (parsed.error) throw new Error(parsed.error);
      if (parsed.delta) {
        full += parsed.delta;
        opts.onDelta(parsed.delta);
      }
      if (parsed.done) usage = parsed.usage;
    }
  }
  return { reply: full, usage };
}

// ---------- 跨会话记忆 ----------

export interface MemoryItem {
  id: string;
  text: string;
  /** 来源：auto=对话后 LLM 自动提取，manual=手动添加；旧数据无此字段按 manual 渲染 */
  source?: 'auto' | 'manual';
  createdAt: string;
}

export async function getMemories(): Promise<MemoryItem[]> {
  const r = unwrapData<{ memories: MemoryItem[] }>(await sidecarRequest('GET', '/api/ai/memory/list'));
  return r.memories;
}

export async function deleteMemory(id: string): Promise<void> {
  unwrapData(await sidecarRequest('DELETE', `/api/ai/memory/${id}`));
}

export async function clearMemories(): Promise<void> {
  unwrapData(await sidecarRequest('DELETE', '/api/ai/memory'));
}

// ---------- 记忆作用域（跨对话开关） ----------

/** 跨对话记忆开关的本地持久化键（默认开启） */
const MEMORY_CROSS_CHAT_KEY = 'mrsliy.memoryCrossChat';

export function isMemoryCrossChat(): boolean {
  try {
    return localStorage.getItem(MEMORY_CROSS_CHAT_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setMemoryCrossChat(v: boolean): void {
  try {
    localStorage.setItem(MEMORY_CROSS_CHAT_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/**
 * 计算聊天请求应携带的 memoryScope:
 * - 跨对话开启 → ''(全局记忆,所有对话共享)
 * - 跨对话关闭 → 对话标识(工作区路径),记忆按对话隔离
 */
export function memoryScopeFor(crossChat: boolean, conversationId: string | null | undefined): string {
  return crossChat ? '' : String(conversationId || 'default');
}

// ---------- 项目级扫描与分析报告 ----------

export interface ProjectScanFileResult {
  filePath?: string;
  path?: string;
  file?: string;
  language?: string;
  success?: boolean;
  message?: string;
  totalIssues?: number;
  issues?: Issue[];
}

export interface ProjectScanResult {
  taskId?: string;
  projectPath: string;
  totalFiles: number;
  scannedFiles: number;
  failedFiles: number;
  totalIssues: number;
  results: ProjectScanFileResult[];
  durationMs: number;
}

/** 扫描整个项目（后端聚合检测） */
export async function projectScan(projectPath: string, mode: AnalysisMode = 'local'): Promise<ProjectScanResult> {
  const raw = await sidecarRequest<unknown>('POST', '/api/scan/project', { projectPath, mode: mode === 'cloud' ? 'online' : 'offline' });
  return unwrapData<ProjectScanResult>(raw);
}

export interface ReportPayload {
  title?: string;
  projectPath?: string;
  summary?: { totalFiles?: number; scannedFiles?: number; failedFiles?: number; totalIssues?: number; durationMs?: number };
  files: unknown[];
  format?: 'html' | 'md';
}

/** 生成分析报告（落盘 ~/.mr-sliy/reports/） */
export async function generateReport(payload: ReportPayload): Promise<{ reportId: string; path: string; format: string }> {
  const raw = await sidecarRequest<unknown>('POST', '/api/reports/generate', payload);
  return unwrapData<{ reportId: string; path: string; format: string }>(raw);
}

// ---------- 更新记录（自更新/自修复历史） ----------

export interface UpdateRecord {
  id?: string;
  updateType?: string;
  updateContent?: string;
  status?: string;
  createdAt?: string;
  [k: string]: unknown;
}

export async function getUpdateRecords(limit = 10): Promise<UpdateRecord[]> {
  const env = await sidecarRequest<{ success: boolean; data: UpdateRecord[] }>('GET', `/api/updates?limit=${limit}`);
  return env?.data || [];
}

// ---------- 检查更新（远程版本清单比对） ----------

export interface CheckUpdatePayload {
  /** 是否完成远程检查（未配置更新源/网络失败时为 false） */
  checked: boolean;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  notes?: string;
  url?: string;
  /** 新版本安装包直链（https）;为空时回退打开下载页 */
  download?: string;
  /** 安装包 sha256 摘要("sha256:hex",来自 GitHub API),供下载后完整性校验 */
  digest?: string;
  /** checked=false 时的原因说明 */
  reason?: string;
}

/** 检查更新：拉取更新源清单并与当前版本比对（上报 GUI 自身版本，服务端以此为准） */
declare const __APP_VERSION__: string;

/** GUI 自身版本（vite 构建时从 gui/package.json 注入），供关于卡片等展示 */
export const APP_VERSION: string = __APP_VERSION__;

export async function checkForUpdate(signal?: AbortSignal): Promise<CheckUpdatePayload> {
  const env = await sidecarRequest<{ success: boolean; data: CheckUpdatePayload }>(
    'POST',
    '/api/check-update',
    { currentVersion: __APP_VERSION__ },
    signal
  );
  return env?.data || { checked: false, currentVersion: '', reason: t('err.requestFailed') };
}

// ---------- 更新安装包下载（自动下载 + 一键安装） ----------

export interface DownloadState {
  status: 'idle' | 'downloading' | 'done' | 'error';
  version?: string;
  url?: string;
  received?: number;
  total?: number;
  percent?: number;
  /** 下载完成后的安装包绝对路径 */
  filePath?: string;
  error?: string;
}

/** 开始下载新版本安装包(已有下载进行中时后端返回 409);digest 用于 sha256 校验。
 *  后端错误信封字段为 error,必须透传真实原因,不能吞成通用"请求失败"。 */
export async function startUpdateDownload(url: string, version: string, digest?: string): Promise<DownloadState> {
  const env = await sidecarRequest<{ success: boolean; error?: string; message?: string; data?: DownloadState }>(
    'POST',
    '/api/update-download/start',
    { url, version, digest }
  );
  if (!env || env.success === false) {
    return { status: 'error', error: env?.error || env?.message || t('err.requestFailed') };
  }
  return env.data || { status: 'error', error: t('err.requestFailed') };
}

/** 查询下载状态/进度(轮询)。
 *  自动携带 GUI 当前版本:后端恢复扫描据此做版本门控,只把比当前版本新的
 *  已下载安装包恢复为"可安装",防止残留的同版安装包被一键装回(装完仍提示更新的死循环)。 */
export async function getUpdateDownloadStatus(): Promise<DownloadState> {
  const env = await sidecarRequest<{ success: boolean; data: DownloadState }>(
    'GET',
    `/api/update-download/status?currentVersion=${encodeURIComponent(APP_VERSION)}`
  );
  return env?.data || { status: 'idle' };
}

/** 取消当前下载 */
export async function cancelUpdateDownload(): Promise<boolean> {
  const env = await sidecarRequest<{ success: boolean; data: { cancelled: boolean } }>('POST', '/api/update-download/cancel');
  return !!env?.data?.cancelled;
}

/** 启动已下载的安装器并退出当前应用(Tauri 命令;浏览器调试模式不可用) */
export async function installUpdate(installerPath: string): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) throw new Error(t('err.desktopOnlyInstall'));
  await invoke('install_update', { path: installerPath });
}

export async function getUpdateSource(): Promise<{ url: string; currentVersion: string }> {
  const env = await sidecarRequest<{ success: boolean; data: { url: string; currentVersion: string } }>('GET', '/api/update-source');
  // currentVersion 以 GUI 自身版本为准（服务端返回的是 CLI 版本）
  return { ...(env?.data || { url: '', currentVersion: '' }), currentVersion: __APP_VERSION__ };
}

export async function saveUpdateSource(url: string): Promise<string> {
  const env = await sidecarRequest<{ success: boolean; data: { url: string } }>('POST', '/api/update-source', { url });
  return env?.data?.url || '';
}

/** 用系统默认浏览器打开链接（后端 explorer.exe 转发） */
export async function openExternal(url: string): Promise<void> {
  await sidecarRequest('POST', '/api/open-url', { url });
}

export async function issueStats(projectId?: number): Promise<{ success: boolean; data: unknown }> {
  const q = projectId != null ? `?projectId=${projectId}` : '';
  return sidecarRequest('GET', `/api/issues/stats${q}`);
}

// ---------- 扫描项目（质量概览按项目查看） ----------

export interface ProjectRow {
  id: number;
  project_name?: string;
  project_path?: string;
  scan_count?: number;
  last_scan_at?: string | null;
  created_at?: string | null;
  [k: string]: unknown;
}

/** 项目列表（按创建时间倒序）；质量概览用它做项目选择器 */
export async function listProjects(pageSize = 100): Promise<ProjectRow[]> {
  const raw = await sidecarRequest<unknown>('GET', `/api/projects?pageSize=${pageSize}`);
  const d = unwrapData<{ list?: ProjectRow[] }>(raw);
  return d?.list || [];
}

// ---------- MCP 接入（设置页） ----------

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpStatus {
  protocolVersion: string;
  supportedProtocolVersions: string[];
  serverInfo: { name: string; version: string };
  httpUrl: string;
  stdio: { command: string; args: string[] };
  tools: McpToolInfo[];
}

/** 读取 MCP 接入信息（stdio 命令 / HTTP 端点 / 工具清单） */
export async function getMcpStatus(): Promise<McpStatus> {
  return unwrapData<McpStatus>(await sidecarRequest('GET', '/api/mcp/status'));
}

export interface McpSelftestStep {
  step: string;
  ok: boolean;
  elapsed: number;
  error: string;
  toolCount?: number;
}

export interface McpSelftest {
  available: boolean;
  url: string;
  steps: McpSelftestStep[];
  totalMs?: number;
  toolCount?: number;
}

/**
 * MCP 真实可用性自检：服务端对自身 HTTP 端点跑一遍
 * initialize → tools/list → ping，三步全通才算可用。
 */
export async function runMcpSelftest(): Promise<McpSelftest> {
  return unwrapData<McpSelftest>(await sidecarRequest('GET', '/api/mcp/selftest'));
}

// ---------- 外部 MCP 服务器（智能体作为 MCP 客户端主动连接其他应用） ----------

export interface ExternalMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ExternalMcpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  description?: string;
  createdAt?: string;
  /** 实时连接状态（服务端合并）：connected / disconnected / error */
  status?: 'connected' | 'disconnected' | 'error';
  lastError?: string;
  toolCount?: number;
  tools?: ExternalMcpTool[];
  connectedAt?: string | null;
}

/** 服务器配置表单输入（id 由服务端生成；更新时整包提交） */
export interface ExternalMcpServerInput {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  description?: string;
}

export interface ExternalCallResult {
  tool: string;
  server: string;
  text: string;
  isError: boolean;
  elapsedMs: number;
}

export interface ExternalMcpLog {
  ts: string;
  server: string;
  tool: string;
  args: string;
  ok: boolean;
  error: string;
  elapsedMs: number;
  transport: string;
}

/** 扫描发现的本机 HTTP MCP 服务 */
export interface ExternalMcpScanHit {
  url: string;
  name: string;
  protocolVersion: string;
  toolCount: number;
  via: string;
}

/** 外部服务器列表（含实时连接状态与工具清单） */
export async function getExternalMcpServers(): Promise<{ servers: ExternalMcpServer[] }> {
  return unwrapData<{ servers: ExternalMcpServer[] }>(await sidecarRequest('GET', '/api/mcp/external'));
}

export async function addExternalMcpServer(input: ExternalMcpServerInput): Promise<{ server: ExternalMcpServer }> {
  return unwrapData<{ server: ExternalMcpServer }>(await sidecarRequest('POST', '/api/mcp/external', input));
}

export async function updateExternalMcpServer(id: string, input: ExternalMcpServerInput): Promise<{ server: ExternalMcpServer }> {
  return unwrapData<{ server: ExternalMcpServer }>(await sidecarRequest('PUT', `/api/mcp/external/${id}`, input));
}

export async function deleteExternalMcpServer(id: string): Promise<void> {
  await sidecarRequest('DELETE', `/api/mcp/external/${id}`);
}

/** 连接外部服务器（initialize 握手 → tools/list），失败抛出错误信息 */
export async function connectExternalMcpServer(id: string): Promise<{ tools: ExternalMcpTool[] }> {
  return unwrapData<{ tools: ExternalMcpTool[] }>(await sidecarRequest('POST', `/api/mcp/external/${id}/connect`));
}

export async function disconnectExternalMcpServer(id: string): Promise<void> {
  await sidecarRequest('POST', `/api/mcp/external/${id}/disconnect`);
}

/** 手动调用外部工具 */
export async function callExternalMcpTool(id: string, tool: string, args: Record<string, unknown>): Promise<{ result: ExternalCallResult }> {
  return unwrapData<{ result: ExternalCallResult }>(await sidecarRequest('POST', `/api/mcp/external/${id}/call`, { tool, arguments: args }));
}

/** 外部工具出站调用日志（新的在前） */
export async function getExternalMcpLogs(limit = 50): Promise<{ logs: ExternalMcpLog[] }> {
  return unwrapData<{ logs: ExternalMcpLog[] }>(await sidecarRequest('GET', `/api/mcp/external/logs?limit=${limit}`));
}

/** 扫描本机可用的 HTTP MCP 服务（可能耗时数秒） */
export async function scanExternalMcpServers(): Promise<{ http: ExternalMcpScanHit[] }> {
  return unwrapData<{ http: ExternalMcpScanHit[] }>(await sidecarRequest('POST', '/api/mcp/external/scan', {}));
}

// ---------- 工作区全文搜索（跨文件查找） ----------

export interface SearchHit {
  file: string;
  line: number;
  column: number;
  text: string;
}

export interface SearchWorkspaceResult {
  matches: SearchHit[];
  truncated: boolean;
  searchedFiles: number;
  durationMs?: number;
}

/** 跨文件全文搜索：遍历工作区文本文件逐行匹配关键字（服务端跳过依赖/二进制目录） */
export async function searchWorkspace(projectPath: string, keyword: string): Promise<SearchWorkspaceResult> {
  const raw = await sidecarRequest<unknown>('POST', '/api/scan/search', { projectPath, keyword });
  return unwrapData<SearchWorkspaceResult>(raw);
}

// ---------- 扫描任务（质量概览：趋势 / 两次扫描对比） ----------

export interface ScanTaskRow {
  id: number;
  task_name?: string;
  scan_mode?: string;
  scanned_files?: number;
  file_count?: number;
  issue_count?: number;
  issue_critical?: number;
  issue_high?: number;
  issue_medium?: number;
  issue_low?: number;
  completed_at?: string | null;
  duration_ms?: number;
  [k: string]: unknown;
}

/** 项目的扫描任务列表（新在前），供"两次扫描对比"选择任务 */
export async function listScanTasks(projectId: number, limit = 30): Promise<ScanTaskRow[]> {
  const r = unwrapData<{ tasks: ScanTaskRow[] }>(
    await sidecarRequest('GET', `/api/issues/tasks?projectId=${projectId}&limit=${limit}`)
  );
  return r.tasks || [];
}

export interface TrendRow {
  id: number;
  completed_at?: string | null;
  scanned_files?: number;
  issue_count?: number;
  issue_critical?: number;
  issue_high?: number;
  issue_medium?: number;
  issue_low?: number;
  [k: string]: unknown;
}

/** 项目的质量评分趋势序列（时间正序） */
export async function getIssueTrend(projectId: number, limit = 20): Promise<TrendRow[]> {
  const r = unwrapData<{ trend: TrendRow[] }>(
    await sidecarRequest('GET', `/api/issues/trend?projectId=${projectId}&limit=${limit}`)
  );
  return r.trend || [];
}

/** 按 taskId 拉取该次扫描的问题（两次扫描对比用，取全量上限内） */
export async function listIssuesByTask(taskId: number, pageSize = 2000): Promise<Issue[]> {
  const raw = await sidecarRequest<{ data?: { list?: Issue[] } }>(
    'GET',
    `/api/issues?taskId=${taskId}&pageSize=${pageSize}`
  );
  return raw?.data?.list || [];
}

// ---------- MCP 调用日志 ----------

export interface McpCallLog {
  ts: string;
  tool: string;
  args: string;
  ok: boolean;
  error: string;
  elapsedMs: number;
  transport: string;
}

/** 最近的 MCP 工具调用记录（新的在前） */
export async function getMcpLogs(limit = 50): Promise<McpCallLog[]> {
  const r = unwrapData<{ logs: McpCallLog[] }>(await sidecarRequest('GET', `/api/mcp/logs?limit=${limit}`));
  return r.logs || [];
}

// ---------- LLM 提供商管理（设置页） ----------

export interface LlmProviderInfo {
  name: string;
  available: boolean;
  model?: string;
}

export interface LlmKeyInfo {
  provider: string;
  maskedKey: string;
  hasKey: boolean;
  apiUrl: string;
  model: string;
  isActive: boolean;
}

export interface LlmProvidersPayload {
  providers: LlmProviderInfo[];
  active: string | null;
}

export async function getLlmProviders(): Promise<LlmProvidersPayload> {
  return unwrapData<LlmProvidersPayload>(await sidecarRequest('GET', '/api/llm/providers'));
}

export async function getLlmKeys(): Promise<LlmKeyInfo[]> {
  const r = unwrapData<{ keys: LlmKeyInfo[] }>(await sidecarRequest('GET', '/api/llm/keys'));
  return r.keys;
}

export async function saveLlmProvider(
  name: string,
  cfg: { apiKey: string; apiUrl?: string; model?: string }
): Promise<void> {
  unwrapData(await sidecarRequest('POST', `/api/llm/providers/${name}`, cfg));
}

export async function deleteLlmProvider(name: string): Promise<void> {
  unwrapData(await sidecarRequest('DELETE', `/api/llm/providers/${name}`));
}

export async function activateLlmProvider(name: string): Promise<void> {
  unwrapData(await sidecarRequest('POST', `/api/llm/providers/${name}/activate`));
}

/** 添加自定义提供商（OpenAI 兼容协议，命名 custom-<slug>） */
export async function addCustomProvider(cfg: { name: string; apiKey?: string; apiUrl: string; model?: string }): Promise<void> {
  unwrapData(await sidecarRequest('POST', '/api/llm/custom', cfg));
}

/** 查询大模型用量（活跃提供商 / 会话实时 / 历史累计） */
export async function getLlmUsage(): Promise<LlmUsagePayload> {
  return unwrapData<LlmUsagePayload>(await sidecarRequest('GET', '/api/llm/usage'));
}

export interface LlmUsagePayload {
  active: { name: string; model: string | null } | null;
  session: LlmUsage;
  history: { totalTokens: number; requests: number };
}
