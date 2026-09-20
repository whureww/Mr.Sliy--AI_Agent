<p align="center">
  <img src="gui/src/assets/logo.svg" width="120" alt="MR·SLIY">
</p>

<h1 align="center">MR·SLIY Code Optimization Agent</h1>

<p align="center">
  <a href="https://github.com/whureww/Mr.Sliy--AI_Agent/releases/latest"><img src="https://img.shields.io/github/v/release/whureww/Mr.Sliy--AI_Agent?color=2EA043" alt="Release"></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2B-1F6FEB" alt="Windows 10+">
  <img src="https://img.shields.io/badge/node-%E2%89%A518-1F6FEB" alt="Node.js >= 18">
  <img src="https://img.shields.io/badge/license-MIT-2EA043" alt="MIT">
</p>

<p align="center">
  <a href="https://github.com/whureww/Mr.Sliy--AI_Agent">GitHub</a> · <a href="https://github.com/whureww/Mr.Sliy--AI_Agent/releases">Releases</a> · <a href="https://github.com/whureww/Mr.Sliy--AI_Agent/issues">Issues</a> · <a href="README.md">简体中文</a> · English
</p>

**Evidence-based detection, gated modification.** A multilingual code optimization agent built on Tree-sitter and RAG — available as a desktop app (Tauri architecture: React frontend + Node.js sidecar + Rust shell) and a CLI, one capability set with two experiences.

One engine covers 15+ languages: JavaScript / TypeScript / Python / Java / Go / C++ / C# / Rust / Swift / Kotlin / PHP / Ruby / Scala, and more. Tree-sitter WASM parsers build ASTs; 14+ detection rules and 50+ offline rules form the foundation; 3,000+ RAG knowledge entries and 2,100+ optimization cases enrich the analysis; LLMs (DeepSeek / Zhipu / Qwen / OpenAI / Ollama / OpenAI-compatible endpoints) make the final synthesis — in offline mode the rules and knowledge base work standalone without any API, while online mode streams output and can be interrupted at any time.

> MR·SLIY is not a "wrapper" that forwards scan results to an LLM. Here the LLM acts as the **decision-making hub**: through a multi-turn loop of *think → tool call → observe*, it orchestrates 25 tools — AST parsing, rule detection, knowledge retrieval, code modification, rollback verification — to carry a single code change through the full closed loop of **detect → risk grading → diff confirmation → apply → automatic verification**. Code and data never leave your machine; nothing is uploaded to third-party servers.

## Demo

A complete CLI session (the desktop app presents the same flow as a chat stream with issue cards and diff gating):

```text
$ mr-sliy
  MR·SLIY v3.9.0
  ✓ Parser ready · Detection ready · Knowledge base ready (1.8s)

  › /analyze
  ? Analysis mode: scan project
  ✓ Scanned 32 files · 6 issues found (2 high / 3 medium / 1 low)

  › /optimize
  [LLM] Suggestion: replace callbacks with async/await and unify error handling (risk: low)
  ? Apply this modification? (Y/n)
```

## Core Philosophy

**Make modifications verifiable, not just generatable.** LLMs can write correct code — and confidently write wrong code. MR·SLIY stays skeptical of AI output: every change that touches disk must first pass Tree-sitter re-parsing, go through risk grading and diff confirmation gating, and is verified automatically after applying — with one-click rollback when anything goes wrong.

**Static rules first, knowledge base next, LLM last.** In offline mode, the 50+ rule engine and 3,000+ RAG knowledge entries (2,100+ optimization cases) work standalone without any API. In online mode, the LLM makes synthesis decisions on top of those analysis results instead of guessing from scratch.

**Isolated services, contained crashes.** Parsing, detection, optimization, knowledge base, and LLM services run in separate Worker Threads — a single feature crash never takes down the rest.

## Features

**Code analysis & optimization**

- 15+ languages: JavaScript / TypeScript / Python / Java / Go / C++ / C# / Rust / Swift / Kotlin / PHP / Ruby / Scala, and more
- Tree-sitter WASM parsers build ASTs, with 14+ built-in detection rules
- Online mode connects to LLMs (DeepSeek / Zhipu / Qwen / OpenAI / Ollama / OpenAI-compatible endpoints) with streaming output and interruption
- Offline mode: local rule engine (50+ rules, 20+ patterns) + RAG knowledge base
- Risk-graded confirmation gating for code modifications, with one-click rollback
- Export analysis reports as HTML / Markdown

**Desktop experience**

- Dual work modes: Analysis mode (chat + detection pipeline) / Edit mode (code editing first, AI as a floating assistant)
- Editor: line-level diff highlighting (AI-modified lines annotated), auto bracket pairing & indentation, font size presets, Ctrl+G go-to-line, Ctrl+F find
- Ctrl+P quick open (fuzzy file search), Ctrl+/ shortcut cheat sheet; click a line number on an issue card to jump straight to that line in the editor
- File tree name filter, session rename, one-click chat export to Markdown
- Quality overview: quality score trend chart and two-scan comparison (newly introduced / resolved issues)
- 10 theme palettes + light / dark / auto modes, adjustable UI scaling and workspace layout
- Fully automatic chat memory: preferences and conventions extracted after every turn and injected into later context; shareable across chats or isolated per workspace
- In-app update check: new version discovery, download verification (sha256), one-click install
- Settings import / export: back up appearance and analysis preferences as JSON for device migration

**Reliability & integration**

- Self-sustaining engine: monitor → analyze → decide → execute → verify closed loop, with self-update, self-repair, and rollback
- MCP server: external clients call agent capabilities over the Model Context Protocol (HTTP / stdio); the settings page shows recent tool call logs
- MCP client: the agent proactively connects to external MCP servers exposed by other apps (stdio / HTTP), discovers them via scan or common templates, invokes their tools manually, and keeps outbound call logs
- Dual databases: SQLite (local) and MySQL (cloud) two-way sync

## Getting Started

### Desktop

1. **Download & install** — grab `MRSLIY-Setup-*.exe` from [Releases](https://github.com/whureww/Mr.Sliy--AI_Agent/releases/latest); no extra environment needed
2. **Configure the model** — enter your LLM provider and API key on the Settings page (or use offline mode directly)
3. **Start analyzing** — pick a file on the left, type "analyze" to trigger the pipeline (parse → AST → rule detection → knowledge base comparison → conclusions), then click "Fix" on an issue card and confirm the diff

> Versions v0.1.5 and earlier ship a stale update URL from before the repository migration and cannot self-update in-app — please download v0.1.6 manually once; updates return to normal afterwards.

### CLI

```bash
npm install -g mr-sliy
mr-sliy          # inside the repo: npm start
```

> The desktop installer also bundles the CLI: check "Install command-line tool" during setup to run `mr-sliy` from any terminal (uses the bundled Node runtime, no Node.js installation needed). It is removed automatically on uninstall.

| Command | Description |
|---------|-------------|
| `/analyze` | Code analysis (analyze file / scan project) |
| `/optimize` | Interactive code optimization |
| `/sustain` | AI self-sustaining engine (dashboard / engine control / manual update / manual repair) |
| `/config` | Configuration management (providers / knowledge base / mode switch) |
| `/status` | System status & health check |
| `/help` | Help documentation |

Type `/` to search commands, arrow keys to select, Tab to complete; `q` / `quit` in a submenu returns to the main menu.

### Development

Requirements: Node.js >= 18; desktop packaging additionally needs the Rust toolchain and Windows 10+ (the CLI supports Windows / macOS / Linux).

```bash
npm install                              # install dependencies (downloads Tree-sitter WASM automatically)

npm run server                           # backend API only (port 3210 by default)
cd gui && npm install && npm run dev     # GUI dev server

npx @tauri-apps/cli build                # build the desktop app
npm test                                 # run unit tests
```

Versioning is three-segment (max 10 per segment, auto-carry): `npm run bump` (CLI) and `npm run bump:gui` (desktop GUI, syncs four files automatically).

## How It Works

```text
┌─────────────────────────────────────────────┐
│  mrsliy-desktop.exe (Tauri / Rust shell)    │
│                                             │
│  React GUI (gui/)                           │
│  workspace / diff view / metrics / settings │
│                 │ HTTP (127.0.0.1, random)  │
│  Node.js Sidecar (src/)                     │
│  Express API + Tree-sitter + RAG + LLM      │
└─────────────────────────────────────────────┘
```

The analysis pipeline: **parse → AST build → rule detection → knowledge base comparison → conclusions**. Each step has its own timeout and fault tolerance; a single step failing never blocks the rest. Quality scoring uses weighted defect density: severity-weighted and normalized per thousand lines of code, avoiding the distortion of "bigger files always score lower."

| Directory | Description |
|-----------|-------------|
| `gui/` | React + TypeScript + Vite frontend |
| `src/` | Node.js backend (Express routes, detection services, optimization engine, knowledge base, self-update) |
| `src-tauri/` | Rust shell (window management, sidecar launch & health check) |
| `installer/` | Inno Setup installer scripts |
| `docs/` | [architecture.md](docs/architecture.md) design documentation |
| `tests/` | Unit tests |

## MCP Integration

The Settings page shows ready-to-use config; external clients (e.g. Claude Desktop, Cline) can connect over two transports:

- **HTTP**: `POST http://localhost:<port>/mcp`, stateless JSON-RPC 2.0
- **stdio**: `node <install dir>/mcp-server.js`

Available tools: `scan_code`, `scan_project`, `optimize_code`, `chat`, `search_knowledge`, `list_memories`, `add_memory`, `get_scan_history`, and more.

**External MCP servers (the agent as an outbound client)**: add MCP servers exposed by other apps under Settings → "External MCP Servers" — local apps take `command` + args over stdio (npx / uvx are wrapped with `cmd /c` on Windows), remote services take an `http(s)://` URL over HTTP; or click "Scan" to probe local services and add them in one click. After connecting, list the remote tools and invoke them manually with argument templates generated from inputSchema; outbound call logs are available.

## Data, Configuration & Security

Runtime data lives under `~/.mr-sliy/`:

```text
~/.mr-sliy/
├── database/                  # SQLite database
├── reports/                   # exported analysis reports
├── logs/                      # runtime logs
├── chat_memory.json           # chat memory (shared across chats)
├── chat_memory_<hash>.json    # memory isolated per workspace
├── update_source.json         # update check source URL
└── database_connections.json  # cloud database connection config
```

- API keys are configured on the Settings page and stored in the local database, never in plain-text files; for environment variables see [.env.example](.env.example)
- Code modifications go through risk-graded confirmation gating with one-click rollback
- Update checks only fetch version manifests; opening external links is restricted to http/https
- No code or data is ever uploaded to third-party servers

## Roadmap

- **MCP SSE streaming** — currently stateless POST only; an SSE channel is planned
- **Desktop cross-platform** — installers currently target Windows; macOS / Linux builds are under evaluation

Ideas or bugs? Please open an [Issue](https://github.com/whureww/Mr.Sliy--AI_Agent/issues).

## Supporting the Project

If MR·SLIY is useful to you: give it a Star, or share usage feedback from your hardware and workflow in the Issues — real-world data matters more than anything.

## Acknowledgements

MR·SLIY stands on these open-source projects:

- [Tree-sitter](https://github.com/tree-sitter/tree-sitter) & [web-tree-sitter](https://github.com/tree-sitter/web-tree-sitter) — multilingual incremental parsing
- [Tauri](https://github.com/tauri-apps/tauri) — desktop shell and sidecar architecture
- [React](https://github.com/facebook/react) / [Vite](https://github.com/vitejs/vite) / [Express](https://github.com/expressjs/express) — frontend & backend skeleton
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — local storage
- [prismjs](https://github.com/PrismJS/prism) — code highlighting

## License

MIT (see [package.json](package.json)).

## Changelog

For the full history, see [GitHub Releases](https://github.com/whureww/Mr.Sliy--AI_Agent/releases).

### v0.2.2 (2026-09-20)

- New: External MCP servers — the agent acts as an MCP client to connect to other apps. Dual transports: stdio (local child process) / HTTP (remote service); `cmd /c` wrapping on Windows; Mcp-Session-Id and SSE response support
- New: Scan — probes local listening ports plus common ports with MCP handshakes; discovered services can be added & connected in one click; stdio servers ship common templates (filesystem / memory / sequential-thinking / git / fetch / everything) that fill the form in one click
- New: Tool discovery & manual invocation — argument templates generated from inputSchema; outbound call logs (last 50)
- New REST endpoints: `/api/mcp/external` (list / CRUD / connect / disconnect / call / logs / scan)

### v0.2.1 (2026-09-17)

- Fixed: AI fixes producing "delete-everything" diffs — the optimization output cap was fixed at 2000 tokens, so larger files got truncated and empty results from failed JSON parsing were still treated as success. The cap now scales with code size (up to 8000) and empty results fail explicitly (backend double guard + frontend interception; no longer enters the diff page)
- Fixed: "New" button in the main workspace not following the zh/en language switch (hardcoded text moved to i18n)

### v0.2.0 (2026-09-17)

- Fixed: update download started from Settings not syncing with the top update banner (two UIs held independent download state; a shared store now syncs start / progress / completion / cancel both ways)
- Fixed: editor multi-tab dropdown clipped when tabs overflow (panel was mounted inside an overflow:hidden container; split outer panel host from inner clipping tab strip)
- Improved: overflowing editor tabs now partially collapse — tabs that fit stay flat, only the rest fold into the ▼ dropdown (button shows the overflow count)
- Improved: edit-mode layout — expanding the issue panel no longer squeezes the editor (grid middle column minmax(0,1fr) prevents long paths from blowing up min-content); only the file path shrinks to ellipsis when space is tight, encode / save / scan buttons stay fully visible

### v0.1.7 (2026-09-14)

- Editor: line-level diff highlighting for AI modifications, auto bracket pairing & indentation, font size presets (S / M / L / XL)
- Global shortcuts: Ctrl+P quick open (fuzzy file search), Ctrl+/ shortcut cheat sheet; issue-card line numbers jump straight to the editor line
- Quality overview: quality score trend chart and two-scan comparison (newly introduced / resolved issues)
- Settings: MCP tool call logs (last 50, with transport and latency), settings import / export (JSON backup)
- Workspace: file tree name filter, session rename, one-click chat export to Markdown; cross-file full-text search
- MCP Server: full `tools/call` logging across both HTTP and stdio transports
- Fixed: dev-mode health check hardcoded 127.0.0.1 failing when the server binds to IPv6

### v0.1.6 (2026-09-14)

- Fixed "unable to connect to GitHub (HTTP 301)": after the repository migration the old URL is permanently redirected, but the version manifest fetch did not follow redirects — the update source now points to the new repo URL and follows 301/302/307/308
- Note: v0.1.5 and earlier cannot self-update in-app; please download this release manually from the Releases page once

### v0.1.5 (2026-09-14)

- Fixed the analysis-mode send button not following the theme color: disabled background/icon colors are now derived from the active theme in real time
- Update downloads are now manually triggered and cancellable

### v0.1.4 (2026-09-14)

- Fully automatic chat memory (zero interaction) with a cross-chat memory toggle
- Quality scoring switched to weighted defect density; streaming AI replies in Edit mode
- MCP availability self-check; adjustable main workspace layout
