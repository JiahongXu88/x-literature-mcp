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

## Install

```bash
git clone https://github.com/JiahongXu88/x-literature-mcp.git
cd x-literature-mcp
npm ci
npm run build
python -m pip install pymupdf      # PyMuPDF ≥ 1.24, installed separately (AGPL-3.0 / commercial)
```

## Configuration (environment variables)

| Variable | Required | Meaning |
|---|---|---|
| `X_LIT_PDF_ROOT` | yes | Absolute path of the PDF folder (scanned recursively; symlinks skipped) |
| `X_LIT_CACHE_DIR` | no | Absolute path for the derived cache. Default: `<OS temp>/x-literature-mcp-cache`. Must not be inside the PDF folder. |
| `X_LIT_PYTHON` | no | Python executable with PyMuPDF. Default `python` (Windows) / `python3` |

Upgrading from `mot-literature-mcp` ≤ 0.1.1: the old variable names (prefix `MOT_LIT_` instead of `X_LIT_`) are
still read as a fallback when the new name is unset, with a deprecation warning on stderr. The fallback will be
removed in 0.3.0. Set an explicit cache folder if you want to keep reusing an existing cache.

## Register with Claude Code

Non-destructive (adds one entry, leaves other servers untouched). Replace the placeholder paths with your own.

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

Other MCP clients / project scope: copy [.mcp.json.example](.mcp.json.example) to `.mcp.json` (or into your client's
MCP configuration) and replace the placeholder paths (`.mcp.json` is git-ignored here).

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
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `worker_unavailable` / `PyMuPDF not installed` | `python -m pip install pymupdf`, or set `X_LIT_PYTHON` to the interpreter that has it |
| `pdf_root_missing` | `X_LIT_PDF_ROOT` must be an existing absolute folder |
| Server exits with code 2 | Missing/relative `X_LIT_PDF_ROOT` or `X_LIT_CACHE_DIR` (see stderr) |
| `unknown_paper_id` | The file changed or was removed; call `list_papers` again |
| `encrypted` / `open_failed` | Password-protected or damaged PDF; open it elsewhere |
| First `list_papers` slow | It parses all PDFs once (about 8 s for 53 two-column journal papers on a desktop PC); later calls use the cache |

## Changelog

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
