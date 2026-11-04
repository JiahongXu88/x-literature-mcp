# mot-literature-mcp

A local **stdio MCP server** that gives Claude Code (or any MCP client) deterministic access to a folder of PDF papers:
list, page-level text, page images, reference lists, and keyword search with page numbers.

It only preprocesses and serves source material. It does **not** call any LLM, summarize, judge novelty,
write paper cards, build knowledge graphs, OCR scanned pages, or touch the network. Original PDFs are only read.

- Node.js ≥ 20 + TypeScript, MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4)
- Python 3.9+ with PyMuPDF for text extraction and page rendering (no Docling, no model downloads)
- Derived cache: one JSON per PDF content hash, stored **outside** the repo and outside the PDF folder

Reference-list parsing is ported from [PaperTeam](https://github.com/JiahongXu88/PaperTeam) (MIT); see [docs/REUSE_NOTES.md](docs/REUSE_NOTES.md).

## Install

```bash
git clone https://github.com/JiahongXu88/mot-literature-mcp.git
cd mot-literature-mcp
npm ci
npm run build
python -m pip install pymupdf      # PyMuPDF ≥ 1.24
```

## Configuration (environment variables)

| Variable | Required | Meaning |
|---|---|---|
| `MOT_LIT_PDF_ROOT` | yes | Absolute path of the PDF folder (scanned recursively; symlinks skipped) |
| `MOT_LIT_CACHE_DIR` | no | Absolute path for the derived cache. Default: `<OS temp>/mot-literature-mcp-cache`. Must not be inside the PDF folder. |
| `MOT_LIT_PYTHON` | no | Python executable with PyMuPDF. Default `python` (Windows) / `python3` |

## Register with Claude Code

Non-destructive (adds one entry, leaves other servers untouched). Windows example:

```powershell
claude mcp add --scope user mot-literature `
  -e MOT_LIT_PDF_ROOT="D:\Tmp\参考文献" `
  -e MOT_LIT_CACHE_DIR="D:\Tmp\mot-literature-mcp-cache" `
  -- node "D:\Projects\mot-literature-mcp\dist\server.js"
```

```cmd
claude mcp add --scope user mot-literature -e MOT_LIT_PDF_ROOT="D:\Tmp\参考文献" -e MOT_LIT_CACHE_DIR="D:\Tmp\mot-literature-mcp-cache" -- node "D:\Projects\mot-literature-mcp\dist\server.js"
```

Check: `claude mcp list` (should show `mot-literature … ✔ Connected`), or `/mcp` inside Claude Code.
Remove: `claude mcp remove --scope user mot-literature`.

Project-scoped alternative: copy [.mcp.json.example](.mcp.json.example) to `.mcp.json` in your project and adjust paths (`.mcp.json` is git-ignored here).

### Run manually

```powershell
# PowerShell
$env:MOT_LIT_PDF_ROOT = "D:\Tmp\参考文献"; $env:MOT_LIT_CACHE_DIR = "D:\Tmp\mot-literature-mcp-cache"; node dist\server.js
```

```cmd
:: CMD
set MOT_LIT_PDF_ROOT=D:\Tmp\参考文献
set MOT_LIT_CACHE_DIR=D:\Tmp\mot-literature-mcp-cache
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
| `get_paper_references` | `paper_id`, `offset?`, `limit?` (1–200, default 50) | `status` (`found`/`not_found`), `style` (`numeric`/`author-year`), `heading {page, text}`, `issues`, `entries[] {index, number?, raw_text, page_start, page_end, fields {authors?, year?, title?, venue?, doi?, arxiv_id?}, issues}` |
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
- Search is substring matching after NFKC + lower-casing + removing whitespace (so `卡尔\n曼滤波` matches `卡尔曼滤波`);
  it is not semantic search.

## Cache and safety

- Cache entry: `<MOT_LIT_CACHE_DIR>/papers/<sha256>.<extractor-version>.json`, plus `manifest.json` (path, size, mtime, hash).
  A changed file gets a new hash, so its old cache entry and `paper_id` stop being used; `refresh_index` re-parses only new/changed files.
- No tool accepts a path. Files are resolved from the scan result and re-checked (realpath inside the root, size/mtime unchanged) before each read.
- One unreadable/encrypted PDF is recorded as `failed` and does not stop the others.
- Do not commit papers, renders or caches; `.gitignore` excludes `*.pdf`, `*.png`, cache folders.

## Development

```bash
npm ci
npm run typecheck
npm test            # builds, then: unit tests + real stdio MCP e2e on synthetic PDFs generated at test time
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `worker_unavailable` / `PyMuPDF not installed` | `python -m pip install pymupdf`, or set `MOT_LIT_PYTHON` to the interpreter that has it |
| `pdf_root_missing` | `MOT_LIT_PDF_ROOT` must be an existing absolute folder |
| Server exits with code 2 | Missing/relative `MOT_LIT_PDF_ROOT` or `MOT_LIT_CACHE_DIR` (see stderr) |
| `unknown_paper_id` | The file changed or was removed; call `list_papers` again |
| `encrypted` / `open_failed` | Password-protected or damaged PDF; open it elsewhere |
| First `list_papers` slow | It parses all PDFs once (~8 s for 53 CNKI papers); later calls use the cache |

## License

MIT (see [LICENSE](LICENSE)). Dependencies: `@modelcontextprotocol/server` (Apache-2.0), `zod` (MIT).
PyMuPDF is AGPL-3.0 / commercial and is installed separately by the user; it is not bundled.
