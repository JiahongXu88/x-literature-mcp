# X Literature MCP

**X Literature MCP** (`x-literature-mcp`) is a local, read-only **stdio MCP server** for local PDF reading, page
rendering, references, and keyword search via MCP. It gives any MCP client (Claude Code, Claude Desktop, or another
MCP-compatible host) deterministic access to a folder of PDF papers: list, page-level text, page images, reference
lists, and keyword search with page numbers.

It only preprocesses and serves source material. It does **not** call any LLM, summarize, judge novelty,
write paper cards, build knowledge graphs, OCR scanned pages, do semantic search, or touch the network.
Original PDFs are only read.

- Node.js ≥ 20 + TypeScript, MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4)
- Python 3.9+ with PyMuPDF for text extraction and page rendering (no Docling, no model downloads)
- Derived cache: one JSON per PDF content hash, stored **outside** the repo and outside the PDF folder

Reference-list parsing is ported from [PaperTeam](https://github.com/JiahongXu88/PaperTeam) (MIT); see [docs/REUSE_NOTES.md](docs/REUSE_NOTES.md).
The heuristics were developed and tested mainly on Chinese journal PDFs (GB/T 7714 and CJIG styles) and also handle
common English styles (IEEE, APA).

## Install with an AI Agent / 用 AI Agent 安装（推荐）

Paste the request below into a **local coding agent that can read GitHub, run shell commands and edit its own MCP
configuration** — for example Claude Code, Codex CLI, Gemini CLI, Cursor (Agent), or VS Code with GitHub Copilot
agent mode. The agent reads this README and does the rest.
把下面这段话粘贴到**能访问 GitHub、能在本机执行命令、能修改自身 MCP 配置**的 Coding Agent 中即可：

```text
请帮我安装 https://github.com/JiahongXu88/x-literature-mcp 。先阅读仓库 README 的 AI Agent 安装说明，识别我的系统和当前 MCP 客户端，自动完成安装、注册和验证；只在需要 PDF 文件夹路径、管理员权限或系统级依赖安装时询问我。不要覆盖我已有的 MCP 配置。
```

```text
Please install https://github.com/JiahongXu88/x-literature-mcp. Read the "Agent installation checklist" in its README, detect my OS and the MCP client you are running in, then install, register and verify it. Only ask me for the PDF folder path, administrator rights, or system-level dependency installs. Do not overwrite my existing MCP configuration.
```

What you will be asked for / 你需要提供的：

- **The local folder that holds your PDF papers** (an absolute path). The papers stay where they are; nothing is copied or uploaded.
  论文 PDF 所在的本地文件夹绝对路径；论文不会被复制、移动或上传。
- **Approval** for the commands the agent runs (git clone, `npm ci`, a Python virtual environment with PyMuPDF) and
  for the one entry it adds to your MCP client configuration. 同意 Agent 执行的安装命令与新增的一条 MCP 配置。

This is a **local stdio MCP server**, not a hosted service: do **not** paste the GitHub URL into a "remote MCP server
URL" field. There is no network endpoint, no account, no API key, and your papers are never sent to the maintainer.
本仓库是本地 stdio MCP，不是远程 MCP 地址；不要把 GitHub 链接填进"远程 MCP URL"输入框。

### After installation, ask things like / 安装后可以这样用

- "列出我的 PDF 论文" / "List my PDF papers"
- "在论文库里搜索 卡尔曼滤波，告诉我在哪几页" / "Search my papers for *Kalman filter* and give page numbers"
- "提取《…》的参考文献列表" / "Extract the reference list of the paper about …"
- "读第 3 到 5 页" / "Read pages 3–5 of that paper"
- "打开第 6 页的图片，看看表 2" / "Render page 6 so I can check Table 2"

The server returns page text, page images, reference lists and search hits with page numbers; the summarizing and
reasoning is done by your agent's own model, not by this tool.

## Agent installation checklist (for AI agents)

Follow these steps in order. Everything needed is in this README; [docs/AGENT_INSTALL.md](docs/AGENT_INSTALL.md)
only adds background. Placeholders used below:

| Placeholder | Meaning |
|---|---|
| `<REPO>` | absolute path of the clone (step 1) |
| `<PYTHON>` | absolute path of the Python interpreter that has PyMuPDF (step 3) |
| `<PDF_ROOT>` | absolute path of the user's PDF folder (step 4) |
| `<CACHE>` | absolute path of the derived cache folder (step 4) |

**Rules**

- Do not overwrite or reformat existing MCP configuration. Add or update only the `x-literature` entry. If an
  `x-literature` entry already exists, show it to the user and ask before changing it.
- Prefer the host's own CLI (`claude mcp add`, `codex mcp add`, `gemini mcp add`); edit a config file only for hosts
  without one (Cursor, VS Code), and back the file up first.
- Do not use `sudo`/administrator rights, change the system `PATH`, change global git config, or pipe remote scripts
  into a shell. If Git, Node.js ≥ 20 or Python ≥ 3.9 is missing, tell the user what to install and wait for approval.
- Never copy, move, modify or upload the user's PDFs. Do not reuse example paths from this README as real values.
- Do not claim the tools are available in the current chat if the host needs a restart (step 7).

### Step 0 — Detect the environment

Identify the OS, the shell you run commands in (bash/zsh, PowerShell or CMD) and the MCP host you are running in.
Then check the tools:

```bash
git --version
node --version          # must be v20 or newer
npm --version
python3 --version       # Windows: python --version  (or: py -3 --version); must be 3.9 or newer
```

If something is missing, stop and ask. Typical installs (only with the user's approval): Node.js LTS from
<https://nodejs.org> (`winget install OpenJS.NodeJS.LTS`, `brew install node`, or the distro package);
Python from <https://www.python.org> (`winget install Python.Python.3.12`, `brew install python`); Git from
<https://git-scm.com>. On Debian/Ubuntu, `python3 -m venv` may additionally need the `python3-venv` package (system
package — ask first).

### Step 1 — Clone (or reuse) the repository

Default install folder (a per-user folder, no admin rights needed):

| OS | `<REPO>` |
|---|---|
| Windows | `%LOCALAPPDATA%\x-literature-mcp` (PowerShell: `$env:LOCALAPPDATA\x-literature-mcp`) |
| macOS / Linux | `~/.local/share/x-literature-mcp` |

Use another folder if the user asks for one. Avoid paths inside the PDF folder or inside cloud-synced folders.

```bash
# macOS / Linux
mkdir -p ~/.local/share
git clone https://github.com/JiahongXu88/x-literature-mcp.git ~/.local/share/x-literature-mcp
```

```powershell
# Windows PowerShell
git clone https://github.com/JiahongXu88/x-literature-mcp.git "$env:LOCALAPPDATA\x-literature-mcp"
```

If the folder already exists: if `git -C <REPO> remote get-url origin` points to this repository and
`git -C <REPO> status --porcelain` is empty, update it with `git -C <REPO> pull --ff-only`; otherwise ask the user.

### Step 2 — Build

```bash
cd <REPO>
npm ci
npm run build           # creates <REPO>/dist/server.js
```

### Step 3 — Python environment with PyMuPDF

Use a virtual environment inside the clone so the user's global Python stays untouched (`.venv/` is git-ignored):

```bash
# macOS / Linux
cd <REPO>
python3 -m venv .venv
.venv/bin/python -m pip install "pymupdf>=1.24"
# <PYTHON> = <REPO>/.venv/bin/python
```

```powershell
# Windows PowerShell (CMD: same commands with .venv\Scripts\python.exe)
cd <REPO>
python -m venv .venv            # or: py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install "pymupdf>=1.24"
# <PYTHON> = <REPO>\.venv\Scripts\python.exe
```

If `uv` is installed, `uv venv .venv` followed by `uv pip install --python .venv "pymupdf>=1.24"` is equivalent.
PyMuPDF is AGPL-3.0 / commercial and is installed by the user, not bundled.

Check the installation (no PDFs of the user are touched; a throw-away PDF is generated in a new temp folder and removed):

```bash
node scripts/doctor.mjs --self-test
```

It prints `RESULT: OK`, the seven tool names, and the absolute `server.js` and Python paths to use for
registration (`--json` gives machine-readable output; exit code 0 = OK, 1 = a check failed). It finds `<REPO>/.venv`
automatically; pass `--python <PYTHON>` to check another interpreter.

### Step 4 — PDF folder and cache folder

- `<PDF_ROOT>`: if the user has not already named it, ask once: *"Which local folder contains the PDF papers you want
  to use?"* It must be an existing absolute path; subfolders are scanned. Do not guess, and do not create a sample
  folder in the user's name.
- `<CACHE>` (optional but recommended, so the cache survives temp-folder cleanup): Windows
  `%LOCALAPPDATA%\x-literature-mcp-cache`, macOS/Linux `~/.cache/x-literature-mcp`. It must not be inside
  `<PDF_ROOT>`. If omitted, the server uses `<OS temp>/x-literature-mcp-cache`.

Smoke-test against the user's folder (read-only on the PDFs; this builds the normal cache, about 0.2 s per paper
on the first run):

```bash
node scripts/doctor.mjs --pdf-root "<PDF_ROOT>" --cache-dir "<CACHE>"
```

### Step 5 — Register with the MCP host

Register a **stdio** server named `x-literature` that runs `node <REPO>/dist/server.js` with the environment
variables `X_LIT_PDF_ROOT=<PDF_ROOT>`, `X_LIT_PYTHON=<PYTHON>` and (optional) `X_LIT_CACHE_DIR=<CACHE>`.
Default to the **user / global** scope so the paper library is available in every project; use project scope only if
the user asks. First check whether `x-literature` already exists (the list/get commands below) — then follow the Rules.

GUI hosts (Cursor, VS Code, Claude Desktop) may not see the `node` of your shell `PATH` (for example with nvm). If
the server fails to start there, use the absolute Node.js path printed by the doctor (`node_executable`) as the command.

#### Claude Code

```bash
# macOS / Linux (bash/zsh)
claude mcp add --scope user x-literature \
  -e X_LIT_PDF_ROOT="<PDF_ROOT>" \
  -e X_LIT_PYTHON="<PYTHON>" \
  -e X_LIT_CACHE_DIR="<CACHE>" \
  -- node "<REPO>/dist/server.js"
```

```powershell
# Windows PowerShell
claude mcp add --scope user x-literature `
  -e X_LIT_PDF_ROOT="C:\Users\<you>\Papers" `
  -e X_LIT_PYTHON="C:\Users\<you>\AppData\Local\x-literature-mcp\.venv\Scripts\python.exe" `
  -e X_LIT_CACHE_DIR="C:\Users\<you>\AppData\Local\x-literature-mcp-cache" `
  -- node "C:\Users\<you>\AppData\Local\x-literature-mcp\dist\server.js"
```

```cmd
:: Windows CMD (one line)
claude mcp add --scope user x-literature -e X_LIT_PDF_ROOT="C:\Users\<you>\Papers" -e X_LIT_PYTHON="C:\Users\<you>\AppData\Local\x-literature-mcp\.venv\Scripts\python.exe" -e X_LIT_CACHE_DIR="C:\Users\<you>\AppData\Local\x-literature-mcp-cache" -- node "C:\Users\<you>\AppData\Local\x-literature-mcp\dist\server.js"
```

- Stored in: `~/.claude.json` (user scope). Project scope instead: `--scope project` writes `.mcp.json` in the project.
- Verify: `claude mcp get x-literature` and `claude mcp list` → `x-literature: … ✔ Connected`.
- Takes effect: in new Claude Code sessions. In a running session open `/mcp`; if `x-literature` is not listed, restart Claude Code.
- Remove: `claude mcp remove --scope user x-literature`.

#### Codex CLI

```bash
# macOS / Linux
codex mcp add x-literature \
  --env X_LIT_PDF_ROOT="<PDF_ROOT>" \
  --env X_LIT_PYTHON="<PYTHON>" \
  --env X_LIT_CACHE_DIR="<CACHE>" \
  -- node "<REPO>/dist/server.js"
```

```powershell
# Windows PowerShell
codex mcp add x-literature `
  --env X_LIT_PDF_ROOT="C:\Users\<you>\Papers" `
  --env X_LIT_PYTHON="C:\Users\<you>\AppData\Local\x-literature-mcp\.venv\Scripts\python.exe" `
  --env X_LIT_CACHE_DIR="C:\Users\<you>\AppData\Local\x-literature-mcp-cache" `
  -- node "C:\Users\<you>\AppData\Local\x-literature-mcp\dist\server.js"
```

- Stored in: `~/.codex/config.toml` (Windows `%USERPROFILE%\.codex\config.toml`, or `$CODEX_HOME/config.toml`) as a
  `[mcp_servers.x-literature]` table. Project scope: put the same table in `.codex/config.toml` of the project.
- Verify: `codex mcp list` / `codex mcp get x-literature`. In the TUI, `/mcp` lists connected servers and tools.
- Takes effect: in a new Codex session. Remove: `codex mcp remove x-literature`.

Equivalent `config.toml` entry (TOML literal strings `'…'` keep Windows backslashes as-is):

```toml
[mcp_servers.x-literature]
command = "node"
args = ['<REPO>/dist/server.js']

[mcp_servers.x-literature.env]
X_LIT_PDF_ROOT = '<PDF_ROOT>'
X_LIT_PYTHON = '<PYTHON>'
X_LIT_CACHE_DIR = '<CACHE>'
```

#### Gemini CLI

`gemini mcp add` defaults to **project** scope — pass `--scope user` for a global entry.

```bash
# macOS / Linux
gemini mcp add --scope user \
  -e X_LIT_PDF_ROOT="<PDF_ROOT>" \
  -e X_LIT_PYTHON="<PYTHON>" \
  -e X_LIT_CACHE_DIR="<CACHE>" \
  x-literature node "<REPO>/dist/server.js"
```

```powershell
# Windows PowerShell
gemini mcp add --scope user `
  -e X_LIT_PDF_ROOT="C:\Users\<you>\Papers" `
  -e X_LIT_PYTHON="C:\Users\<you>\AppData\Local\x-literature-mcp\.venv\Scripts\python.exe" `
  -e X_LIT_CACHE_DIR="C:\Users\<you>\AppData\Local\x-literature-mcp-cache" `
  x-literature node "C:\Users\<you>\AppData\Local\x-literature-mcp\dist\server.js"
```

- Stored in: `~/.gemini/settings.json` (`mcpServers`), project scope `.gemini/settings.json`.
- Verify: `gemini mcp list` → `x-literature … - Connected`. Stdio servers (user-level ones too) are only started in a
  **trusted folder**; elsewhere they show as `Disabled`. Run the check from a folder the user has trusted (Gemini CLI
  asks when it is first started interactively in a folder). Inside Gemini CLI: `/mcp list`.
- Remove: `gemini mcp remove --scope user x-literature`. Restart Gemini CLI after changes.
- Note: Gemini expands `$VAR`, `${VAR}` and (Windows) `%VAR%` inside `env` values.

#### Cursor

No CLI is needed: merge one entry into the `mcpServers` object of **`~/.cursor/mcp.json`** (global; Windows
`%USERPROFILE%\.cursor\mcp.json`). Project scope: `<project>/.cursor/mcp.json`. Create the file if it does not exist.

```json
{
  "mcpServers": {
    "x-literature": {
      "type": "stdio",
      "command": "node",
      "args": ["<REPO>/dist/server.js"],
      "env": {
        "X_LIT_PDF_ROOT": "<PDF_ROOT>",
        "X_LIT_PYTHON": "<PYTHON>",
        "X_LIT_CACHE_DIR": "<CACHE>"
      }
    }
  }
}
```

Windows paths in JSON need doubled backslashes (`"C:\\Users\\<you>\\Papers"`) or forward slashes
(`"C:/Users/<you>/Papers"`). Verify in Cursor Settings → MCP (Customize page): `x-literature` enabled with 7 tools.
Reload the window or restart Cursor if it does not appear.

#### VS Code / GitHub Copilot

VS Code has two formats — do not mix them:

| File | Top-level key | Used by |
|---|---|---|
| user profile `mcp.json` (Command Palette: **MCP: Open User Configuration**) or `<workspace>/.vscode/mcp.json` | `servers` | VS Code chat / agent mode |
| `~/.copilot/mcp-config.json` (or `$COPILOT_HOME/mcp-config.json`), workspace-root `.mcp.json` | `mcpServers` | GitHub Copilot CLI and Copilot sessions ("portable" format) |

VS Code format (`servers`):

```json
{
  "servers": {
    "x-literature": {
      "type": "stdio",
      "command": "node",
      "args": ["<REPO>/dist/server.js"],
      "env": {
        "X_LIT_PDF_ROOT": "<PDF_ROOT>",
        "X_LIT_PYTHON": "<PYTHON>",
        "X_LIT_CACHE_DIR": "<CACHE>"
      }
    }
  }
}
```

The same entry can be added to the user profile from a bash/zsh shell with
`code --add-mcp '{"name":"x-literature","type":"stdio","command":"node","args":["<REPO>/dist/server.js"],"env":{"X_LIT_PDF_ROOT":"<PDF_ROOT>","X_LIT_PYTHON":"<PYTHON>","X_LIT_CACHE_DIR":"<CACHE>"}}'`
(on Windows, editing `mcp.json` is easier than quoting JSON for the shell). Portable format: use the Cursor JSON above
(`mcpServers`) in `~/.copilot/mcp-config.json`. Verify: **MCP: List Servers** → `x-literature` → Start / Show Output;
VS Code asks you to trust the server on first start.

#### Other hosts (Claude Desktop, Windsurf, …)

Hosts that read the common `mcpServers` JSON accept the Cursor entry above (drop `"type"` if the host rejects it).
Config files: Claude Desktop — Windows `%APPDATA%\Claude\claude_desktop_config.json`, macOS
`~/Library/Application Support/Claude/claude_desktop_config.json`; Windsurf — `~/.codeium/windsurf/mcp_config.json`.
Restart the app afterwards. These hosts are not tested by the maintainer; follow the host's own MCP documentation if it differs.

**Editing a JSON config safely** (for hosts without a CLI): copy the file to `<file>.bak` first, parse it, add or
update only `mcpServers["x-literature"]` (or `servers["x-literature"]` for VS Code), keep every other key, and write
it back. If the file contains comments (JSONC) and cannot be parsed as strict JSON, insert the entry as text instead
of re-serializing the file.

### Step 6 — Verify

1. The host's list command or MCP panel shows `x-literature` as connected (step 5).
2. The tool list contains exactly: `list_papers`, `get_paper_structure`, `read_paper_pages`, `render_paper_page`,
   `get_paper_references`, `search_papers`, `refresh_index`.
3. Call one read-only tool — `list_papers` with `{"limit": 5}` — and show the user the number of papers and a few
   file names. If the tools are not available in the current session (step 7), use the
   `node scripts/doctor.mjs --pdf-root …` result from step 4 as the smoke test and say so.

### Step 7 — Restart notes and report

Most hosts load MCP servers when a session starts. If the tools are not visible in the current conversation, tell
the user to restart the client or open a new session — do not claim the tools work in this session.

Report to the user: install folder `<REPO>`, Python `<PYTHON>`, PDF folder `<PDF_ROOT>`, cache folder `<CACHE>`, the
host and the configuration file or scope that was changed, the verification result (doctor + host list + tool call),
whether a restart is needed, and the upgrade / removal commands below.

### Upgrade and uninstall

- Upgrade: `git -C <REPO> pull --ff-only`, then in `<REPO>`: `npm ci`, `npm run build`, and restart the host.
  The cache rebuilds itself when the extractor version changes.
- Uninstall: remove the host entry (`claude mcp remove --scope user x-literature`, `codex mcp remove x-literature`,
  `gemini mcp remove --scope user x-literature`, or delete the `x-literature` entry from the JSON file), then — after
  the user confirms — delete `<REPO>` and `<CACHE>`. The PDF folder is never touched.

## Manual install

Same steps as the checklist above, for people installing by hand:

```bash
git clone https://github.com/JiahongXu88/x-literature-mcp.git
cd x-literature-mcp
npm ci
npm run build
python3 -m venv .venv                                # Windows: python -m venv .venv
.venv/bin/python -m pip install "pymupdf>=1.24"      # Windows: .venv\Scripts\python.exe -m pip install "pymupdf>=1.24"
node scripts/doctor.mjs --self-test                  # prints the paths to register
```

PyMuPDF ≥ 1.24 is installed separately (AGPL-3.0 / commercial). Installing it into an existing Python with
`python -m pip install pymupdf` also works; then point `X_LIT_PYTHON` at that interpreter (or leave it unset if it is
the default `python` / `python3`).

## Configuration (environment variables)

| Variable | Required | Meaning |
|---|---|---|
| `X_LIT_PDF_ROOT` | yes | Absolute path of the PDF folder (scanned recursively; symlinks skipped) |
| `X_LIT_CACHE_DIR` | no | Absolute path for the derived cache. Default: `<OS temp>/x-literature-mcp-cache`. Must not be inside the PDF folder. |
| `X_LIT_PYTHON` | no | Python executable with PyMuPDF. Default `python` (Windows) / `python3` |

Upgrading from `mot-literature-mcp` ≤ 0.1.1: the old variable names (prefix `MOT_LIT_` instead of `X_LIT_`) are
still read as a fallback when the new name is unset, with a deprecation warning on stderr. The fallback will be
removed in 0.3.0. Set an explicit cache folder if you want to keep reusing an existing cache.

## Register with Claude Code (manual)

Non-destructive (adds one entry, leaves other servers untouched). Replace the placeholder paths with your own;
add `-e X_LIT_PYTHON=...` when PyMuPDF lives in a virtual environment. Other hosts: see
[Step 5 of the checklist](#step-5--register-with-the-mcp-host).

macOS / Linux:

```bash
claude mcp add --scope user x-literature \
  -e X_LIT_PDF_ROOT="/path/to/your/papers" \
  -e X_LIT_CACHE_DIR="/path/to/x-literature-mcp-cache" \
  -- node "/path/to/x-literature-mcp/dist/server.js"
```

Windows (PowerShell):

```powershell
claude mcp add --scope user x-literature `
  -e X_LIT_PDF_ROOT="C:\path\to\your\papers" `
  -e X_LIT_CACHE_DIR="C:\path\to\x-literature-mcp-cache" `
  -- node "C:\path\to\x-literature-mcp\dist\server.js"
```

Windows (CMD):

```cmd
claude mcp add --scope user x-literature -e X_LIT_PDF_ROOT="C:\path\to\your\papers" -e X_LIT_CACHE_DIR="C:\path\to\x-literature-mcp-cache" -- node "C:\path\to\x-literature-mcp\dist\server.js"
```

Check: `claude mcp list` (should show `x-literature … ✔ Connected`), or `/mcp` inside Claude Code.
Remove: `claude mcp remove --scope user x-literature`.

Other MCP clients / project scope: merge the entry from [.mcp.json.example](.mcp.json.example) into your client's MCP
configuration (or a project `.mcp.json`) and replace the placeholder paths (`.mcp.json` is git-ignored here).

### Run manually

```bash
# macOS / Linux
X_LIT_PDF_ROOT=/path/to/your/papers X_LIT_CACHE_DIR=/path/to/x-literature-mcp-cache node dist/server.js
```

```powershell
# PowerShell
$env:X_LIT_PDF_ROOT = "C:\path\to\your\papers"; $env:X_LIT_CACHE_DIR = "C:\path\to\x-literature-mcp-cache"; node dist\server.js
```

```cmd
:: CMD
set X_LIT_PDF_ROOT=C:\path\to\your\papers
set X_LIT_CACHE_DIR=C:\path\to\x-literature-mcp-cache
node dist\server.js
```

The process speaks MCP on stdin/stdout; logs go to stderr only. Exit code 2 = bad configuration.

## Tools (final contract)

All page numbers are 1-based PDF page indices. `paper_id` = `p` + first 16 hex chars of the file's SHA-256
(byte-identical copies share one id; other paths are listed as `duplicate_paths`). Errors come back as
`isError: true` with `{"error": code, "message": …}`.

| Tool | Input | Output |
|---|---|---|
| `list_papers` | `limit?` (1–200, default 50), `offset?`, `query?` (substring of file name / title) | `paper_id`, `file_name`, `path` (relative), `title_candidate {text, method, confidence}`, `page_count`, `sha256_prefix`, `parse_status` (`ok`/`partial`/`failed`), `references_found`, `pages_needing_visual_review`, `duplicate_paths`; `next_offset`. Indexes unparsed PDFs on first call. Never returns full text. |
| `get_paper_structure` | `paper_id` | `page_count`, `bookmarks` (native PDF outline, `source: pdf_bookmark`), `sections` (font/numbering heuristics, `source: inferred_heading`, `confidence: low`), `references` location, per-page `chars`/`images`/`flags`, `reading_order_warning`, `notes` |
| `read_paper_pages` | `paper_id`, `start_page`, `end_page?` (≤ 10 pages per call), `max_chars?` (500–60000, default 12000), `char_offset?` | First line: JSON header with per-page `chars_returned`/`page_chars`/`truncated`/`flags` and `next {start_page, char_offset}` (exact continuation point, `null` at end). Then `=== page N/M ===` blocks of text. |
| `render_paper_page` | `paper_id`, `page`, `scale?` (0.5–3, default 1.5; longest edge ≤ 2400 px) | MCP `image` block (`image/png`) + JSON with size |
| `get_paper_references` | `paper_id`, `offset?`, `limit?` (1–200, default 50) | `status` (`found`/`not_found`), `style` (`numeric`/`author-year`), `heading {page, text}`, `issues`, `excluded[] {page, reason, lines, numbers, preview}` (v0.1.1), `entries[] {index, number?, raw_text, page_start, page_end, fields {authors?, year?, title?, venue?, doi?, arxiv_id?}, issues, quality {year, attribution?}, candidates? {year}}` (`quality`/`candidates` since v0.1.1) |
| `search_papers` | `query` (1–200 chars; space-separated terms are ANDed on one page), `paper_ids?`, `limit?` (1–100, default 20) | `hits[] {paper_id, file_name, page, match_count, snippet, reread {tool, paper_id, start_page}}`, `papers_unavailable` |
| `refresh_index` | `force?` | `files_found`, `unique_papers`, `duplicate_files`, `parsed_now`, `reused_from_cache`, `partial`, `failed[] {paper_id, code}`, `elapsed_ms` |

Example calls:

```json
{"name": "list_papers", "arguments": {"limit": 20}}
{"name": "read_paper_pages", "arguments": {"paper_id": "p0123456789abcdef", "start_page": 4, "end_page": 6, "max_chars": 15000}}
{"name": "render_paper_page", "arguments": {"paper_id": "p0123456789abcdef", "page": 5, "scale": 1.5}}
{"name": "get_paper_references", "arguments": {"paper_id": "p0123456789abcdef"}}
{"name": "search_papers", "arguments": {"query": "遮挡 外观特征"}}
```

### How to read results honestly

- Text comes from the PDF text layer in PyMuPDF block order. On two-column pages (`two_column_layout` flag) order can
  differ from the visual layout; formulas and tables are often garbled. Check them with `render_paper_page`.
- Page flags: `empty_text`, `low_text` (little text on a page with images — possible scan), `garbled_text`
  (> 5 % replacement/private-use glyphs). These pages are listed in `pages_needing_visual_review`; there is no OCR.
- `sections` are guesses from font and numbering; `bookmarks` are the only native structure.
- Reference `fields` are rule-based candidates (GB/T 7714, CJIG author-year, IEEE, APA). They are not verified, and
  a citation alone says nothing about inheritance or experimental comparison. `issues` reports numbering gaps,
  duplicates (bilingual pairs, or another article sharing a journal page), dropped table fragments, and very long/short entries.
- `raw_text`, `page_start`/`page_end` and the page images are the source of truth; everything parsed from them is a candidate.

### Reference quality fields and issue codes (v0.1.1)

| Field / code | Meaning | What to do |
|---|---|---|
| `quality.year = verified_by_pattern` | `fields.year` sits in a bibliographic position (`, 2019, 45(3)`, `, 2017: pages`, `(2021-07-18)`, CJIG `Authors. 2019.`). Page ranges, `[YYYY-MM-DD]` access dates, arXiv ids, DOIs and URLs are removed before matching. | Usable as the printed year (the printed year can still differ from the canonical one, e.g. conference vs. journal version). |
| `quality.year = ambiguous` | Four-digit candidates exist but none (or more than one value) is in such a position. `fields.year` is **omitted**; the values are in `candidates.year`. Issue `YEAR_AMBIGUOUS`. | Read `raw_text`. |
| `quality.year = not_found` | No year. Issue `YEAR_NOT_FOUND` if only an access date is printed; an arXiv id's posting year is offered in `candidates.year`. | Read `raw_text`. |
| `YEAR_FUTURE_REJECTED` | A placed year later than next year was refused. | Read `raw_text`. |
| `quality.attribution = suspected_other_article` + `NUMBERING_RESTART_SUSPECTED` | Numbering starts again at `[1]` after a run of entries; the tail is kept, not removed. | `render_paper_page` on `page_start`. |
| `NUMBER_OUT_OF_SEQUENCE` (entry) | A number re-appears after a higher one (table cell, body citation, or another article). Bilingual pairs do not trigger it. | Check the page. |
| `OTHER_ARTICLE_TEXT_EXCLUDED` + `excluded[]` | CNKI pages that carry two articles print `（下转第N页）` / `（上接第N页）` and a rule across the page. When this PDF has a `下转` marker, the region above a later `上接` marker is another article's; without one, the region below `上接` is another article's tail. That region is left out of `entries`; `excluded` lists page, reason, line count and the `[n]` numbers seen. Needs block bboxes; markers on page 1 are not split (`CONTINUATION_MARKER_UNRESOLVED`). | `render_paper_page` on `excluded[].page`. |
| `FOREIGN_HEADING_SKIPPED` | A `参考文献` heading inside such a region was not used as this paper's heading. | — |
| `NUMBER_LABELS_REATTACHED` | Some PDFs emit the hanging `[n]` label as its own text block after the entry text, which shifted every number by one. A bare label is re-attached to the block that starts on the same baseline to its right (table cells starting with a digit are never targets). | — |

Not fixed by rules (check pages yourself): entries absorbing tables, figure captions, author bios or English abstracts;
formula/table text-layer damage; lost words from font mapping.
- Search is substring matching after NFKC + lower-casing + removing whitespace (so `卡尔\n曼滤波` matches `卡尔曼滤波`);
  it is not semantic search.

## Cache and safety

- Cache entry: `<X_LIT_CACHE_DIR>/papers/<sha256>.<extractor-version>.json`, plus `manifest.json` (path, size, mtime, hash).
  A changed file gets a new hash, so its old cache entry and `paper_id` stop being used; `refresh_index` re-parses only new/changed files.
- No tool accepts a path. Files are resolved from the scan result and re-checked (realpath inside the root, size/mtime unchanged) before each read.
- One unreadable/encrypted PDF is recorded as `failed` and does not stop the others.
- Do not commit papers, renders or caches; `.gitignore` excludes `*.pdf`, `*.png`, cache folders.

## Development

```bash
npm ci
npm run typecheck
npm test            # builds, then: unit tests + real stdio MCP e2e on synthetic PDFs generated at test time
npm run doctor -- --self-test   # install check (scripts/doctor.mjs)
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `worker_unavailable` / `PyMuPDF not installed` | Install PyMuPDF into the venv (checklist step 3) and set `X_LIT_PYTHON` to `<REPO>/.venv/bin/python` (Windows `<REPO>\.venv\Scripts\python.exe`); `node scripts/doctor.mjs` shows which interpreter works |
| Host shows the server as failed / `node` not found | GUI apps may not inherit your shell `PATH`; use the absolute Node.js path (`node_executable` from the doctor) as `command` |
| Tools missing in the current chat after registering | Restart the client or start a new session; most hosts load MCP servers at session start |
| `pdf_root_missing` | `X_LIT_PDF_ROOT` must be an existing absolute folder |
| Server exits with code 2 | Missing/relative `X_LIT_PDF_ROOT` or `X_LIT_CACHE_DIR` (see stderr) |
| `unknown_paper_id` | The file changed or was removed; call `list_papers` again |
| `encrypted` / `open_failed` | Password-protected or damaged PDF; open it elsewhere |
| First `list_papers` slow | It parses all PDFs once (about 8 s for 53 two-column journal papers on a desktop PC); later calls use the cache |

## Changelog

- **Unreleased** — documentation only: "Install with an AI Agent" section and agent installation checklist for
  Claude Code, Codex CLI, Gemini CLI, Cursor and VS Code / Copilot; `scripts/doctor.mjs` install check
  (`npm run doctor`). Tools, `paper_id` and cache keys are unchanged.
- **0.2.0** — renamed from `mot-literature-mcp` to **X Literature MCP** (`x-literature-mcp`); MCP server name
  `mot-literature` → `x-literature`; environment variables `MOT_LIT_*` → `X_LIT_*` (old names still read as a deprecated
  fallback, see Configuration); default cache folder `<OS temp>/x-literature-mcp-cache`. Tool names, inputs, outputs,
  `paper_id` and cache keys are unchanged.
- **0.1.1** — reference extraction `r5.pt-v4n3` (old caches are ignored and rebuilt automatically). Layout-aware
  handling of `下转/上接` continuation markers (another article's references no longer merged or chosen as the heading);
  detached `[n]` labels re-attached (fixes off-by-one numbering); publication year taken only from bibliographic
  positions, with `quality.year` / `candidates.year` and `YEAR_*` issue codes (page numbers, access dates and arXiv ids
  are no longer reported as years); CJIG entries without a terminator and `Surname RW.` initials split correctly;
  numbering-restart and out-of-sequence flags. Tool names, inputs and existing output fields are unchanged; new fields are additive.
- **0.1.0** — MVP: seven tools, PyMuPDF worker, SHA-256 cache.

## License

MIT (see [LICENSE](LICENSE)). Dependencies: `@modelcontextprotocol/server` (Apache-2.0), `zod` (MIT).
PyMuPDF is AGPL-3.0 / commercial and is installed separately by the user; it is not bundled.
