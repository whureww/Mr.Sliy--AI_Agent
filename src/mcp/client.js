/**
 * MCP 客户端核心：智能体主动连接外部 MCP 服务器（stdio / HTTP 两种传输）。
 *
 * 与本项目服务端（stdio.js / httpRouter.js）对称实现 JSON-RPC 2.0：
 * - stdio：spawn 子进程，换行分隔 JSON-RPC（MCP 官方 stdio 帧约定）
 * - HTTP：无状态 POST（Streamable HTTP 兼容，捕获 Mcp-Session-Id 回传）
 *
 * 统一接口：initialize() / listTools() / callTool(name, args) / close()，
 * 以及 request(method, params, { timeout }) 与 status 状态（disconnected/connected/error）。
 */

const { spawn } = require('child_process');
const { logger } = require('../utils/logger');

// 客户端支持的最新协议版本（服务端在支持列表内会原样返回，否则回落其最高版本）
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'mr-sliy', version: require('../../package.json').version };

const DEFAULT_TIMEOUT = 10000; // 握手 / tools/list 等
const TOOL_CALL_TIMEOUT = 60000; // 工具调用可能较慢（外部应用自身执行逻辑）

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return idCounter;
}

/** 触发 Reject 并清理超时定时器 */
function settle(entry, fn, value) {
  if (!entry || entry.settled) return;
  entry.settled = true;
  clearTimeout(entry.timer);
  fn(value);
}

/**
 * Windows 下 npx/npm/uvx 等是 .cmd 脚本，spawn 直接调用会 EINVAL，
 * 自动包装 cmd /c 执行（与 Claude Desktop 等 MCP 宿主行为一致）。
 */
function resolveSpawnCommand(command, args) {
  if (process.platform !== 'win32') return { command, args };
  const base = String(command || '').trim();
  const bare = base.toLowerCase().replace(/\.cmd$|\.bat$|\.exe$/, '');
  if (['npx', 'npm', 'uvx', 'uv', 'pnpm', 'yarn', 'bun'].includes(bare) || /\.(cmd|bat)$/i.test(base)) {
    return { command: 'cmd', args: ['/c', base, ...(args || [])] };
  }
  return { command: base, args: args || [] };
}

// ============================ stdio 传输 ============================

/**
 * 创建 stdio 客户端：spawn 外部 MCP 服务器子进程，按行读写 JSON-RPC。
 * 子进程崩溃 / 退出时状态置 disconnected 并 reject 所有在途请求。
 */
function createStdioClient({ name, command, args = [], cwd, env } = {}) {
  const state = { status: 'disconnected', lastError: '' };
  let child = null;
  let buf = '';
  /** id -> { resolve, reject, timer, settled } */
  const pending = new Map();

  const rejectAll = (message) => {
    for (const [, entry] of pending) settle(entry, entry.reject, new Error(message));
    pending.clear();
  };

  function handleLine(line) {
    const t = line.trim();
    if (!t) return;
    let msg;
    try {
      msg = JSON.parse(t);
    } catch {
      return; // 忽略子进程的非 JSON 输出（启动横幅等）
    }
    if (!msg || typeof msg !== 'object' || msg.id === undefined || msg.id === null) return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) {
      settle(entry, entry.reject, new Error(`${msg.error.code || ''} ${msg.error.message || '未知错误'}`.trim()));
    } else {
      settle(entry, entry.resolve, msg.result !== undefined ? msg.result : {});
    }
  }

  function start() {
    if (child) return;
    const resolved = resolveSpawnCommand(command, args);
    child = spawn(resolved.command, resolved.args, {
      cwd: cwd || undefined,
      env: { ...process.env, ...(env || {}) },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    state.status = 'connected'; // 进程已拉起；真正可用以 initialize 成功为准

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) logger.debug(`[mcp-client:${name}] stderr: ${text.slice(0, 500)}`);
    });
    child.on('error', (err) => {
      state.status = 'error';
      state.lastError = err.message;
      rejectAll(`子进程启动失败: ${err.message}`);
    });
    child.on('exit', (code) => {
      const wasConnected = state.status === 'connected';
      child = null;
      state.status = 'disconnected';
      if (wasConnected || pending.size > 0) {
        state.lastError = `外部服务器进程已退出（code ${code ?? 'N/A'}）`;
      }
      rejectAll(`外部服务器进程已退出（code ${code ?? 'N/A'}）`);
    });
  }

  function write(obj) {
    if (!child || !child.stdin || !child.stdin.writable) {
      throw new Error('stdio 通道未就绪（进程未启动或已退出）');
    }
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  async function request(method, params = {}, opts = {}) {
    start();
    const id = nextId();
    const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : DEFAULT_TIMEOUT;
    const p = new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        settled: false,
        timer: setTimeout(() => {
          pending.delete(id);
          reject(new Error(`请求超时（${timeout}ms）: ${method}`));
        }, timeout)
      };
      pending.set(id, entry);
    });
    try {
      write({ jsonrpc: '2.0', id, method, params });
    } catch (e) {
      const entry = pending.get(id);
      pending.delete(id);
      settle(entry, entry.reject, e);
      throw e;
    }
    return p;
  }

  function notify(method, params = {}) {
    start();
    write({ jsonrpc: '2.0', method, params }); // 通知无 id，不等待响应
  }

  return {
    transport: 'stdio',
    name,
    get status() {
      return state.status;
    },
    get lastError() {
      return state.lastError;
    },
    async initialize() {
      const result = await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO
      });
      notify('notifications/initialized');
      return result || {};
    },
    async listTools() {
      const result = await request('tools/list');
      return Array.isArray(result && result.tools) ? result.tools : [];
    },
    async callTool(toolName, toolArgs = {}) {
      return request('tools/call', { name: toolName, arguments: toolArgs }, { timeout: TOOL_CALL_TIMEOUT });
    },
    close() {
      if (child) {
        try {
          child.kill();
        } catch {
          /* 进程已退出时忽略 */
        }
        child = null;
      }
      state.status = 'disconnected';
      rejectAll('连接已关闭');
    }
  };
}

// ============================ HTTP 传输 ============================

/**
 * 创建 HTTP 客户端：无状态 POST JSON-RPC（与本项目 httpRouter.js 对称）。
 * initialize 时捕获 Mcp-Session-Id（若有）并在后续请求回传，兼容有状态 Streamable HTTP 服务器；
 * 响应为 text/event-stream 时按行抽取 data: JSON（取匹配 id 的那条）。
 */
function createHttpClient({ name, url, headers = {} } = {}) {
  const state = { status: 'disconnected', lastError: '' };
  let sessionId = '';

  async function post(body, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const h = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers
      };
      if (sessionId) h['Mcp-Session-Id'] = sessionId;
      const res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal: ctrl.signal });

      const sid = res.headers.get('mcp-session-id');
      if (sid) sessionId = sid;

      if (!res.ok) {
        let errText = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j && j.error) errText += `: ${j.error.message}`;
        } catch {
          /* 非 JSON 响应体 */
        }
        throw new Error(errText);
      }
      if (res.status === 202) return null; // 通知类：无响应体

      const ctype = String(res.headers.get('content-type') || '');
      if (ctype.includes('text/event-stream')) {
        // SSE 形式响应：读取全文，按行抽取 data: JSON，取匹配 id 的那条（否则最后一条带 result 的）
        const text = await res.text();
        let fallback = null;
        let matched = null;
        for (const line of text.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          try {
            const j = JSON.parse(t.slice(5).trim());
            if (j && j.id !== undefined && body && j.id === body.id) matched = j;
            if (j && (j.result !== undefined || j.error)) fallback = j;
          } catch {
            /* 忽略心跳/注释行 */
          }
        }
        const chosen = matched || fallback;
        if (!chosen) throw new Error('SSE 响应中未找到 JSON-RPC 结果');
        if (chosen.error) throw new Error(`${chosen.error.code || ''} ${chosen.error.message || '未知错误'}`.trim());
        return chosen.result !== undefined ? chosen.result : {};
      }

      const j = await res.json();
      if (j && j.error) throw new Error(`${j.error.code || ''} ${j.error.message || '未知错误'}`.trim());
      return j && j.result !== undefined ? j.result : {};
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error(`请求超时（${timeout}ms）: ${url}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(method, params = {}, opts = {}) {
    const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : DEFAULT_TIMEOUT;
    const result = await post({ jsonrpc: '2.0', id: nextId(), method, params }, timeout);
    state.status = 'connected';
    return result;
  }

  return {
    transport: 'http',
    name,
    get status() {
      return state.status;
    },
    get lastError() {
      return state.lastError;
    },
    async initialize() {
      try {
        const result = await request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO
        });
        return result || {};
      } catch (e) {
        state.status = 'error';
        state.lastError = e.message;
        throw e;
      }
    },
    async listTools() {
      const result = await request('tools/list');
      return Array.isArray(result && result.tools) ? result.tools : [];
    },
    async callTool(toolName, toolArgs = {}) {
      try {
        return await request('tools/call', { name: toolName, arguments: toolArgs }, { timeout: TOOL_CALL_TIMEOUT });
      } catch (e) {
        state.status = 'error';
        state.lastError = e.message;
        throw e;
      }
    },
    close() {
      state.status = 'disconnected';
      sessionId = '';
    }
  };
}

module.exports = {
  PROTOCOL_VERSION,
  CLIENT_INFO,
  createStdioClient,
  createHttpClient
};
