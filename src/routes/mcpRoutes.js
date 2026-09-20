/**
 * MCP 接入状态路由：向 GUI 提供接入信息（协议版本、HTTP 端点、stdio 命令、工具清单），
 * 用于设置页生成 Claude Desktop / Cursor 等客户端的配置片段。
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const { success, error } = require('../utils/response');
const { logger } = require('../utils/logger');
const { SERVER_INFO, SUPPORTED_PROTOCOLS, TOOL_SUMMARIES, recentToolCalls } = require('../mcp/server');
const { config } = require('../config');
const externalMcp = require('../mcp/external');

router.get('/status', (req, res) => {
  const appRoot = path.join(__dirname, '..', '..');
  return res.json(
    success({
      protocolVersion: SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1],
      supportedProtocolVersions: SUPPORTED_PROTOCOLS,
      serverInfo: SERVER_INFO,
      httpUrl: `http://localhost:${config.server.port}/mcp`,
      stdio: {
        command: process.execPath,
        args: [path.join(appRoot, 'mcp-server.js')]
      },
      tools: TOOL_SUMMARIES
    })
  );
});

/**
 * MCP 工具调用日志：外部客户端（Claude Desktop / Cursor 等）通过 HTTP 或 stdio
 * 调用了哪些工具、参数摘要、耗时与成败。环形缓冲 200 条，新的在前。
 */
router.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  return res.json(success({ logs: recentToolCalls(limit) }));
});

/**
 * MCP 自检:设置页"检测可用性"按钮调用。
 * 不是回显静态配置——真实走一遍本进程的 HTTP 传输(POST /mcp):
 * initialize 握手 → tools/list → ping,三步全成功才算可用。
 * 每步记录耗时,失败时带出 JSON-RPC 错误信息。
 *
 * 注意探测地址必须用 localhost 而非 127.0.0.1:服务监听 config.server.host
 * (默认 localhost,在部分 Windows 环境解析为 IPv6 ::1),硬编码 127.0.0.1
 * 会在仅监听 IPv6 回环的机器上 fetch failed(实测本机)。
 */
router.get('/selftest', async (req, res) => {
  const url = `http://localhost:${config.server.port}/mcp`;

  /** 发送一条 JSON-RPC 请求并等待响应(无状态模式,单次 POST) */
  const rpc = async (method, params, id) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const started = Date.now();
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        signal: ctrl.signal
      });
      const elapsed = Date.now() - started;
      if (!r.ok) {
        let errText = `HTTP ${r.status}`;
        try {
          const j = await r.json();
          if (j && j.error) errText += `: ${j.error.message}`;
        } catch { /* 非 JSON 响应体 */ }
        return { ok: false, elapsed, error: errText };
      }
      const j = await r.json();
      if (j && j.error) return { ok: false, elapsed, error: `${j.error.code}: ${j.error.message}` };
      return { ok: true, elapsed, result: j && j.result };
    } catch (e) {
      return { ok: false, elapsed: Date.now() - started, error: e.name === 'AbortError' ? '请求超时(5s)' : e.message };
    } finally {
      clearTimeout(timer);
    }
  };

  const steps = [];

  // 1) initialize 握手
  const init = await rpc('initialize', {
    protocolVersion: SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1],
    capabilities: {},
    clientInfo: { name: 'mr-sliy-selftest', version: '1.0.0' }
  }, 1);
  steps.push({ step: 'initialize', ok: init.ok, elapsed: init.elapsed, error: init.error || '', serverInfo: init.ok ? init.result?.serverInfo || null : null });
  if (!init.ok) {
    return res.json(success({ available: false, url, steps }));
  }

  // 2) tools/list(验证工具注册表可枚举)
  const list = await rpc('tools/list', {}, 2);
  steps.push({ step: 'tools/list', ok: list.ok, elapsed: list.elapsed, error: list.error || '', toolCount: list.ok ? (list.result?.tools || []).length : 0 });
  if (!list.ok) {
    return res.json(success({ available: false, url, steps }));
  }

  // 3) ping 存活确认
  const ping = await rpc('ping', {}, 3);
  steps.push({ step: 'ping', ok: ping.ok, elapsed: ping.elapsed, error: ping.error || '' });

  return res.json(
    success({
      available: ping.ok,
      url,
      steps,
      totalMs: steps.reduce((s, x) => s + x.elapsed, 0),
      toolCount: steps[1].toolCount
    })
  );
});

// ============================ 外部 MCP 服务器（智能体作为 MCP 客户端主动连接其他应用） ============================

/** 服务器列表（配置 + 实时连接状态 + 工具清单） */
router.get('/external', (req, res) => {
  try {
    return res.json(success({ servers: externalMcp.listServers() }));
  } catch (err) {
    logger.error(`查询外部 MCP 服务器失败: ${err.message}`);
    return res.status(500).json(error(err.message));
  }
});

/** 出站调用日志（先于含参数路由无冲突，此处注册顺序仅保证语义清晰） */
router.get('/external/logs', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  return res.json(success({ logs: externalMcp.recentExternalCalls(limit) }));
});

/** 新增服务器配置 */
router.post('/external', (req, res) => {
  try {
    const server = externalMcp.addServer(req.body || {});
    return res.json(success({ server }));
  } catch (err) {
    return res.json(error(err.message));
  }
});

/** 更新服务器配置（已连接的自动断开，需重连） */
router.put('/external/:id', (req, res) => {
  try {
    const server = externalMcp.updateServer(req.params.id, req.body || {});
    return res.json(success({ server }));
  } catch (err) {
    return res.json(error(err.message));
  }
});

/** 删除服务器配置（已连接的先断开） */
router.delete('/external/:id', (req, res) => {
  try {
    externalMcp.removeServer(req.params.id);
    return res.json(success({ removed: true }));
  } catch (err) {
    return res.json(error(err.message));
  }
});

/** 扫描本机可用的 HTTP MCP 服务（监听端口枚举 + initialize 握手探测） */
router.post('/external/scan', async (req, res) => {
  try {
    const http = await externalMcp.scanHttpServers();
    return res.json(success({ http }));
  } catch (err) {
    logger.warn(`扫描本机 MCP 服务失败: ${err.message}`);
    return res.json(error(err.message));
  }
});

/** 连接服务器：initialize 握手 → tools/list，返回工具清单 */
router.post('/external/:id/connect', async (req, res) => {
  try {
    const server = await externalMcp.connectServer(req.params.id);
    return res.json(success({ server, tools: server.tools || [] }));
  } catch (err) {
    logger.warn(`外部 MCP 连接请求失败: ${err.message}`);
    return res.json(error(err.message));
  }
});

/** 断开服务器 */
router.post('/external/:id/disconnect', (req, res) => {
  try {
    externalMcp.disconnect(req.params.id);
    return res.json(success({ disconnected: true }));
  } catch (err) {
    return res.json(error(err.message));
  }
});

/** 手动调用外部工具：body = { tool, arguments } */
router.post('/external/:id/call', async (req, res) => {
  try {
    const { tool, arguments: toolArgs } = req.body || {};
    const result = await externalMcp.callTool(req.params.id, tool, toolArgs);
    return res.json(success({ result }));
  } catch (err) {
    logger.warn(`外部 MCP 工具调用失败: ${err.message}`);
    return res.json(error(err.message));
  }
});

module.exports = router;
