import { useSyncExternalStore } from 'react';

/** 轻量 i18n 基础：字典 + 全局语言状态（localStorage 持久化）+ 订阅式 hook。
 *  Settings 页已全覆盖；其余页面按需引入 t() 逐步迁移。 */

export type Lang = 'zh' | 'en';

type Entry = { zh: string; en: string };

const DICT: Record<string, Entry> = {
  // ---------- Settings：分析模式 ----------
  'settings.mode.title': { zh: '分析模式', en: 'Analysis Mode' },
  'settings.mode.desc': {
    zh: '选择检测与优化执行方式；扫描结果会带对应标识（本地 / 大模型）',
    en: 'Choose how detection & optimization run; results are tagged (Local / LLM)'
  },
  'mode.local.title': { zh: '本地知识库', en: 'Local Knowledge Base' },
  'mode.local.desc': {
    zh: 'Tree-sitter AST 解析 + 本地规则检测，完全离线可用，速度快且代码不出本机',
    en: 'Tree-sitter AST parsing + local rule detection; fully offline, fast, and code never leaves your machine'
  },
  'mode.cloud.title': { zh: '大模型增强', en: 'LLM Enhanced' },
  'mode.cloud.desc': {
    zh: '在本地检测的基础上，将问题片段交给云端大模型生成优化建议（需在下方配置 API Key）',
    en: 'On top of local detection, sends issue snippets to a cloud LLM for optimization advice (configure an API key below)'
  },
  'common.inUse': { zh: '当前使用', en: 'In use' },
  'mode.noProvider': {
    zh: '尚未启用任何大模型 — 请在下方配置并启用一个提供商，否则增强阶段会自动回退为本地结果。',
    en: 'No LLM enabled — configure and activate a provider below, otherwise the enhance stage falls back to local results.'
  },

  // ---------- Settings：大模型提供商 ----------
  'settings.llm.title': { zh: '大模型提供商', en: 'LLM Providers' },
  'settings.llm.hint': {
    zh: 'API Key 仅保存在本机数据库，不会上传',
    en: 'API keys stay in the local database and are never uploaded'
  },
  'llm.custom': { zh: '+ 自定义', en: '+ Custom' },
  'llm.refresh': { zh: '刷新状态', en: 'Refresh' },
  'llm.custom.title': { zh: '添加自定义提供商（OpenAI 兼容协议）', en: 'Add custom provider (OpenAI-compatible)' },
  'field.name': { zh: '名称（必填）', en: 'Name (required)' },
  'field.name.ph': { zh: '例如：硅基流动 / 公司中转', en: 'e.g. SiliconFlow / corporate gateway' },
  'field.url': { zh: 'API 地址（必填，OpenAI 兼容）', en: 'API URL (required, OpenAI-compatible)' },
  'field.key': { zh: 'API Key（服务不要求时可留空）', en: 'API Key (leave blank if not required)' },
  'field.model': { zh: '模型名称（可选）', en: 'Model name (optional)' },
  'field.model.ph': { zh: '例如：qwen2.5-72b-instruct', en: 'e.g. qwen2.5-72b-instruct' },
  'common.add': { zh: '添加', en: 'Add' },
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.loading': { zh: '正在加载提供商状态…', en: 'Loading provider status…' },
  'provider.available': { zh: '可用', en: 'Available' },
  'provider.unavailable': { zh: '未配置或不可达', en: 'Not configured or unreachable' },
  'provider.active': { zh: '使用中', en: 'Active' },
  'provider.edit': { zh: '编辑', en: 'Edit' },
  'provider.config': { zh: '配置', en: 'Configure' },
  'provider.collapse': { zh: '收起', en: 'Collapse' },
  'provider.activate': { zh: '启用', en: 'Activate' },
  'provider.activating': { zh: '启用中…', en: 'Activating…' },
  'provider.delete': { zh: '删除', en: 'Delete' },
  'provider.keyRequired': { zh: 'API Key（必填）', en: 'API Key (required)' },
  'provider.keySavedPh': { zh: '已保存 {masked}，可输入新 Key 覆盖', en: 'Saved {masked}; enter a new key to override' },
  'provider.keyPh': { zh: '粘贴提供商控制台生成的 API Key', en: 'Paste the API key from the provider console' },
  'field.urlOptional': { zh: 'API 地址（可选，使用代理或私有部署时填写）', en: 'API URL (optional, for proxies or private deployments)' },
  'field.urlOptionalPh': { zh: '留空使用官方默认地址', en: 'Leave blank for the official default' },
  'field.modelOptionalPh': { zh: '留空使用默认模型', en: 'Leave blank for the default model' },
  'provider.save': { zh: '保存配置', en: 'Save' },
  'provider.saving': { zh: '保存中…', en: 'Saving…' },

  // ---------- Settings：记忆库 ----------
  'settings.memory.title': { zh: '记忆库', en: 'Memory' },
  'settings.memory.desc': {
    zh: '全自动记忆：每轮对话结束后由 AI 自动提取值得记住的偏好与约定（零操作），并注入后续对话提示词；此列表仅用于查看与纠错',
    en: 'Fully automatic memory: preferences and conventions are extracted by AI after each chat turn (zero effort) and injected into later prompts; this list is for review only'
  },
  'memory.crossChat': { zh: '跨对话记忆', en: 'Cross-conversation memory' },
  'memory.crossChatTip': {
    zh: '开启后所有对话共享同一份记忆；关闭后每个对话独立记忆、互不共享',
    en: 'When on, all conversations share one memory; when off, each conversation keeps its own memory'
  },
  'memory.isolatedDesc': {
    zh: '跨对话记忆已关闭：记忆功能仍然生效，但每个对话（工作区）独立记忆、互不共享，也不会读取全局记忆。',
    en: 'Cross-conversation memory is off: memory still works, but each conversation (workspace) keeps its own memory, isolated from others and from the global store.'
  },
  'memory.auto': { zh: '自动', en: 'Auto' },
  'memory.manual': { zh: '手动', en: 'Manual' },
  'memory.autoTip': { zh: '对话后由 AI 自动提取', en: 'Extracted automatically by AI after chat' },
  'memory.manualTip': { zh: '手动添加', en: 'Added manually' },
  'memory.clear': { zh: '清空全部', en: 'Clear all' },
  'memory.empty': {
    zh: '暂无记忆。与 AI 助手对话即会自动记录偏好与约定。',
    en: 'No memories yet. Chatting with the AI assistant records preferences automatically.'
  },
  'memory.count': { zh: '{n} 条', en: '{n} items' },

  // ---------- Settings：更新记录 ----------
  'settings.updates.title': { zh: '更新记录', en: 'Update History' },
  'settings.updates.desc': { zh: '自更新与自修复历史', en: 'Self-update & self-repair history' },
  'updates.empty': { zh: '暂无更新记录', en: 'No update records yet' },
  'updates.loadFail': { zh: '更新记录读取失败', en: 'Failed to load update records' },
  'updates.olderShow': { zh: '展开更早记录（{n}）', en: 'Show older records ({n})' },
  'updates.olderHide': { zh: '收起更早记录', en: 'Hide older records' },

  // ---------- Settings：MCP 接入 ----------
  'settings.mcp.title': { zh: 'MCP 接入', en: 'MCP Integration' },
  'settings.mcp.desc': {
    zh: '把本机的扫描、AI 优化、对话等能力开放给 Claude Desktop、Cursor 等外部客户端',
    en: 'Expose local capabilities (scanning, AI optimization, chat) to external clients like Claude Desktop and Cursor'
  },
  'mcp.server': { zh: '服务信息', en: 'Server' },
  'mcp.tools': { zh: '可用工具（{n}）', en: 'Available tools ({n})' },
  'mcp.selftest.run': { zh: '检测可用性', en: 'Test availability' },
  'mcp.selftest.running': { zh: '检测中…', en: 'Testing…' },
  'mcp.selftest.ok': {
    zh: 'MCP 可用：{n} 个工具，三步握手 {ms}ms',
    en: 'MCP available: {n} tools, handshake {ms}ms'
  },
  'mcp.selftest.fail': { zh: 'MCP 不可用', en: 'MCP unavailable' },
  'mcp.stdio.title': { zh: 'stdio 接入（推荐，桌面客户端）', en: 'stdio (recommended for desktop clients)' },
  'mcp.stdio.desc': {
    zh: '把下面的 JSON 合并进客户端配置文件：Claude Desktop 为 claude_desktop_config.json，Cursor 为 .cursor/mcp.json，Cline 为 cline_mcp_settings.json，保存后重启客户端即可',
    en: 'Merge the JSON below into the client config: claude_desktop_config.json for Claude Desktop, .cursor/mcp.json for Cursor, cline_mcp_settings.json for Cline; restart the client afterwards'
  },
  'mcp.http.title': { zh: 'HTTP 接入（本机其他程序）', en: 'HTTP (local programs)' },
  'mcp.http.desc': {
    zh: '本机任意程序向该端点 POST JSON-RPC 2.0 消息即可调用（无需额外鉴权，仅监听 127.0.0.1）',
    en: 'Any local program can POST JSON-RPC 2.0 messages to this endpoint (no extra auth; listens on 127.0.0.1 only)'
  },
  'mcp.copy': { zh: '复制', en: 'Copy' },
  'mcp.copied': { zh: '已复制', en: 'Copied' },
  'mcp.loadFail': { zh: 'MCP 状态读取失败，请确认本地服务已就绪', en: 'Failed to load MCP status; make sure the local service is ready' },

  // ---------- Settings：外观 ----------
  'settings.appearance.title': { zh: '外观设置', en: 'Appearance' },
  'settings.appearance.desc': {
    zh: '背景、卡片、边框与强调色联动切换',
    en: 'Background, cards, borders and accent switch together'
  },
  'appearance.theme': { zh: '主题', en: 'Theme' },
  'appearance.clickToApply': { zh: '点击应用', en: 'Click to apply' },
  'appearance.scale': { zh: '界面大小（含字体）', en: 'UI scale (incl. fonts)' },

  // ---------- Settings：语言 ----------
  'settings.lang.title': { zh: '语言 / Language', en: '语言 / Language' },
  'settings.lang.desc': {
    zh: '界面语言（Settings 页已完整覆盖，其余页面逐步支持）',
    en: 'UI language (Settings page fully covered; other pages progressively)'
  },

  // ---------- Settings：关于 ----------
  'settings.about.title': { zh: '关于', en: 'About' },
  'about.body': {
    zh: '基于 Tree-sitter AST 检测与 RAG 知识库，可选接入云端大模型（内置 5 家 + 自定义 OpenAI 兼容接口）；会话与配置保存在 ~/.mr-sliy/。',
    en: 'Built on Tree-sitter AST detection and a RAG knowledge base, with optional cloud LLMs (5 built-in + custom OpenAI-compatible endpoints); sessions and config are stored under ~/.mr-sliy/.'
  },

  // ---------- Settings：操作提示 ----------
  'toast.saved': { zh: '已保存 {name} 的配置', en: 'Saved {name} configuration' },
  'toast.saveFail': { zh: '保存失败：{msg}', en: 'Save failed: {msg}' },
  'toast.activated': { zh: '已启用 {name}', en: 'Activated {name}' },
  'toast.activateFail': { zh: '启用失败：{msg}', en: 'Activation failed: {msg}' },
  'toast.deleted': { zh: '已删除该配置', en: 'Configuration deleted' },
  'toast.deleteFail': { zh: '删除失败：{msg}', en: 'Delete failed: {msg}' },
  'toast.customAdded': { zh: '已添加自定义提供商「{name}」', en: 'Custom provider "{name}" added' },
  'toast.addFail': { zh: '添加失败：{msg}', en: 'Add failed: {msg}' },
  'toast.llmFail': {
    zh: '无法读取大模型配置，请确认本地服务已就绪',
    en: 'Cannot read LLM config; make sure the local service is ready'
  },
  'toast.needKey': { zh: '请填写 API Key', en: 'Please enter the API key' },
  'toast.needName': { zh: '请填写提供商名称', en: 'Please enter a provider name' },
  'toast.needUrl': { zh: '请填写 API 地址', en: 'Please enter the API URL' },
  'toast.memoryDeleted': { zh: '记忆已删除', en: 'Memory deleted' },
  'toast.memoryCleared': { zh: '已清空全部记忆', en: 'All memories cleared' },
  'toast.memFail': { zh: '记忆操作失败：{msg}', en: 'Memory operation failed: {msg}' },

  // ---------- TopBar / 窗口 ----------
  'tab.workbench': { zh: '主工作区', en: 'Workspace' },
  'tab.diff': { zh: '优化对比', en: 'Diff Review' },
  'tab.dashboard': { zh: '质量概览', en: 'Quality' },
  'tab.settings': { zh: '设置', en: 'Settings' },
  'mode.analysis': { zh: '分析模式', en: 'Analysis' },
  'mode.editor': { zh: '编辑模式', en: 'Editor' },
  'mode.analysis.tip': { zh: '对话与分析过程为主', en: 'Chat & analysis workflow' },
  'mode.editor.tip': { zh: '代码编辑为主，AI 收纳为小框', en: 'Code editing first; AI tucked aside' },

  // ---------- StatusBar ----------
  'status.connecting': { zh: '正在连接服务…', en: 'Connecting to service…' },
  'status.ready': { zh: '就绪', en: 'Ready' },
  'status.notReady': { zh: '服务未就绪', en: 'Service not ready' },
  'status.llm.calls': { zh: '次调用', en: ' calls' },
  'status.llm.cacheHits': { zh: '缓存命中', en: 'cache hits' },
  'status.llm.cacheTip': { zh: '缓存命中 {hit} / 未命中 {miss}', en: 'Cache hits {hit} / misses {miss}' },
  'status.llm.callsTip': { zh: '本次运行期间大模型调用次数', en: 'LLM calls this run' },
  'status.llm.tokens': { zh: 'tokens', en: 'tokens' },

  // ---------- CloseDialog ----------
  'close.title': { zh: '关闭 MR·SLIY', en: 'Close MR·SLIY' },
  'close.desc': {
    zh: '可以最小化到系统托盘保持后台运行，或完全退出程序。',
    en: 'Minimize to the system tray to keep it running in the background, or exit completely.'
  },
  'close.minimize': { zh: '最小化到托盘', en: 'Minimize to tray' },
  'close.exit': { zh: '退出程序', en: 'Exit' },
  'close.back': { zh: '返回', en: 'Back' },

  // ---------- WindowControls ----------
  'win.minimize': { zh: '最小化', en: 'Minimize' },
  'win.maximize': { zh: '最大化', en: 'Maximize' },
  'win.restore': { zh: '还原', en: 'Restore' },
  'win.close': { zh: '关闭', en: 'Close' },

  // ---------- ContextMenu ----------
  'ctx.cut': { zh: '剪切', en: 'Cut' },
  'ctx.copy': { zh: '复制', en: 'Copy' },
  'ctx.paste': { zh: '粘贴', en: 'Paste' },
  'ctx.selectAll': { zh: '全选', en: 'Select all' },

  // ---------- UpdateBanner ----------
  'update.badge': { zh: '新版本', en: 'New' },
  'update.downloading': { zh: '正在下载更新', en: 'Downloading update' },
  'update.done': { zh: '更新包下载完成{ver}，安装将关闭当前应用。', en: 'Update downloaded{ver}. Installing will close the app.' },
  'update.doneVer': { zh: '（v{ver}）', en: ' (v{ver})' },
  'update.failed': { zh: '下载失败：{err}', en: 'Download failed: {err}' },
  'update.unknownReason': { zh: '未知原因', en: 'unknown reason' },
  'update.install': { zh: '安装更新', en: 'Install update' },
  'update.startDownload': { zh: '下载更新', en: 'Download update' },
  'update.cancel': { zh: '取消', en: 'Cancel' },
  'update.installing': { zh: '正在启动安装器…', en: 'Launching installer…' },
  'update.retry': { zh: '重试', en: 'Retry' },
  'update.goDownload': { zh: '前往下载', en: 'Go to download' },
  'update.defaultNotes': { zh: '发现可用更新，建议升级以获得最新功能与修复。', en: 'An update is available with the latest features and fixes.' },
  'update.dismissTip': { zh: '关闭（本版本不再提示）', en: 'Dismiss (won\'t show for this version)' },
  'update.dismissAria': { zh: '关闭更新提示', en: 'Dismiss update banner' },

  // ---------- 检查更新卡片 ----------
  'update.card.title': { zh: '检查更新', en: 'Check Updates' },
  'update.card.desc': {
    zh: '发现新版本可一键下载安装',
    en: 'One-click download & install when a new version is found'
  },
  'update.card.check': { zh: '检查更新', en: 'Check for updates' },
  'update.card.checking': { zh: '检查中…', en: 'Checking…' },
  'update.card.advanced': { zh: '高级选项', en: 'Advanced' },
  'update.card.advancedOn': { zh: '收起高级选项', en: 'Hide advanced options' },
  'update.card.advDesc': {
    zh: '使用自托管更新清单时填写',
    en: 'Only for self-hosted update manifests'
  },
  'update.card.advPh': { zh: 'JSON 清单 URL（留空使用 GitHub Releases）', en: 'Manifest JSON URL (empty = GitHub Releases)' },
  'update.card.save': { zh: '保存', en: 'Save' },
  'update.card.found': { zh: '发现新版本 v{ver}', en: 'New version v{ver} found' },
  'update.card.uptodate': { zh: '已是最新版本（v{ver}）', en: 'You are up to date (v{ver})' },
  'update.card.checkFail': { zh: '未能完成检查：{reason}', en: 'Check failed: {reason}' },
  'update.card.dlProgress': { zh: '下载中 {n}%', en: 'Downloading {n}%' },
  'update.card.dlFailed': { zh: '下载失败：{err}', en: 'Download failed: {err}' },
  'update.card.dlUpdate': { zh: '下载并更新', en: 'Download & update' },

  // ---------- WorkspaceNav ----------
  'nav.sessions': { zh: '会话', en: 'Sessions' },
  'nav.newSession': { zh: '新建', en: 'New' },
  'nav.searchPh': { zh: '搜索会话…', en: 'Search sessions…' },
  'nav.scanProject': { zh: '扫描整个项目', en: 'Scan whole project' },
  'nav.scanProjectTip': { zh: '聚合检测当前工作区整个项目目录', en: 'Detect issues across the whole workspace project' },
  'nav.emptyTitle': { zh: '还没有工作区。', en: 'No workspace yet. ' },
  'nav.emptyDesc': {
    zh: '点击"新建"添加一个文件夹，它将作为一个独立的分析对话。',
    en: 'Click "New" to add a folder; it becomes an independent analysis session.'
  },
  'nav.pickWorkspace': { zh: '请先选择工作区', en: 'Select a workspace first' },
  'nav.noSessions': { zh: '暂无会话', en: 'No sessions' },
  'nav.loadFail': { zh: '无法读取', en: 'Cannot read' },
  'nav.pickFolderFail': { zh: '文件夹选择失败（需在应用窗口内使用）', en: 'Folder picker failed (must run inside the app window)' },
  'nav.newTip': { zh: '新建工作区（每个目录对应一个独立对话）', en: 'New workspace (each folder maps to an independent session)' },
  'nav.collapse': { zh: '收起侧栏', en: 'Collapse sidebar' },
  'nav.expand': { zh: '展开侧栏', en: 'Expand sidebar' },
  'wb.panelCollapse': { zh: '收起问题面板', en: 'Collapse issues panel' },
  'wb.panelExpand': { zh: '展开问题面板', en: 'Expand issues panel' },
  'ui.resizeHint': { zh: '拖拽调整宽度，双击重置', en: 'Drag to resize, double-click to reset' },
  'nav.switchTo': { zh: '切换到此对话', en: 'Switch to this session' },
  'nav.copyPath': { zh: '复制路径', en: 'Copy path' },
  'nav.lock': { zh: '锁定会话', en: 'Lock session' },
  'nav.unlock': { zh: '解锁会话', en: 'Unlock session' },
  'nav.archive': { zh: '归档会话', en: 'Archive session' },
  'nav.unarchive': { zh: '取消归档', en: 'Unarchive' },
  'nav.schedOff': { zh: '定时扫描：关闭', en: 'Scheduled scan: off' },
  'nav.schedOffCur': { zh: '定时扫描：关闭（当前每 {n} 分钟）', en: 'Scheduled scan: off (currently every {n} min)' },
  'nav.schedEvery': { zh: '定时扫描：每 {n} 分钟', en: 'Scheduled scan: every {n} min' },
  'nav.switchToUse': { zh: '切换到该会话后可用', en: 'Available after switching to this session' },
  'nav.removeWs': { zh: '移除工作区', en: 'Remove workspace' },
  'nav.removeWsTip': { zh: '移除该工作区', en: 'Remove this workspace' },
  'nav.lockedRemoveTip': { zh: '会话已锁定，解锁后才能移除', en: 'Session locked; unlock to remove' },
  'nav.archived': { zh: '归档', en: 'Archived' },
  'nav.archivedTip': { zh: '已归档（右键可取消归档）', en: 'Archived (right-click to unarchive)' },
  'nav.lockedTip': { zh: '会话已锁定：不可移除，内容只读', en: 'Session locked: cannot be removed; content is read-only' },
  'nav.hideArchived': { zh: '隐藏归档会话', en: 'Hide archived sessions' },
  'nav.showArchived': { zh: '显示归档会话', en: 'Show archived sessions' },
  'nav.archivedCount': { zh: '归档会话（{n}）', en: 'Archived ({n})' },
  'nav.browseAfterPick': { zh: '选择工作区后浏览文件', en: 'Pick a workspace to browse files' },
  'nav.loading': { zh: '加载中…', en: 'Loading…' },
  'nav.newWsTitle': { zh: '新建工作区', en: 'New Workspace' },
  'nav.newWsDesc': { zh: '选择一个文件夹，它将作为一个新的独立对话加入列表。', en: 'Pick a folder; it will join the list as a new independent session.' },
  'nav.opening': { zh: '打开中…', en: 'Opening…' },
  'nav.browse': { zh: '浏览…', en: 'Browse…' },
  'nav.expandDir': { zh: '展开目录', en: 'Expand folder' },
  'nav.collapseDir': { zh: '收起目录', en: 'Collapse folder' },
  'nav.copyDirPath': { zh: '复制目录路径', en: 'Copy folder path' },
  'nav.openFile': { zh: '打开文件', en: 'Open file' },
  'nav.copyFilePath': { zh: '复制文件路径', en: 'Copy file path' },
  'nav.copyFileName': { zh: '复制文件名', en: 'Copy file name' },
  'nav.emptyDir': { zh: '空目录', en: 'Empty folder' },

  // ---------- AnalysisView（分析会话） ----------
  'an.title': { zh: '分析会话', en: 'Analysis Session' },
  'an.noFile': { zh: '未打开文件', en: 'No file open' },
  'an.scanning': { zh: '检测进行中…', en: 'Detecting…' },
  'an.locked': { zh: '已锁定', en: 'Locked' },
  'an.start': { zh: '开始分析', en: 'Start Analysis' },
  'an.analyzing': { zh: '分析中…', en: 'Analyzing…' },
  'an.inputPh': { zh: '输入消息,或"分析"开始检测当前文件…', en: 'Type a message, or "analyze" to scan the current file…' },
  'an.send': { zh: '发送', en: 'Send' },
  'an.stop': { zh: '停止', en: 'Stop' },
  'an.hint.analyze': { zh: '输入"分析"开始检测当前文件', en: 'Type "analyze" to scan the current file' },
  'an.process': { zh: '分析过程', en: 'Analysis Process' },
  'an.running': { zh: '执行中…', en: 'Running…' },
  'an.elapsed': { zh: '总耗时', en: 'Total time' },
  'an.issues': { zh: '个问题', en: ' issues' },
  'an.expandAll': { zh: '展开全部 {n} 个问题', en: 'Show all {n} issues' },
  'an.collapse': { zh: '收起', en: 'Collapse' },
  'an.fix': { zh: '修复', en: 'Fix' },
  'an.copyIssue': { zh: '复制问题描述', en: 'Copy issue description' },
  'an.usage.time': { zh: '耗时', en: 'Time' },
  'an.usage.cache': { zh: '缓存命中', en: 'Cache' },
  'an.stopped': { zh: '已停止生成。', en: 'Generation stopped.' },
  'an.lockedTip': { zh: '会话已锁定：只读，右键左侧会话可解锁', en: 'Session locked: read-only; right-click the session on the left to unlock' },
  'an.emptyLine1': { zh: '在左侧文件树展开目录并选择文件，或直接发送消息', en: 'Expand a folder in the file tree on the left and pick a file, or just send a message' },
  'an.emptyLine2': { zh: '点击"开始分析"后，这里会实时展示每一步的执行过程与问题结果', en: 'After clicking "Start Analysis", every step and its results stream in here live' },
  'an.copyMsg': { zh: '复制消息内容', en: 'Copy message' },
  'an.me': { zh: '我', en: 'Me' },
  'an.phLocked': { zh: '会话已锁定，请先解锁', en: 'Session locked; unlock it first' },
  'an.phDescribe': { zh: '描述你的问题…', en: 'Describe your issue…' },
  'an.phPickFile': { zh: '请先在左侧选择文件', en: 'Pick a file on the left first' },
  'an.stopTip': { zh: '中断当前回复 / 扫描', en: 'Interrupt the current reply / scan' },
  'an.sendTip': { zh: '发送 (Enter)', en: 'Send (Enter)' },
  'an.hint.type': { zh: '输入', en: 'Type' },
  'an.hint.keyword': { zh: '分析', en: 'analyze' },
  'an.hint.pipeline': { zh: '触发检测流水线 · Enter 发送', en: 'to run the detection pipeline · Enter to send' },
  'an.copyReply': { zh: '复制回复内容', en: 'Copy reply' },
  'an.doneSummary': { zh: '检测完成 · {n} 个问题', en: 'Detection finished · {n} issues' },
  'an.composing': { zh: '正在组织回复…', en: 'Composing reply…' },
  'an.hasHigh': { zh: '存在高危项', en: 'high-severity issues found' },
  'an.noIssues': { zh: '未发现问题，代码质量良好。', en: 'No issues found — code quality looks good.' },
  'an.viewOriginal': { zh: '查看原代码', en: 'View original code' },
  'an.viewModified': { zh: '查看修改后代码', en: 'View modified code' },
  'an.confirmMod': { zh: '确认修改', en: 'Apply change' },
  'an.moreIdeas': { zh: '更多想法', en: 'More ideas' },
  'an.appliedSaved': { zh: '已应用并保存到文件', en: 'Applied and saved to file' },
  'an.undoTip': { zh: '将文件恢复为修改前内容', en: 'Restore the file to its pre-change content' },
  'an.undoMod': { zh: '撤销修改', en: 'Undo change' },
  'an.verifyTip': { zh: '重新扫描当前文件，验证修改效果', en: 'Rescan the current file to verify the change' },
  'an.verifyRescan': { zh: '重新扫描验证', en: 'Rescan to verify' },
  'an.undoneMsg': { zh: '已撤销，文件已恢复到修改前内容（可重新扫描确认）', en: 'Undone; the file was restored to its pre-change content (rescan to confirm)' },
  'an.rejectedMsg': { zh: '已取消该修改建议', en: 'This change suggestion was dismissed' },
  'an.supersededMsg': { zh: '已被新的修改方案取代', en: 'Superseded by a newer change' },
  'an.applyFail': { zh: '应用失败：{msg}', en: 'Apply failed: {msg}' },
  'an.unknownErr': { zh: '未知错误', en: 'Unknown error' },
  'an.tagLLM': { zh: '[大模型]', en: '[LLM]' },
  'an.tagLocal': { zh: '[本地]', en: '[Local]' },
  'an.exportReport': { zh: '导出 HTML 报告', en: 'Export HTML report' },
  'an.projReport': { zh: '项目扫描报告', en: 'Project Scan Report' },
  'an.scannedFiles': { zh: '扫描文件', en: 'Files scanned' },
  'an.scanFailed': { zh: '（失败 {n}）', en: ' ({n} failed)' },
  'an.totalIssues': { zh: '问题总数', en: 'Total issues' },
  'an.topFiles': { zh: '问题集中的文件', en: 'Files with most issues' },
  'an.nCount': { zh: '{n} 个', en: '{n}' },
  'an.llmTip': { zh: '模型 {model} · 共 {n} 次调用', en: 'Model {model} · {n} calls' },
  'an.unknown': { zh: '未知', en: 'unknown' },
  'an.fixThis': { zh: '修复此问题', en: 'Fix this issue' },
  'an.generating': { zh: '生成中…', en: 'Generating…' },
  'an.collapseList': { zh: '收起问题列表', en: 'Collapse list' },

  // ---------- Workbench（编辑模式 + 流水线） ----------
  'wb.pipeline.parse': { zh: '解析源码', en: 'Parse source' },
  'wb.pipeline.parseD': { zh: 'Tree-sitter 词法与语法解析', en: 'Tree-sitter lexing & syntax parsing' },
  'wb.pipeline.ast': { zh: '构建 AST', en: 'Build AST' },
  'wb.pipeline.astD': { zh: '抽象语法树与作用域分析', en: 'Abstract syntax tree & scope analysis' },
  'wb.pipeline.rules': { zh: '规则检测', en: 'Rule detection' },
  'wb.pipeline.rulesD': { zh: '缺陷规则与代码坏味道匹配', en: 'Defect rules & code smell matching' },
  'wb.pipeline.kb': { zh: '知识库比对', en: 'Knowledge base' },
  'wb.pipeline.kbD': { zh: 'RAG 检索相似案例与修复方案', en: 'RAG retrieval of similar cases & fixes' },
  'wb.pipeline.conclude': { zh: '生成结论', en: 'Conclude' },
  'wb.pipeline.concludeD': { zh: '汇总问题清单与优化建议', en: 'Summarize issues & optimization advice' },
  'wb.noFile': { zh: '未打开文件', en: 'No file open' },
  'wb.unsaved': { zh: '有未保存的修改', en: 'Unsaved changes' },
  'wb.tabUnsaved': { zh: '未保存', en: 'Unsaved' },
  'wb.locked': { zh: '会话已锁定', en: 'Session locked' },
  'wb.save': { zh: '保存到原文件', en: 'Save to file' },
  'wb.saving': { zh: '保存中…', en: 'Saving…' },
  'wb.saved': { zh: '已保存', en: 'Saved' },
  'wb.encoding': { zh: '文件编码：未修改时切换将按所选编码重读文件，修改后 Ctrl+S 以所选编码保存', en: 'File encoding: switching reloads the file when unmodified; Ctrl+S saves with it' },
  'wb.saveChanges': { zh: '保存修改', en: 'Save changes' },
  'wb.saveFail': { zh: '保存失败: {msg}', en: 'Save failed: {msg}' },
  'wb.cannotWrite': { zh: '无法写入文件', en: 'Cannot write the file' },
  'wb.writeFail': { zh: '写入文件失败: {msg}', en: 'Failed to write file: {msg}' },
  'wb.unknownErr': { zh: '未知错误', en: 'Unknown error' },
  'wb.scanFile': { zh: '扫描此文件', en: 'Scan this file' },
  'wb.scanning': { zh: '扫描中…', en: 'Scanning…' },
  'wb.scanStopped': { zh: '分析已停止', en: 'Analysis stopped' },
  'wb.analyzeFail': { zh: '分析失败，请确认本地服务已启动', en: 'Analysis failed; make sure the local service is running' },
  'wb.scanFail': { zh: '扫描失败，请确认本地服务已启动', en: 'Scan failed; make sure the local service is running' },
  'wb.emptyEditor': { zh: '从左侧文件树选择一个文件开始编辑与扫描', en: 'Pick a file from the tree to start editing and scanning' },
  'wb.emptyNoWs': { zh: '点击左侧"+ 新建"添加工作区后开始', en: 'Click "+ New" on the left to add a workspace and get started' },
  'wb.needFile': { zh: '当前没有打开的文件', en: 'No file is open' },
  'wb.needPath': { zh: '请输入或选择路径', en: 'Enter or select a path' },
  'wb.dupPath': { zh: '该路径已在列表中', en: 'Path is already in the list' },
  'wb.badPath': { zh: '目录不存在或无法读取', en: 'Directory not found or unreadable' },
  'wb.created': { zh: '工作区已创建,会话已就绪', en: 'Workspace created; session ready' },
  'wb.wsCreated': {
    zh: '已创建工作区「{name}」。在左侧文件树展开目录并选择一个文件开始分析，或直接发送你的问题。',
    en: 'Workspace "{name}" created. Expand the folder in the file tree and pick a file to analyze, or just send your question.'
  },
  'wb.lockedNoEdit': { zh: '会话已锁定，无法修改代码', en: 'Session locked; cannot modify code' },
  'wb.lockedUnlockFirst': { zh: '会话已锁定，请先在左侧右键解锁后再操作', en: 'Session locked; right-click it on the left to unlock first' },
  'wb.locateFail': {
    zh: '未能在当前文件中定位原始代码片段（文件可能已被修改），请手动检查后重试',
    en: 'Could not locate the original snippet in the file (it may have been modified); check manually and retry'
  },
  'wb.scheduledScan': { zh: '定时扫描（每 {n} 分钟）：{file}', en: 'Scheduled scan (every {n} min): {file}' },
  'wb.fileOpened': {
    zh: '已打开 {file}。发送消息或点击"开始分析"，我将展示完整的分析过程。',
    en: 'Opened {file}. Send a message or click "Start Analysis" to see the full analysis process.'
  },
  'wb.readFail': { zh: '文件读取失败', en: 'Failed to read the file' },
  'wb.analyzeFile': { zh: '分析 {file}', en: 'Analyze {file}' },
  'wb.cannedNoFile': {
    zh: '请先在左侧文件树中选择一个文件，我可以帮你分析其中的问题。',
    en: 'Pick a file from the tree on the left first, and I can help you analyze it.'
  },
  'wb.cannedNoResult': {
    zh: '我已了解 {file}。发送"分析"或点击"开始分析"触发完整检测流水线。',
    en: 'Got it — {file}. Send "analyze" or click "Start Analysis" to run the full detection pipeline.'
  },
  'wb.cannedSummary': {
    zh: '关于 {file}：共 {total} 个问题（高危 {high} 个）。点击问题卡片上的"修复"可生成优化 diff；发送"分析"可重新检测。',
    en: 'About {file}: {total} issues ({high} high severity). Click "Fix" on an issue card to generate an optimization diff; send "analyze" to scan again.'
  },
  'wb.modParseFail': {
    zh: '修改方案解析失败，请让 AI 重新给出方案。',
    en: 'Failed to parse the change proposal; ask the AI to provide it again.'
  },
  'wb.stoppedGen': { zh: '（已停止生成）', en: '(Generation stopped)' },
  'wb.llmFallback': { zh: '（大模型调用失败，已回退本地提示）', en: '(LLM call failed; fell back to the local reply)' },
  'wb.moreAsk': {
    zh: '这个方案我想再看看其他思路，请换一种不同的实现方式，重新给出修改建议和风险评估。',
    en: "I'd like to see other approaches for this proposal; please suggest a different implementation with updated advice and risk assessment."
  },
  'wb.verifyAsk': { zh: '重新分析验证：确认修改后的问题状态', en: 'Re-analyze to verify issue status after the change' },
  'wb.noBackup': { zh: '未找到修改前备份，无法撤销', en: 'No pre-change backup found; cannot undo' },
  'wb.undoFail': { zh: '撤销写回失败: {msg}', en: 'Undo write-back failed: {msg}' },
  'wb.scanningProject': { zh: '正在扫描整个项目 {file}…', en: 'Scanning the whole project {file}…' },
  'wb.projScanFail': { zh: '项目扫描失败：{msg}', en: 'Project scan failed: {msg}' },
  'wb.generatingReport': { zh: '正在生成 HTML 分析报告…', en: 'Generating HTML report…' },
  'wb.reportDone': {
    zh: '报告已生成：{path}\n（可用浏览器打开查看，路径已可选中复制）',
    en: 'Report generated: {path}\n(Open it in a browser; the path is selectable to copy.)'
  },
  'wb.reportFail': { zh: '报告生成失败：{msg}', en: 'Report generation failed: {msg}' },
  'wb.optimizeFail': { zh: '优化请求失败', en: 'Optimization request failed' },
  'wb.optimizeEmpty': { zh: 'AI 未返回有效代码（可能输出被截断），请重试', en: 'AI returned no valid code (possibly truncated), please retry' },
  'wb.tabOverflow': { zh: '全部已打开文件', en: 'All open files' },
  'wb.closeTab': { zh: '关闭标签页', en: 'Close tab' },
  'wb.copySel': { zh: '复制选中内容', en: 'Copy selection' },
  'wb.selectAllCode': { zh: '全选代码', en: 'Select all code' },
  'wb.issues': { zh: '问题', en: 'Issues' },
  'wb.issueCount': { zh: '{n} 个 · {lang}', en: '{n} · {lang}' },
  'wb.analyzingPipeline': {
    zh: '分析进行中：解析源码 → 构建AST → 规则检测 → RAG 比对 → 生成结论',
    en: 'Analyzing: parse source → build AST → rule detection → RAG matching → conclude'
  },
  'wb.pipelineDesc': {
    zh: '分析管线：Tree-sitter 解析 · 规则检测 · RAG 比对（完整过程见分析模式）',
    en: 'Pipeline: Tree-sitter parsing · rule detection · RAG matching (see Analysis mode for the full process)'
  },
  'wb.scanToSee': { zh: '扫描后在此显示检测结果', en: 'Run a scan to see results here' },
  'wb.analyzingFile': {
    zh: '正在分析 {file}，检测完成后结果会显示在这里…',
    en: 'Analyzing {file}; results will appear here when the scan completes…'
  },
  'wb.optimizing': { zh: '生成优化中…', en: 'Generating fix…' },
  'wb.noIssues': { zh: '未发现问题', en: 'No issues found' },
  'wb.moreIssues': { zh: '其余 {n} 条 · 前往分析模式查看', en: '{n} more · view in Analysis mode' },

  // ---------- DiffReview ----------
  'diff.title': { zh: '优化对比', en: 'Optimization Diff' },
  'diff.empty': { zh: '还没有待审查的优化结果', en: 'No optimization result to review yet' },
  'diff.emptyDesc': {
    zh: '在主工作区点击问题卡片上的"修复"按钮生成优化建议',
    en: 'Click "Fix" on an issue card in the workspace to generate a suggestion'
  },
  'diff.back': { zh: '返回主工作区', en: 'Back to workspace' },
  'diff.original': { zh: '原始代码', en: 'Original' },
  'diff.optimized': { zh: '优化后', en: 'Optimized' },
  'diff.apply': { zh: '应用到文件', en: 'Apply to file' },
  'diff.applied': { zh: '已应用到文件', en: 'Applied to file' },
  'diff.discard': { zh: '放弃', en: 'Discard' },
  'diff.copyOptimized': { zh: '复制优化后代码', en: 'Copy optimized code' },
  'diff.llmTag': { zh: '[大模型]', en: '[LLM]' },

  // ---------- Dashboard ----------
  'dash.empty': { zh: '暂无统计数据', en: 'No statistics yet' },
  'dash.emptyDesc': { zh: '执行一次项目扫描后,这里会展示质量概览', en: 'Run a project scan to see the quality overview here' },
  'dash.overview': { zh: '项目概览', en: 'Project Overview' },
  'dash.selectProject': { zh: '项目', en: 'Project' },
  'dash.scannedAt': { zh: '最近扫描', en: 'Last scan' },
  'dash.totalIssues': { zh: '缺陷总数', en: 'Total Issues' },
  'dash.fixed': { zh: '已修复', en: 'Fixed' },
  'dash.pending': { zh: '待处理', en: 'Pending' },
  'dash.fixRate': { zh: '修复率', en: 'Fix Rate' },
  'dash.severity': { zh: '严重度分布', en: 'Severity Distribution' },
  'dash.score': { zh: '质量评分', en: 'Quality Score' },
  'dash.languages': { zh: '语言分布', en: 'Languages' },
  'dash.topTypes': { zh: '高频问题类型', en: 'Top Issue Types' },
  'dash.high': { zh: '高危', en: 'High' },
  'dash.medium': { zh: '中危', en: 'Medium' },
  'dash.low': { zh: '低危', en: 'Low' },

  // ---------- CodeEditor ----------
  'ed.find': { zh: '查找', en: 'Find' },
  'ed.next': { zh: '下一个', en: 'Next' },
  'ed.prev': { zh: '上一个', en: 'Prev' },
  'ed.replaceWith': { zh: '替换为…', en: 'Replace with…' },
  'ed.replace': { zh: '替换', en: 'Replace' },
  'ed.replaceAll': { zh: '全部', en: 'All' },
  'ed.gotoLine': { zh: '跳转到行', en: 'Go to line' },
  'ed.lines': { zh: '共 {n} 行', en: '{n} lines' },
  'ed.noMatch': { zh: '未找到匹配项', en: 'No matches' },

  // ---------- AIDock（悬浮 AI 助手） ----------
  'ai.title': { zh: 'AI 助手', en: 'AI Assistant' },
  'ai.welcome': { zh: '聊代码、问问题,随时都可以问我', en: 'Ask me anything about your code' },
  'ai.inputPh': { zh: '询问当前代码或问题…', en: 'Ask about the current code…' },
  'ai.confirm.title': { zh: '代码修改确认', en: 'Confirm Code Change' },
  'ai.stopped': { zh: '已停止生成。', en: 'Generation stopped.' },
  'ai.risk.low': { zh: '低风险', en: 'Low risk' },
  'ai.risk.medium': { zh: '中风险', en: 'Medium risk' },
  'ai.risk.high': { zh: '高风险', en: 'High risk' },

  // ---------- Settings 未迁移部分 ----------
  'settings.workspace.title': { zh: '工作区', en: 'Workspaces' },
  'settings.check.title': { zh: '检查更新', en: 'Check Updates' },
  'settings.appearance.langDesc': {
    zh: '界面语言（全界面即时生效）',
    en: 'UI language (applies to the entire app instantly)'
  },

  // ---------- Settings：提供商展示名 / 模式徽章 / 关于 ----------
  'provider.name.zhipu': { zh: '智谱 AI (GLM)', en: 'Zhipu AI (GLM)' },
  'provider.name.tongyi': { zh: '通义千问', en: 'Tongyi Qianwen' },
  'provider.name.ollama': { zh: 'Ollama（本地）', en: 'Ollama (local)' },
  'provider.customTag': { zh: '自定义 · {name}', en: 'Custom · {name}' },
  'mode.badge.local': { zh: '本地', en: 'Local' },
  'mode.badge.cloud': { zh: '大模型', en: 'LLM' },
  'about.product': { zh: 'MR·SLIY 代码优化智能体', en: 'MR·SLIY Code Optimization Agent' },

  // ---------- 外观：主题名 / 缩放档位 ----------
  'theme.amber': { zh: '琥珀 · 暖纸', en: 'Amber · Warm Paper' },
  'theme.coral': { zh: '珊瑚 · 晚霞', en: 'Coral · Sunset' },
  'theme.forest': { zh: '林绿 · 晨雾', en: 'Forest · Morning Mist' },
  'theme.lake': { zh: '湖蓝 · 晴空', en: 'Lake Blue · Clear Sky' },
  'theme.berry': { zh: '莓紫 · 藤萝', en: 'Berry · Wisteria' },
  'theme.rose': { zh: '玫瑰 · 春樱', en: 'Rose · Spring Cherry' },
  'theme.slate': { zh: '石墨 · 冷杉', en: 'Graphite · Fir' },
  'theme.teal': { zh: '青潮 · 浅滩', en: 'Teal · Shallows' },
  'theme.indigo': { zh: '黛蓝 · 星野', en: 'Indigo · Starfield' },
  'theme.olive': { zh: '橄榄 · 原野', en: 'Olive · Meadow' },
  'scale.small': { zh: '小', en: 'Small' },
  'scale.standard': { zh: '标准', en: 'Standard' },
  'scale.large': { zh: '大', en: 'Large' },
  'scale.xl': { zh: '特大', en: 'X-Large' },

  // ---------- 外观：日 / 夜模式 ----------
  'appearance.daynight': { zh: '日 / 夜模式', en: 'Day / Night Mode' },
  'appearance.mode.light': { zh: '白天', en: 'Day' },
  'appearance.mode.dark': { zh: '黑夜', en: 'Night' },
  'appearance.mode.auto': { zh: '自动', en: 'Auto' },
  'appearance.mode.autoDesc': {
    zh: '自动：18:00 – 次日 7:00 使用黑夜模式，其余时间白天模式',
    en: 'Auto: night mode from 18:00 to 7:00, day mode otherwise'
  },

  // ---------- 通用：折叠 / 展开 ----------
  'common.collapse': { zh: '收起', en: 'Collapse' },
  'common.expand': { zh: '展开', en: 'Expand' },
  'llm.activeSummary': { zh: '当前使用：{name}', en: 'In use: {name}' },
  'llm.count': { zh: '{n} 个提供商', en: '{n} providers' },
  'updates.latest': { zh: '最新：{content}', en: 'Latest: {content}' },

  // ---------- 启动画面 ----------
  'splash.tagline': { zh: '代码优化智能体', en: 'Code Optimization Agent' },
  'splash.boot.init': { zh: '正在初始化引擎…', en: 'Initializing engine…' },
  'splash.boot.services': { zh: '正在启动后台服务…', en: 'Starting background services…' },
  'splash.boot.ready': { zh: '即将就绪', en: 'Almost ready' },

  // ---------- 通用错误兜底 ----------
  'err.requestFailed': { zh: '请求失败', en: 'Request failed' },
  'err.desktopOnlyInstall': { zh: '仅桌面端支持一键安装', en: 'One-click install is desktop-only' },
  'chat.interrupted': { zh: '（回复被中断，请重新发送）', en: '(Reply interrupted, please resend)' },

  // ---------- Settings：检查更新卡片补充 / 更新源提示 ----------
  'update.card.curVer': { zh: '当前版本 {ver}', en: 'Current version {ver}' },
  'llm.custom.tip': {
    zh: '接入任意 OpenAI 兼容接口（OneAPI、vLLM、私有部署等）',
    en: 'Connect any OpenAI-compatible endpoint (OneAPI, vLLM, self-hosted, etc.)'
  },
  'toast.sourceSaved': { zh: '更新源已保存', en: 'Update source saved' },

  // ---------- DiffReview 补充 ----------
  'diff.reviewTitle': { zh: 'AI 审查', en: 'AI Review' },
  'diff.legend': { zh: '(原始 → 优化后，绿色为新增 / 红色为删除)', en: '(original → optimized; green = added / red = removed)' },
  'diff.linesAdded': { zh: '+{n} 行', en: '+{n} lines' },
  'diff.linesRemoved': { zh: '-{n} 行', en: '-{n} lines' },
  'diff.copyExplanation': { zh: '复制 AI 说明', en: 'Copy AI explanation' },
  'diff.explainFallback': {
    zh: '此优化基于 AST 检测结果与知识库模式生成。',
    en: 'This optimization was generated from AST detection results and knowledge-base patterns.'
  },
  'diff.suggestions': { zh: '建议', en: 'Suggestions' },
  'diff.regenerate': { zh: '重新生成', en: 'Regenerate' },
  'diff.regenerating': { zh: '重新生成中…', en: 'Regenerating…' },
  'diff.regenerateFail': { zh: '重新生成失败', en: 'Regeneration failed' },
  'diff.regeneratePrompt': { zh: '重新生成优化方案', en: 'Regenerate the optimization proposal' },
  'diff.applyFail': { zh: '应用失败', en: 'Apply failed' },
  'diff.applying': { zh: '写入中…', en: 'Writing…' },
  'diff.appliedShort': { zh: '已应用', en: 'Applied' },
  'diff.written': { zh: '已写入文件 ✓', en: 'Written to file ✓' },

  // ---------- Dashboard 补充 ----------
  'dash.loadFail': { zh: '获取统计数据失败，请确认服务已启动', en: 'Failed to load statistics; make sure the service is running' },
  'dash.noData': { zh: '暂无数据', en: 'No data' },
  'dash.scoreDescDensity': {
    zh: '加权缺陷密度:高危×10 中危×3 低危×1,每千行代码 1 个加权缺陷扣 15 分',
    en: 'Weighted defect density: high×10 med×3 low×1; 15 points off per weighted defect per KLOC'
  },
  'dash.scoreDescLegacy': {
    zh: '项目行数未知(旧版本扫描),按加权缺陷数扣减;重新扫描后启用密度评分',
    en: 'Project size unknown (scanned by an older version), weighted count used; rescan to enable density scoring'
  },

  // ---------- CodeEditor 补充 ----------
  'ed.findPh': { zh: '查找（Enter 下一个 / Shift+Enter 上一个）', en: 'Find (Enter next / Shift+Enter prev)' },
  'ed.noResults': { zh: '无结果', en: 'No results' },
  'ed.hideReplace': { zh: '收起替换', en: 'Hide replace' },
  'ed.showReplace': { zh: '展开替换', en: 'Show replace' },
  'ed.replaceOne': { zh: '替换当前匹配', en: 'Replace current match' },
  'ed.replaceAllTip': { zh: '替换全部匹配', en: 'Replace all matches' },
  'ed.gotoPh': { zh: '跳转到行（1-{n}）', en: 'Go to line (1-{n})' },
  'ed.goto': { zh: '跳转', en: 'Go' },

  // ---------- 快捷键速查表（Ctrl+/） ----------
  'keys.title': { zh: '快捷键速查', en: 'Keyboard Shortcuts' },
  'keys.global': { zh: '全局', en: 'Global' },
  'keys.quickOpen': { zh: '快速打开文件', en: 'Quick open file' },
  'keys.cheat': { zh: '快捷键速查表', en: 'Shortcut cheat sheet' },
  'keys.save': { zh: '保存文件', en: 'Save file' },
  'keys.esc': { zh: '关闭弹层', en: 'Close dialog' },
  'keys.editor': { zh: '编辑器', en: 'Editor' },
  'keys.find': { zh: '查找 / 替换', en: 'Find / Replace' },
  'keys.gotoLine': { zh: '跳转到行', en: 'Go to line' },
  'keys.tab': { zh: '缩进', en: 'Indent' },
  'keys.autoPair': { zh: '自动补全括号 / 引号', en: 'Auto-pair brackets & quotes' },
  'keys.autoIndent': { zh: '自动缩进', en: 'Auto indent' },
  'keys.pairDel': { zh: '删除成对符号', en: 'Delete pair' },

  // ---------- Ctrl+P 快速打开 ----------
  'qo.ph': { zh: '输入文件名模糊搜索…', en: 'Type to fuzzy-search files…' },
  'qo.noWs': { zh: '先添加工作区', en: 'Add a workspace first' },
  'qo.noHit': { zh: '无匹配文件', en: 'No matching files' },
  'qo.nav': { zh: '选择', en: 'Navigate' },
  'qo.open': { zh: '打开', en: 'Open' },
  'qo.close': { zh: '关闭', en: 'Close' },

  // ---------- 工作区导航补充（重命名 / 过滤 / 全文搜索） ----------
  'nav.searchFail': { zh: '搜索失败', en: 'Search failed' },
  'nav.rename': { zh: '重命名会话', en: 'Rename session' },
  'nav.resetName': { zh: '恢复默认名', en: 'Reset name' },
  'nav.filterPh': { zh: '输入以过滤文件树…', en: 'Type to filter the file tree…' },
  'nav.filterTip': { zh: '文件树过滤（只显示匹配文件）', en: 'Filter the file tree (show matches only)' },
  'nav.searchTip': { zh: '跨文件全文搜索', en: 'Cross-file full-text search' },
  'nav.searchPh2': { zh: '搜索文件内容（至少 2 个字符）…', en: 'Search file contents (min 2 chars)…' },
  'nav.searching': { zh: '搜索中…', en: 'Searching…' },
  'nav.searchGo': { zh: '搜索', en: 'Search' },
  'nav.searchNoHit': { zh: '无匹配结果', en: 'No matches' },
  'nav.searchTrunc': { zh: '匹配过多，仅显示前 200 条', en: 'Too many matches; showing the first 200' },
  'nav.filtering': { zh: '过滤中…', en: 'Filtering…' },
  'nav.filterNoHit': { zh: '无匹配文件', en: 'No matching files' },
  'nav.renameTitle': { zh: '重命名会话', en: 'Rename Session' },
  'nav.renameHint': { zh: '仅修改显示名，不影响磁盘目录', en: 'Only changes the display name, not the folder' },
  'common.save': { zh: '保存', en: 'Save' },

  // ---------- AI 悬浮助手（AIDock）补充 ----------
  'ai.noFile': { zh: '未打开文件', en: 'No file open' },
  'ai.scanning': { zh: '正在扫描 {name}…', en: 'Scanning {name}…' },
  'ai.needScan': { zh: '{name} 还没有扫描结果，先点「扫描」再问我', en: 'No scan result for {name} yet — run a scan first' },
  'ai.summary': { zh: '{name} 共 {total} 个问题（高危 {high} 个）。可让我修复某个问题，或直接提问。', en: '{name} has {total} issues ({high} high). Ask me to fix one, or just ask.' },
  'ai.parseFail': { zh: '（修改方案解析失败）', en: '(Failed to parse the modification proposal)' },
  'ai.applyUnsupported': { zh: '当前上下文无法应用此修改', en: 'Cannot apply this change in the current context' },
  'ai.unknownErr': { zh: '未知错误', en: 'Unknown error' },
  'ai.askMoreIdeas': { zh: '再给我一些优化思路', en: 'Give me more optimization ideas' },
  'ai.assistant': { zh: 'AI 助手', en: 'AI Assistant' },
  'ai.tagCloud': { zh: '大模型', en: 'LLM' },
  'ai.tagLocal': { zh: '本地', en: 'Local' },
  'ai.collapse': { zh: '收起', en: 'Collapse' },
  'ai.copyContent': { zh: '复制内容', en: 'Copy content' },
  'ai.viewOriginal': { zh: '查看原始代码', en: 'View original code' },
  'ai.viewModified': { zh: '查看修改后代码', en: 'View modified code' },
  'ai.applying': { zh: '应用中…', en: 'Applying…' },
  'ai.confirmApply': { zh: '应用此修改', en: 'Apply this change' },
  'ai.moreIdeas': { zh: '换个思路', en: 'More ideas' },
  'ai.applied': { zh: '修改已应用 ✓', en: 'Change applied ✓' },
  'ai.rejected': { zh: '已放弃此修改', en: 'Change discarded' },
  'ai.superseded': { zh: '已被新方案取代', en: 'Superseded by a newer proposal' },
  'ai.applyFailed': { zh: '应用失败：{err}', en: 'Apply failed: {err}' },
  'ai.llmCalls': { zh: '本次回复 {n} 次大模型调用', en: '{n} LLM calls for this reply' },
  'ai.thinking': { zh: '思考中…', en: 'Thinking…' },
  'ai.stop': { zh: '停止生成', en: 'Stop generating' },
  'ai.streaming': { zh: '正在生成…', en: 'Generating…' },

  // ---------- 对话导出 Markdown ----------
  'wb.exportChat': { zh: '导出对话', en: 'Export chat' },
  'wb.exportChatDone': { zh: '对话已导出：{path}', en: 'Chat exported: {path}' },
  'wb.exportChatFail': { zh: '导出失败：{msg}', en: 'Export failed: {msg}' },
  'wb.exportChatEmpty': { zh: '当前会话暂无可导出的对话', en: 'Nothing to export in this session yet' },

  // ---------- Dashboard：质量趋势 / 两次扫描对比 ----------
  'dash.trend': { zh: '质量趋势', en: 'Quality Trend' },
  'dash.trendDesc': { zh: '按扫描任务的质量评分走势（近 {n} 次）', en: 'Quality score across recent scan tasks (last {n})' },
  'dash.trendEmpty': { zh: '暂无扫描任务（执行项目扫描后生成）', en: 'No scan tasks yet (created by project scans)' },
  'dash.compare': { zh: '两次扫描对比', en: 'Scan Comparison' },
  'dash.compareA': { zh: '基线', en: 'Baseline' },
  'dash.compareB': { zh: '对比', en: 'Compare' },
  'dash.compareGo': { zh: '开始对比', en: 'Compare' },
  'dash.compareEmpty': { zh: '至少需要两次已完成的扫描任务', en: 'At least two completed scan tasks required' },
  'dash.cmp.newIssues': { zh: '新增问题（{n}）', en: 'New issues ({n})' },
  'dash.cmp.resolved': { zh: '已解决问题（{n}）', en: 'Resolved issues ({n})' },
  'dash.cmp.countChange': { zh: '问题总数 {a} → {b}', en: 'Total issues {a} → {b}' },
  'dash.cmp.loadFail': { zh: '扫描问题读取失败', en: 'Failed to load scan issues' },

  // ---------- MCP 调用日志 ----------
  'mcp.logs.title': { zh: '调用日志（最近 {n} 条）', en: 'Call logs (last {n})' },
  'mcp.logs.refresh': { zh: '刷新', en: 'Refresh' },
  'mcp.logs.empty': { zh: '暂无调用记录', en: 'No calls yet' },
  'mcp.logs.col.time': { zh: '时间', en: 'Time' },
  'mcp.logs.col.tool': { zh: '工具', en: 'Tool' },
  'mcp.logs.col.transport': { zh: '通道', en: 'Channel' },
  'mcp.logs.col.elapsed': { zh: '耗时', en: 'Elapsed' },
  'mcp.logs.col.status': { zh: '状态', en: 'Status' },

  // ---------- 设置导入 / 导出 ----------
  'settings.io.title': { zh: '设置导入 / 导出', en: 'Settings Import / Export' },
  'settings.io.desc': {
    zh: '将外观、分析模式、编辑器字号等偏好导出为 JSON 文件备份，或从备份文件导入恢复',
    en: 'Export preferences (appearance, analysis mode, editor font size) as a JSON backup, or restore from one'
  },
  'settings.io.export': { zh: '导出设置', en: 'Export settings' },
  'settings.io.import': { zh: '导入设置', en: 'Import settings' },
  'settings.io.done': { zh: '设置已导入并应用 ✓', en: 'Settings imported and applied ✓' },
  'settings.io.exported': { zh: '设置已导出 ✓', en: 'Settings exported ✓' },
  'settings.io.fail': { zh: '操作失败：{msg}', en: 'Operation failed: {msg}' },
  'settings.io.badFile': { zh: '文件格式不正确', en: 'Invalid file format' }
};

const LANG_KEY = 'mrsliy.lang';
const listeners = new Set<() => void>();

let current: Lang = 'zh';
try {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === 'en' || saved === 'zh') current = saved;
} catch {
  /* 忽略 */
}

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  if (current === l) return;
  current = l;
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    /* 忽略 */
  }
  listeners.forEach((fn) => fn());
}

/** React 订阅：语言切换时触发重渲染 */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current
  );
}

/** 翻译：t('toast.saved', { name: 'DeepSeek' })；缺失词条时回退 key 本身 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const e = DICT[key];
  let s = e ? e[current] : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return s;
}
