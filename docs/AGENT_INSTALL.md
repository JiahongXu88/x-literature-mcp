# Agent installation — background notes

The [README](../README.md#agent-installation-checklist-for-ai-agents) is the complete procedure. This page records
why it looks the way it does and how far each host has been checked, so agents and maintainers can judge it.

## Scope of the promise

- Supported: **local coding agents** that can read this repository, run shell commands on the user's machine and
  change their own MCP configuration (with the user's approval).
- Not supported: chat assistants without local command execution, and "remote MCP URL" fields. This repository has no
  network endpoint; the server is a local process that speaks MCP over stdin/stdout.
- Not published to npm; there is no `npx` one-liner. Install = git clone + build.

## Why the steps are what they are

| Choice | Reason |
|---|---|
| Per-user install folder (`%LOCALAPPDATA%`, `~/.local/share`) | No admin rights; outside any project, so one install serves every project. |
| Python virtual environment in `<REPO>/.venv` | Keeps the user's global Python untouched; gives a stable absolute `X_LIT_PYTHON`. Without `X_LIT_PYTHON` the server runs plain `python` (Windows) / `python3`, which is often a different interpreter than the one PyMuPDF was installed into. |
| Explicit `X_LIT_CACHE_DIR` | The default lives in the OS temp folder, which cleanup tools may empty (the cache is then rebuilt, which is only slower). |
| User / global scope by default | The paper library is personal and usually needed across projects. |
| Host CLI first, JSON editing second | CLIs merge entries safely; hand-editing risks dropping other servers. VS Code `mcp.json` may contain comments, so it must not be re-serialized blindly. |
| Absolute `node` path for GUI hosts | Apps started from a desktop launcher may not inherit the `PATH` set up by nvm/fnm/volta in shell profiles. |

## scripts/doctor.mjs

Dependency-free Node script (no build step needed for itself):

- checks Node.js ≥ 20, `dist/server.js`, and a Python ≥ 3.9 with PyMuPDF (order: `--python`, `X_LIT_PYTHON`,
  `<REPO>/.venv`, `python3`/`python` on `PATH`);
- `--self-test`: writes a one-page synthetic PDF into a new temp folder, starts the built server over stdio, checks
  the seven tool names, calls `list_papers` and `read_paper_pages`, and deletes that temp folder;
- `--pdf-root DIR [--cache-dir DIR]`: same stdio check against the user's folder, calling `list_papers {limit: 5}`
  (this indexes the folder and fills the normal cache; PDFs are only read);
- prints the `command` / `args` / `env` values to register; `--json` for machine-readable output.

It never edits MCP client configuration, never deletes caches, and makes no network requests.

## Host evidence (as of the 0.2.0 docs update)

| Host | Interface used in the README | Evidence |
|---|---|---|
| Claude Code | `claude mcp add --scope user … -- node …`, `claude mcp list/get/remove` | Claude Code 2.1 on Windows: a fresh headless session given only the GitHub URL and the request above cloned, built, created the venv, ran the doctor, registered at user scope (`✔ Connected`) without touching an existing entry; a new session then called `list_papers` and `search_papers` |
| Codex CLI | `codex mcp add NAME --env K=V -- node …`, `~/.codex/config.toml` `[mcp_servers.NAME]` | codex-cli 0.154 on Windows: `codex mcp add` output checked in an isolated `CODEX_HOME`; a real `codex exec` session (server passed with `-c mcp_servers.…` overrides) listed the 7 tools and called `list_papers` |
| Gemini CLI | `gemini mcp add --scope user -e K=V NAME node …`, `~/.gemini/settings.json` `mcpServers` | Gemini CLI 0.66 on Windows with an isolated home: `gemini mcp add --scope user` output checked, `gemini mcp list` → Connected (trusted folder only); tool call through Gemini not run |
| Cursor | `~/.cursor/mcp.json` / `.cursor/mcp.json`, `mcpServers` with `type: "stdio"` | Checked against cursor.com/docs MCP page; not run |
| VS Code / Copilot | `mcp.json` with `servers`; portable `.mcp.json` / `~/.copilot/mcp-config.json` with `mcpServers`; `code --add-mcp` | Checked against the VS Code MCP configuration reference; not run |
| Claude Desktop, Windsurf | `mcpServers` JSON at the paths listed in the README | Paths as listed in the VS Code MCP discovery table; not run |

Sources: <https://code.claude.com/docs/en/mcp>, <https://developers.openai.com/codex/mcp>,
<https://geminicli.com/docs/tools/mcp-server/>, <https://cursor.com/docs/context/mcp>,
<https://code.visualstudio.com/docs/agents/reference/mcp-configuration>. Host CLIs change; if a command in the README
fails, check the host's `--help` and documentation before editing files by hand.
