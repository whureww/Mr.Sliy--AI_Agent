<p align="center">
  <img src="gui/src/assets/logo.svg" width="120" alt="MR·SLIY">
</p>

<h1 align="center">MR·SLIY 代码优化智能体</h1>

<p align="center">
  <a href="https://github.com/whureww/Mr.Sliy--AI_Agent/releases/latest"><img src="https://img.shields.io/github/v/release/whureww/Mr.Sliy--AI_Agent?color=2EA043" alt="Release"></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2B-1F6FEB" alt="Windows 10+">
  <img src="https://img.shields.io/badge/node-%E2%89%A518-1F6FEB" alt="Node.js >= 18">
  <img src="https://img.shields.io/badge/license-MIT-2EA043" alt="MIT">
</p>

<p align="center">
  <a href="https://github.com/whureww/Mr.Sliy--AI_Agent">GitHub</a> · <a href="https://github.com/whureww/Mr.Sliy--AI_Agent/releases">Releases</a> · <a href="https://github.com/whureww/Mr.Sliy--AI_Agent/issues">Issues</a> · 简体中文 · <a href="README.en.md">English</a>
</p>

**检测有据，修改有门。** 基于 Tree-sitter 与 RAG 的多语言代码优化智能体——桌面端（Tauri 架构：React 前端 + Node.js Sidecar + Rust 外壳）与 CLI 双形态，同一套能力两种体验。

一套引擎覆盖 15+ 语言：JavaScript / TypeScript / Python / Java / Go / C++ / C# / Rust / Swift / Kotlin / PHP / Ruby / Scala 等。Tree-sitter WASM 解析器构建 AST，14+ 检测规则与 50+ 离线规则打底，3000+ 条 RAG 知识与 2100+ 优化案例增色，大模型（DeepSeek / 智谱 / 通义 / OpenAI / Ollama / OpenAI 兼容接口）综合决策收尾——离线模式下规则与知识库独立工作，不依赖任何 API；在线模式下流式输出、随时可中断。

> MR·SLIY 不是把扫描结果转发给大模型的"套壳"工具。LLM 在这里扮演**决策中枢**：围绕"思考 → 工具调用 → 观察"多轮循环，调度 AST 解析、规则检测、知识检索、代码修改、回滚验证等 25 个工具，把一次代码修改走完 **检测 → 风险分级 → Diff 确认 → 应用 → 自动验证** 的完整闭环。代码与数据始终留在本机，不上传任何第三方服务器。

## 演示

CLI 形态的完整交互（桌面端是对话流 + 问题卡片 + Diff 门控）：

```text
$ mr-sliy
  MR·SLIY v3.9.0
  ✓ 解析服务就绪 · 检测服务就绪 · 知识库就绪 (1.8s)

  › /analyze
  ? 分析方式：扫描项目
  ✓ 扫描 32 个文件 · 发现 6 个问题（高危 2 / 中危 3 / 低危 1）

  › /optimize
  [大模型] 建议：将回调改为 async/await，统一错误处理（风险：低）
  ? 确认应用此修改？(Y/n)
```

## 核心理念

**让修改可验证，而不只是可生成。** 大模型能写出正确代码，也能自信地写出错误代码。MR·SLIY 对 AI 输出保持怀疑：任何落盘的修改都要先过 Tree-sitter 重新解析，经过风险分级、Diff 确认门控，应用后自动验证——出问题一键回滚。

**静态规则打底，知识库增色，大模型收尾。** 离线模式下 50+ 规则引擎与 3000+ 条 RAG 知识（2100+ 优化案例）独立工作，不依赖任何 API；在线模式下大模型在前两者的分析结果上做综合决策，而不是从零开始猜。

**服务隔离，崩溃不传染。** 解析、检测、优化、知识库、LLM 五类服务跑在独立 Worker Threads 里，单一功能崩溃不影响其余服务。

## 功能

**代码分析与优化**

- 15+ 语言：JavaScript / TypeScript / Python / Java / Go / C++ / C# / Rust / Swift / Kotlin / PHP / Ruby / Scala 等
- Tree-sitter WASM 解析器构建 AST，内置 14+ 种检测规则
- 在线模式接入大模型（DeepSeek / 智谱 / 通义 / OpenAI / Ollama / OpenAI 兼容接口），流式输出、可中断
- 离线模式：本地规则引擎（50+ 规则、20+ 模式）+ RAG 知识库
- 代码修改风险分级确认门控，一键回滚
- 导出 HTML / Markdown 分析报告

**桌面体验**

- 双工作模式：分析模式（对话 + 检测流水线）/ 编辑模式（代码编辑为主，AI 收纳为悬浮助手）
- 编辑器：行级 Diff 高亮（AI 修改处按行标注）、括号自动补对与缩进、字号调节、Ctrl+G 行跳转、Ctrl+F 查找
- Ctrl+P 快速打开（文件名模糊搜索）、Ctrl+/ 快捷键速查表；问题卡片点击行号直达编辑器对应行
- 文件树按名称过滤、会话重命名、对话一键导出 Markdown
- 质量概览：质量评分趋势图与两次扫描对比（新增 / 已解决问题清单）
- 10 套主题配色 + 日 / 夜 / 自动三态，界面缩放可调，工作区布局可调
- 全自动对话记忆：每轮对话后自动提取偏好与约定注入后续上下文，支持跨对话共享或按工作区隔离
- 应用内检查更新：发现新版本、下载校验（sha256）、一键安装
- 设置导入 / 导出：外观、分析模式等偏好一键备份为 JSON，跨设备迁移

**可靠性与集成**

- 自持引擎：监控 → 分析 → 决策 → 执行 → 验证闭环，支持自更新、自修复与回滚
- MCP 接入：外部客户端经 Model Context Protocol（HTTP / stdio）调用智能体能力，设置页可查看最近的工具调用日志
- 双数据库：SQLite（本地）与 MySQL（云端）双向同步

## 快速上手

### 桌面端

1. **下载安装** —— 从 [Releases](https://github.com/whureww/Mr.Sliy--AI_Agent/releases/latest) 下载 `MRSLIY-Setup-*.exe`，无需额外环境
2. **配置模型** —— 设置页填入 LLM 提供商与 API Key（或直接用离线模式）
3. **开始分析** —— 左侧选文件，输入"分析"触发流水线（解析 → AST → 规则检测 → 知识库比对 → 结论），在问题卡片上点"修复"并确认 Diff

> v0.1.5 及更早版本因仓库迁移内置了失效更新地址，无法应用内自更新，请手动下载一次 v0.1.6，此后恢复常态。

### CLI

```bash
npm install -g mr-sliy
mr-sliy          # 仓库内运行：npm start
```

> 桌面端安装器同样内置 CLI：安装时勾选「安装命令行工具」，即可在任意终端直接运行 `mr-sliy`（使用内置 Node 运行时，无需安装 Node.js），卸载时自动清理。

| 命令 | 说明 |
|------|------|
| `/analyze` | 代码分析（分析文件 / 扫描项目） |
| `/optimize` | 交互式代码优化 |
| `/sustain` | AI 自持引擎（仪表盘 / 引擎控制 / 手动更新 / 手动修复） |
| `/config` | 配置管理（提供商 / 知识库 / 模式切换） |
| `/status` | 系统状态与健康检查 |
| `/help` | 帮助文档 |

输入 `/` 搜索命令，方向键选择，Tab 补全；子菜单中 `q` / `quit` 返回主菜单。

### 开发构建

环境要求：Node.js >= 18；桌面端打包另需 Rust 工具链与 Windows 10+（CLI 支持 Windows / macOS / Linux）。

```bash
npm install                              # 安装依赖（自动下载 Tree-sitter WASM）

npm run server                           # 仅启动后端 API（默认 3210 端口）
cd gui && npm install && npm run dev     # GUI 开发服务器

npx @tauri-apps/cli build                # 打包桌面应用
npm test                                 # 运行单元测试
```

版本三段式（每段最大 10，超限进位）：`npm run bump`（CLI）、`npm run bump:gui`（桌面 GUI，四处文件自动同步）。

## 工作原理

```text
┌─────────────────────────────────────────────┐
│  mrsliy-desktop.exe（Tauri / Rust 外壳）      │
│                                             │
│  React GUI（gui/）                           │
│  主工作区 / 优化对比 / 质量概览 / 设置         │
│                 │ HTTP（127.0.0.1 随机端口）  │
│  Node.js Sidecar（src/）                     │
│  Express API + Tree-sitter + RAG + LLM      │
└─────────────────────────────────────────────┘
```

分析流水线：**解析 → AST 构建 → 规则检测 → 知识库比对 → 结论**。每一步独立超时与容错，单步失败不阻塞整体。质量评分采用加权缺陷密度：按严重度加权、以千行代码为分母，避免"文件越大分越低"的失真。

| 目录 | 说明 |
|------|------|
| `gui/` | React + TypeScript + Vite 前端 |
| `src/` | Node.js 后端（Express 路由、检测服务、优化引擎、知识库、自更新） |
| `src-tauri/` | Rust 外壳（窗口管理、sidecar 拉起与健康检查） |
| `installer/` | Inno Setup 安装包脚本 |
| `docs/` | [architecture.md](docs/architecture.md) 架构设计文档 |
| `tests/` | 单元测试 |

## MCP 接入

设置页展示即用配置，外部客户端（如 Claude Desktop、Cline）可经两种传输调用：

- **HTTP**：`POST http://localhost:<port>/mcp`，JSON-RPC 2.0 无状态模式
- **stdio**：`node <安装目录>/mcp-server.js`

可用工具：`scan_code`、`scan_project`、`optimize_code`、`chat`、`search_knowledge`、`list_memories`、`add_memory`、`get_scan_history` 等。

## 数据、配置与安全

运行时数据位于 `~/.mr-sliy/`：

```text
~/.mr-sliy/
├── database/                  # SQLite 数据库
├── reports/                   # 导出的分析报告
├── logs/                      # 运行日志
├── chat_memory.json           # 对话记忆（跨对话全局共享）
├── chat_memory_<hash>.json    # 按工作区隔离的独立记忆
├── update_source.json         # 检查更新源地址
└── database_connections.json  # 云端数据库连接配置
```

- API Key 在设置页配置，存于本地数据库，不落明文；环境变量方式见 [.env.example](.env.example)
- 代码修改经风险分级确认门控，支持一键回滚
- 检查更新仅拉取版本清单；打开外部链接仅允许 http/https
- 不上传任何代码或数据到第三方服务器

## 路线图

- **MCP SSE 流式传输** —— 当前为无状态 POST 模式，SSE 通道在计划中
- **桌面端多平台** —— 当前安装包面向 Windows，macOS / Linux 构建在评估中

有想法或发现问题？欢迎提 [Issue](https://github.com/whureww/Mr.Sliy--AI_Agent/issues)。

## 支持项目

如果 MR·SLIY 对你有用：点一个 Star，或在 Issue 里附上你硬件与工作流下的使用反馈——真实的运行数据比什么都重要。

## 致谢

MR·SLIY 站在这些开源项目之上：

- [Tree-sitter](https://github.com/tree-sitter/tree-sitter) 与 [web-tree-sitter](https://github.com/tree-sitter/web-tree-sitter) —— 多语言增量解析
- [Tauri](https://github.com/tauri-apps/tauri) —— 桌面外壳与 sidecar 架构
- [React](https://github.com/facebook/react) / [Vite](https://github.com/vitejs/vite) / [Express](https://github.com/expressjs/express) —— 前后端骨架
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) —— 本地存储
- [prismjs](https://github.com/PrismJS/prism) —— 代码高亮

## 许可证

MIT（见 [package.json](package.json)）。

## 更新日志

完整历史见 [GitHub Releases](https://github.com/whureww/Mr.Sliy--AI_Agent/releases)。

### v0.2.0（2026-09-17）

- 修复：设置页发起更新下载后，顶部更新横幅不同步（两处 UI 各自持有独立下载状态；新增共享 store 双向订阅，任一侧开始下载 / 进度 / 完成 / 取消即时同步）
- 修复：编辑器多标签溢出后下拉面板被裁剪不可见（下拉面板挂在被 overflow:hidden 裁剪的容器内；拆分外层承载面板 / 内层裁剪平铺标签）
- 改进：编辑器多标签溢出改为部分折叠——放得下的保持平铺，仅放不下的收进 ▼ 下拉（按钮显示溢出数量）
- 改进：编辑模式布局——问题面板展开不再挤压编辑器（grid 中栏 minmax(0,1fr) 防长路径撑爆 min-content），空间不足时仅文件路径收缩为省略号，编码 / 保存 / 扫描按钮始终完整可见

### v0.1.10（2026-09-16）

- 修复：启动动画结束后主工作区偶发不显示 / 页面切换频繁闪动（WebView2 合成器停滞时 routeIn 动画被冻结在 from 帧，淡入改由内联样式瞬时翻转，不再依赖合成器）
- 修复：编辑模式同一文件双击 / 连点开出多个重复标签页（打开竞态：在途守卫 + 提交时二次查重）
- 修复：多标签页打开过多后页面卡死（标签栏溢出检测用 display:none 隐藏导致测量值震荡，ResizeObserver 无限翻转；改用 visibility 保留占位并跳过不可见容器）

### v0.1.7（2026-09-14）

- 编辑器：AI 修改处行级 Diff 高亮、括号自动补对与自动缩进、字号设置（小 / 标准 / 大 / 特大）
- 全局快捷键：Ctrl+P 快速打开（文件名模糊搜索）、Ctrl+/ 快捷键速查表；问题卡片行号点击直达编辑器对应行
- 质量概览：质量评分趋势图、两次扫描对比（新增 / 已解决问题清单）
- 设置页：MCP 工具调用日志（最近 50 条，含通道与耗时）、设置导入 / 导出（JSON 备份）
- 工作区：文件树按名称过滤、会话重命名、对话一键导出 Markdown；跨文件全文搜索
- MCP Server：`tools/call` 全链路调用日志（HTTP / stdio 双通道）
- 修复：开发模式健康检查硬编码 127.0.0.1 在服务器绑定 IPv6 时连接被拒

### v0.1.6（2026-09-14）

- 修复"无法连接 GitHub（HTTP 301）"：仓库迁移后旧地址被永久重定向，而清单拉取未跟随重定向——更新源改为新仓库地址，并支持跟随 301/302/307/308
- 注：v0.1.5 及更早版本无法应用内自更新，请从 Release 页手动下载一次本版

### v0.1.5（2026-09-14）

- 修复分析模式发送按钮不随主题色：禁用态底色/图标色改为由当前主题色实时派生
- 更新下载改为手动触发、支持取消

### v0.1.4（2026-09-14）

- 全自动对话记忆（零操作）与跨对话记忆开关
- 质量评分改为加权缺陷密度；编辑模式 AI 对话流式输出
- MCP 可用性自检；主工作区布局可调
