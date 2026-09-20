/**
 * 外部 MCP 服务器连接管理器（智能体作为 MCP 宿主/客户端）
 *
 * - 配置持久化：sys_config 表 config_key = 'mcp_external_servers'（JSON 数组），
 *   读写模式与 providers.js 的 restoreActiveProvider 一致
 * - 连接生命周期：手动连接/断开（不在启动时自动 spawn 未知进程）
 * - 工具发现与手动调用：initialize → tools/list → tools/call
 * - 出站调用日志：环形缓冲 200 条（entry 结构对齐 server.js 的 logToolCall）
 *
 * 本模块只做管理面（设置页 + 手动调用）；对话链路的 <TOOL_CALL> 提示词协议为后续迭代，
 * 届时可直接复用 connectServer/listTools/callTool。
 */

const { spawn } = require('child_process');
const { logger } = require('../utils/logger');
const { queryOne, execute } = require('../utils/database');
const { generateUUID } = require('../utils/helpers');
const { createStdioClient, createHttpClient } = require('./client');

const CONFIG_KEY = 'mcp_external_servers';
const CALL_LOGS_CAP = 200;
const RESULT_CLIP = 4000; // 工具结果文本截断，防止撑爆前端/日志（对齐 tools.js 的 clip 口径）
const ARGS_CLIP = 300; // 参数摘要截断（对齐 server.js summarizeArgs）

// ---------- 出站调用日志 ----------

const CALL_LOGS = [];

function logExternalCall(entry) {
  CALL_LOGS.push(entry);
  if (CALL_LOGS.length > CALL_LOGS_CAP) CALL_LOGS.splice(0, CALL_LOGS.length - CALL_LOGS_CAP);
}

/** 最近的出站工具调用记录（新的在前），供设置页查看调用了哪些外部工具 */
function recentExternalCalls(limit = 50) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  return CALL_LOGS.slice(-n).reverse();
}

/** 参数摘要：截断，避免日志被大参数撑爆 */
function summarizeArgs(args) {
  try {
    const s = JSON.stringify(args) || '';
    return s.length > ARGS_CLIP ? s.slice(0, ARGS_CLIP) + `…(${s.length} chars)` : s;
  } catch {
    return '[unserializable]';
  }
}

// ---------- 配置持久化 ----------

const configs = [];
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const row = queryOne('SELECT config_value FROM sys_config WHERE config_key = ?', [CONFIG_KEY]);
    if (row && row.config_value) {
      const arr = JSON.parse(row.config_value);
      if (Array.isArray(arr)) {
        for (const c of arr) {
          if (c && typeof c === 'object' && c.id && c.name) configs.push(c);
        }
      }
    }
  } catch (e) {
    logger.warn(`加载外部 MCP 服务器配置失败: ${e.message}`);
  }
}

function persist() {
  try {
    execute(
      'INSERT OR REPLACE INTO sys_config (config_key, config_value, config_type, description, is_public) VALUES (?, ?, ?, ?, ?)',
      [CONFIG_KEY, JSON.stringify(configs), 'json', '外部MCP服务器连接配置（智能体作为MCP客户端主动连接）', 0]
    );
  } catch (e) {
    logger.error(`保存外部 MCP 服务器配置失败: ${e.message}`);
    throw new Error('保存配置失败：数据库写入异常');
  }
}

/**
 * 校验并规范化服务器配置。stdio 必须有 command；http 必须有合法 url。
 */
function sanitizeServer(input, existing = null) {
  const src = input && typeof input === 'object' ? input : {};
  const name = String(src.name || (existing && existing.name) || '').trim();
  const transport = String(src.transport || (existing && existing.transport) || 'stdio').toLowerCase();
  if (!name) throw new Error('缺少服务器名称');
  if (!['stdio', 'http'].includes(transport)) throw new Error('传输方式必须是 stdio 或 http');

  const out = {
    id: (existing && existing.id) || String(src.id || '').trim() || generateUUID(),
    name: name.slice(0, 60),
    transport,
    enabled: src.enabled === undefined ? (existing ? !!existing.enabled : true) : !!src.enabled,
    description: String(src.description || (existing && existing.description) || '').slice(0, 200),
    createdAt: (existing && existing.createdAt) || new Date().toISOString()
  };

  if (transport === 'stdio') {
    const command = String(src.command || (existing && existing.command) || '').trim();
    if (!command) throw new Error('stdio 传输必须提供 command');
    let args = src.args !== undefined ? src.args : (existing && existing.args) || [];
    if (typeof args === 'string') args = args.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(args)) args = [];
    out.command = command.slice(0, 500);
    out.args = args.map((a) => String(a)).slice(0, 50);
    out.cwd = String(src.cwd || (existing && existing.cwd) || '').trim().slice(0, 500);
  } else {
    const url = String(src.url || (existing && existing.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('http 传输必须提供 http(s):// 开头的 URL');
    let hdrs = src.headers !== undefined ? src.headers : (existing && existing.headers) || {};
    if (typeof hdrs === 'string') {
      try {
        hdrs = JSON.parse(hdrs || '{}');
      } catch {
        throw new Error('headers 必须是合法 JSON 对象');
      }
    }
    if (!hdrs || typeof hdrs !== 'object' || Array.isArray(hdrs)) hdrs = {};
    out.url = url.slice(0, 1000);
    out.headers = Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [String(k).slice(0, 100), String(v).slice(0, 500)]));
  }
  return out;
}

// ---------- 连接内存态 ----------

/** id -> { client, tools: [], lastError: '', connectedAt: ISO|null } */
const connections = new Map();

function liveState(id) {
  const conn = connections.get(id);
  if (!conn) return { status: 'disconnected', lastError: '', toolCount: 0, tools: [], connectedAt: null };
  const st = conn.client ? conn.client.status : 'disconnected';
  return {
    status: conn.lastError && st !== 'connected' ? 'error' : st,
    lastError: conn.lastError || '',
    toolCount: Array.isArray(conn.tools) ? conn.tools.length : 0,
    tools: Array.isArray(conn.tools) ? conn.tools : [],
    connectedAt: conn.connectedAt || null
  };
}

function disconnectServer(id) {
  const conn = connections.get(id);
  if (conn) {
    try {
      conn.client.close();
    } catch {
      /* 忽略关闭异常 */
    }
    connections.delete(id);
    logger.info(`已断开外部 MCP 服务器: ${id}`);
  }
}

// ---------- 对外 API ----------

/** 服务器列表（配置 + 实时连接状态合并） */
function listServers() {
  ensureLoaded();
  return configs.map((c) => ({ ...c, ...liveState(c.id) }));
}

/** 新增服务器配置 */
function addServer(input) {
  ensureLoaded();
  const server = sanitizeServer(input);
  if (configs.some((c) => c.name.toLowerCase() === server.name.toLowerCase())) {
    throw new Error(`已存在同名服务器: ${server.name}`);
  }
  configs.push(server);
  persist();
  logger.info(`新增外部 MCP 服务器: ${server.name} (${server.transport})`);
  return { ...server, ...liveState(server.id) };
}

/** 更新服务器配置；已连接的先断开（传输参数可能已变化，需重连） */
function updateServer(id, input) {
  ensureLoaded();
  const idx = configs.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error('服务器不存在');
  const server = sanitizeServer(input, configs[idx]);
  if (configs.some((c, i) => i !== idx && c.name.toLowerCase() === server.name.toLowerCase())) {
    throw new Error(`已存在同名服务器: ${server.name}`);
  }
  configs[idx] = server;
  disconnectServer(id);
  persist();
  return { ...server, ...liveState(server.id) };
}

/** 删除服务器配置；已连接的先断开 */
function removeServer(id) {
  ensureLoaded();
  const idx = configs.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error('服务器不存在');
  disconnectServer(id);
  const [removed] = configs.splice(idx, 1);
  persist();
  logger.info(`删除外部 MCP 服务器: ${removed.name}`);
  return removed;
}

/**
 * 连接服务器：initialize 握手 → tools/list。
 * 连接失败状态置 error 并抛出（lastError 随 listServers 返回）。
 */
async function connectServer(id) {
  ensureLoaded();
  const cfg = configs.find((c) => c.id === id);
  if (!cfg) throw new Error('服务器不存在');
  if (!cfg.enabled) throw new Error('该服务器已禁用，请先启用');

  disconnectServer(id); // 重建干净连接
  const client =
    cfg.transport === 'stdio'
      ? createStdioClient({ name: cfg.name, command: cfg.command, args: cfg.args || [], cwd: cfg.cwd || undefined })
      : createHttpClient({ name: cfg.name, url: cfg.url, headers: cfg.headers || {} });

  const conn = { client, tools: [], lastError: '', connectedAt: null };
  connections.set(id, conn);
  try {
    await client.initialize();
    conn.tools = await client.listTools();
    conn.connectedAt = new Date().toISOString();
    logger.info(`已连接外部 MCP 服务器: ${cfg.name}（${conn.tools.length} 个工具）`);
    return { ...cfg, ...liveState(id) };
  } catch (e) {
    conn.lastError = e.message;
    try {
      client.close();
    } catch {
      /* 忽略 */
    }
    connections.set(id, conn); // 保留 lastError 供列表展示
    logger.warn(`连接外部 MCP 服务器失败 ${cfg.name}: ${e.message}`);
    throw new Error(`连接失败: ${e.message}`);
  }
}

function disconnect(id) {
  ensureLoaded();
  if (!configs.some((c) => c.id === id)) throw new Error('服务器不存在');
  disconnectServer(id);
}

/**
 * 手动调用外部工具（本期唯一触发路径；对话链路的自动调用为后续迭代）。
 * 返回统一结构：{ tool, server, text, isError, elapsedMs }，文本超长截断。
 */
async function callTool(serverId, toolName, toolArgs) {
  ensureLoaded();
  const cfg = configs.find((c) => c.id === serverId);
  if (!cfg) throw new Error('服务器不存在');
  const conn = connections.get(serverId);
  if (!conn) throw new Error(`服务器「${cfg.name}」未连接，请先连接`);
  if (!toolName || typeof toolName !== 'string') throw new Error('缺少工具名 tool');
  if (conn.tools.length > 0 && !conn.tools.some((t) => t && t.name === toolName)) {
    throw new Error(`服务器「${cfg.name}」未提供工具: ${toolName}`);
  }
  const args = toolArgs === undefined || toolArgs === null ? {} : toolArgs;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('工具参数 arguments 必须是 JSON 对象');
  }

  const started = Date.now();
  try {
    const result = await conn.client.callTool(toolName, args);
    const elapsedMs = Date.now() - started;

    // MCP tools/call 结果：{ content: [{type:'text',text}|...], isError?, structuredContent? }
    const parts = Array.isArray(result && result.content) ? result.content : [];
    const text = parts
      .map((p) => {
        if (!p || typeof p !== 'object') return '';
        if (p.type === 'text' && typeof p.text === 'string') return p.text;
        return `[${p.type || 'unknown'} 内容已省略]`;
      })
      .filter(Boolean)
      .join('\n');
    const clipped = text.length > RESULT_CLIP ? text.slice(0, RESULT_CLIP) + `\n…（已截断，共 ${text.length} 字符）` : text;
    const isError = !!(result && result.isError);

    logExternalCall({
      ts: new Date().toISOString(),
      server: cfg.name,
      tool: String(toolName),
      args: summarizeArgs(args),
      ok: !isError,
      error: isError ? clipped.slice(0, 200) : '',
      elapsedMs,
      transport: `client:${cfg.transport}`
    });

    return { tool: String(toolName), server: cfg.name, text: clipped, isError, elapsedMs };
  } catch (e) {
    const elapsedMs = Date.now() - started;
    logExternalCall({
      ts: new Date().toISOString(),
      server: cfg.name,
      tool: String(toolName),
      args: summarizeArgs(args),
      ok: false,
      error: String(e.message || '').slice(0, 200),
      elapsedMs,
      transport: `client:${cfg.transport}`
    });
    throw e;
  }
}

// ---------- 扫描发现（本机 HTTP MCP 服务探测） ----------

/** 除系统监听端口外额外尝试的常见 MCP 端口 */
const COMMON_PORTS = [3000, 3001, 8000, 8001, 8080, 8888, 9000, 5000, 1337, 6274];
const SCAN_PROBE_TIMEOUT = 2000; // 单次握手/工具发现探测预算
const SCAN_CONCURRENCY = 16;
const SCAN_CANDIDATE_CAP = 100; // 候选端口上限，防止极端环境扫描过久

/**
 * 枚举本机 TCP 监听端口（仅取本机可达地址）。
 * Windows 用 netstat -ano；其他平台优先 ss -ltn。失败返回空集合（回落 COMMON_PORTS）。
 */
function getLocalListeningPorts() {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'netstat' : 'ss', isWin ? ['-ano', '-p', 'tcp'] : ['-ltn'], { windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.on('error', () => resolve(new Set()));
    child.on('close', () => {
      const ports = new Set();
      if (isWin) {
        // TCP    127.0.0.1:3000    0.0.0.0:0    LISTENING    8320
        for (const m of out.matchAll(/^\s*TCP\S*\s+\[?([^\]\s]+)\]?:(\d+)\s+\S+\s+LISTENING/gim)) {
          const addr = m[1].toLowerCase();
          if (['127.0.0.1', '0.0.0.0', '::1', '::'].includes(addr)) ports.add(Number(m[2]));
        }
      } else {
        // LISTEN 0 128 127.0.0.1:3000 0.0.0.0:*
        for (const m of out.matchAll(/^\s*LISTEN\s+\d+\s+\d+\s+(\[?([^\s\]]+)\]?|\*):(\d+)\s/gim)) {
          const addr = (m[2] || '*').toLowerCase();
          if (['127.0.0.1', '0.0.0.0', '::1', '::', '*'].includes(addr)) ports.add(Number(m[3]));
        }
      }
      resolve(ports);
    });
  });
}

/** 对单个 url 做一次 MCP 握手探测，成功返回服务器信息（失败抛错由调用方忽略） */
async function probeHttpServer(url) {
  const client = createHttpClient({ name: 'mcp-scan', url });
  try {
    const init = await Promise.race([
      client.initialize(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('scan timeout')), SCAN_PROBE_TIMEOUT))
    ]);
    let tools = [];
    try {
      tools = await Promise.race([
        client.listTools(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('scan timeout')), SCAN_PROBE_TIMEOUT))
      ]);
    } catch {
      tools = []; // 可握手但工具发现失败仍算发现成功
    }
    return {
      url,
      name: (init && init.serverInfo && init.serverInfo.name) || '',
      protocolVersion: (init && init.protocolVersion) || '',
      toolCount: tools.length
    };
  } finally {
    try {
      client.close();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 扫描本机可用的 HTTP MCP 服务器：
 * 系统监听端口 + 常见端口，对每个端口依次探测 /mcp 与 / 路径，
 * initialize 握手成功即视为发现。并发受限，非 MCP 端口握手失败即跳过。
 */
async function scanHttpServers() {
  const started = Date.now();
  const portSet = await getLocalListeningPorts();
  for (const p of COMMON_PORTS) portSet.add(p);
  const ports = [...portSet].sort((a, b) => a - b).slice(0, SCAN_CANDIDATE_CAP);
  const candidates = [];
  for (const port of ports) {
    candidates.push({ port, path: '/mcp' });
    candidates.push({ port, path: '/' });
  }

  const found = [];
  let idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      const { port, path } = candidates[idx++];
      try {
        const info = await probeHttpServer(`http://127.0.0.1:${port}${path}`);
        info.via = path;
        found.push(info);
      } catch {
        /* 非 MCP 或不可达，跳过 */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, candidates.length) }, worker));
  found.sort((a, b) => a.url.localeCompare(b.url));
  logger.info(`扫描本机 MCP 服务完成: ${ports.length} 端口，发现 ${found.length} 个（${Date.now() - started}ms）`);
  return found;
}

module.exports = {
  listServers,
  addServer,
  updateServer,
  removeServer,
  connectServer,
  disconnect,
  callTool,
  recentExternalCalls,
  scanHttpServers
};
