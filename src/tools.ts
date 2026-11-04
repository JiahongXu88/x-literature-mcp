/**
 * The 7 MCP tools. Thin wrappers over Library; every result is either a text
 * block with JSON, page text with explicit page markers, or a PNG image.
 * No tool summarizes, interprets, or judges papers.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { Library, ToolError, type Extraction, type Paper } from "./library.js";
import { MAX_QUERY_CHARS, parseQuery, searchPage } from "./search.js";

const PAPER_ID = z.string().regex(/^p[0-9a-f]{16}$/, "paper_id is 'p' + 16 hex chars (from list_papers)");
const MAX_PAGES_PER_READ = 10;

type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 1) }] };
}

async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    const code = error instanceof ToolError ? error.code : "error";
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message }) }] };
  }
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function needsVisualPages(extraction: Extraction): number[] {
  return extraction.pages.filter((p) => p.flags.some((f) => f !== "two_column_layout")).map((p) => p.page);
}

async function readyExtraction(library: Library, paper: Paper): Promise<Extraction> {
  const { extraction } = await library.extraction(paper);
  if (extraction.status === "failed") {
    throw new ToolError(extraction.error?.code ?? "extract_failed", `paper ${paper.paperId} could not be parsed: ${extraction.error?.message ?? ""}`);
  }
  return extraction;
}

export function registerTools(server: McpServer, library: Library): void {
  server.registerTool(
    "list_papers",
    {
      title: "List papers",
      description:
        "List PDFs in the configured literature folder (de-duplicated by SHA-256). Returns paper_id, file name, title candidate, page count, parse status. Never returns full text. Indexes not-yet-parsed PDFs on first call.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe("default 50"),
        offset: z.number().int().min(0).optional().describe("default 0"),
        query: z.string().max(200).optional().describe("case-insensitive substring filter on file name / title candidate"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, offset, query }) =>
      guarded(async () => {
        await library.extractAll(false);
        const q = query?.trim().toLowerCase() ?? "";
        const rows = [];
        for (const paper of library.listPapers()) {
          const ex = await library.cachedExtraction(paper);
          const row = {
            paper_id: paper.paperId,
            file_name: fileName(paper.paths[0]!),
            path: paper.paths[0]!,
            title_candidate: ex?.title ?? null,
            page_count: ex?.pageCount ?? null,
            sha256_prefix: paper.sha256.slice(0, 12),
            parse_status: ex?.status ?? "not_indexed",
            references_found: ex?.references.entries.length ?? null,
            pages_needing_visual_review: ex !== undefined ? needsVisualPages(ex) : [],
            duplicate_paths: paper.paths.slice(1),
          };
          if (q === "" || row.file_name.toLowerCase().includes(q) || (row.title_candidate?.text.toLowerCase().includes(q) ?? false)) {
            rows.push(row);
          }
        }
        const start = offset ?? 0;
        const size = limit ?? 50;
        const page = rows.slice(start, start + size);
        return json({
          total: rows.length,
          offset: start,
          returned: page.length,
          next_offset: start + size < rows.length ? start + size : null,
          papers: page,
        });
      }),
  );

  server.registerTool(
    "get_paper_structure",
    {
      title: "Get paper structure",
      description:
        "Page count, native PDF bookmarks (if any), inferred section headings with pages, per-page text coverage and quality flags, References location. Inferred items are marked inferred and may be wrong.",
      inputSchema: z.object({ paper_id: PAPER_ID }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ paper_id }) =>
      guarded(async () => {
        const paper = await library.getPaper(paper_id);
        const ex = await readyExtraction(library, paper);
        const inferred = ex.headings.map((h, i, all) => ({
          text: h.text,
          page_start: h.page,
          page_end_estimate: all[i + 1]?.page ?? ex.pageCount,
          source: "inferred_heading",
          signal: h.signal,
          confidence: "low",
        }));
        return json({
          paper_id,
          file_name: fileName(paper.paths[0]!),
          page_count: ex.pageCount,
          parse_status: ex.status,
          title_candidate: ex.title ?? null,
          bookmarks: ex.toc.map(([level, title, page]) => ({ level, title, page, source: "pdf_bookmark" })),
          sections: ex.toc.length >= 2 ? [] : inferred,
          sections_note:
            ex.toc.length >= 2
              ? "native PDF bookmarks present; see bookmarks"
              : "no native bookmarks; sections inferred from font/numbering heuristics (extraction_method=inferred_heading). Verify page ranges with read_paper_pages.",
          references: {
            status: ex.references.status,
            heading: ex.references.heading ?? null,
            entries: ex.references.entries.length,
            style: ex.references.style,
          },
          pages: ex.pages.map((p) => ({ page: p.page, chars: p.chars, images: p.imageCount, flags: p.flags })),
          pages_needing_visual_review: needsVisualPages(ex),
          reading_order_warning: ex.pages.some((p) => p.flags.includes("two_column_layout"))
            ? "two-column layout detected on some pages: text follows PDF block order; check formulas/tables/ordering with render_paper_page"
            : null,
          notes: ex.notes,
          extraction: { method: "pymupdf_text_layer", version: ex.extractVersion, pymupdf: ex.pymupdfVersion ?? null },
        });
      }),
  );

  server.registerTool(
    "read_paper_pages",
    {
      title: "Read paper pages",
      description: `Text of a page range (1-based, max ${MAX_PAGES_PER_READ} pages per call), each page kept separate with its real page number. Output is bounded by max_chars; when truncated, 'next' tells you exactly where to continue (start_page + char_offset). PDF text layer only: verify formulas/tables with render_paper_page.`,
      inputSchema: z.object({
        paper_id: PAPER_ID,
        start_page: z.number().int().min(1),
        end_page: z.number().int().min(1).optional().describe("default = start_page"),
        max_chars: z.number().int().min(500).max(60_000).optional().describe("default 12000"),
        char_offset: z.number().int().min(0).optional().describe("skip this many characters of start_page (continuation)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ paper_id, start_page, end_page, max_chars, char_offset }) =>
      guarded(async () => {
        const paper = await library.getPaper(paper_id);
        const ex = await readyExtraction(library, paper);
        const last = end_page ?? start_page;
        if (start_page > ex.pageCount || last > ex.pageCount || last < start_page) {
          throw new ToolError("page_out_of_range", `pages ${start_page}-${last} invalid; paper has ${ex.pageCount} pages`);
        }
        if (last - start_page + 1 > MAX_PAGES_PER_READ) {
          throw new ToolError("too_many_pages", `at most ${MAX_PAGES_PER_READ} pages per call`);
        }
        let budget = max_chars ?? 12_000;
        const parts: string[] = [];
        const meta: Array<{ page: number; chars_returned: number; page_chars: number; from_offset: number; truncated: boolean; flags: string[] }> = [];
        let next: { start_page: number; char_offset: number } | null = null;
        for (let n = start_page; n <= last; n += 1) {
          const page = ex.pages[n - 1]!;
          const from = n === start_page ? Math.min(char_offset ?? 0, page.text.length) : 0;
          const available = page.text.length - from;
          if (budget <= 0) {
            next = { start_page: n, char_offset: 0 };
            break;
          }
          const take = Math.min(available, budget);
          const text = page.text.slice(from, from + take);
          const truncated = take < available;
          budget -= take;
          meta.push({ page: n, chars_returned: take, page_chars: page.text.length, from_offset: from, truncated, flags: page.flags });
          parts.push(
            `=== page ${n}/${ex.pageCount}${from > 0 ? ` (from char ${from})` : ""}${page.flags.length > 0 ? ` [flags: ${page.flags.join(", ")}]` : ""} ===\n${text}${truncated ? "\n[... truncated: page continues ...]" : ""}`,
          );
          if (truncated) {
            next = { start_page: n, char_offset: from + take };
            break;
          }
        }
        if (next === null && last < ex.pageCount) {
          next = { start_page: last + 1, char_offset: 0 };
        }
        const header = {
          paper_id,
          page_count: ex.pageCount,
          pages: meta,
          next,
          next_note: next === null ? "end of document" : "call read_paper_pages again with next.start_page / next.char_offset",
          source: "pdf_text_layer (reading order may differ from the visual layout)",
        };
        return { content: [{ type: "text", text: `${JSON.stringify(header)}\n\n${parts.join("\n\n")}` }] };
      }),
  );

  server.registerTool(
    "render_paper_page",
    {
      title: "Render paper page",
      description: "Render ONE page as a PNG image (for checking formulas, tables, figures, two-column reading order). scale 0.5–3 (default 1.5); longest edge capped at 2400 px.",
      inputSchema: z.object({
        paper_id: PAPER_ID,
        page: z.number().int().min(1),
        scale: z.number().min(0.5).max(3).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ paper_id, page, scale }) =>
      guarded(async () => {
        const paper = await library.getPaper(paper_id);
        const rendered = await library.render(paper, page, scale ?? 1.5);
        return {
          content: [
            { type: "image", data: rendered.data, mimeType: rendered.mimeType },
            {
              type: "text",
              text: JSON.stringify({ paper_id, page: rendered.page, page_count: rendered.pageCount, width: rendered.width, height: rendered.height, scale: rendered.scale }),
            },
          ],
        };
      }),
  );

  server.registerTool(
    "get_paper_references",
    {
      title: "Get paper references",
      description:
        "Reference-list entries as printed (raw_text) with PDF page numbers, plus candidate fields (number/authors/year/title/venue/DOI) parsed by deterministic rules. Fields are unverified candidates; a citation says nothing about inheritance or experimental comparison.",
      inputSchema: z.object({
        paper_id: PAPER_ID,
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("default 50"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ paper_id, offset, limit }) =>
      guarded(async () => {
        const paper = await library.getPaper(paper_id);
        const ex = await readyExtraction(library, paper);
        const refs = ex.references;
        const start = offset ?? 0;
        const size = limit ?? 50;
        return json({
          paper_id,
          status: refs.status,
          style: refs.style,
          heading: refs.heading ?? null,
          total: refs.entries.length,
          offset: start,
          next_offset: start + size < refs.entries.length ? start + size : null,
          issues: refs.issues,
          extraction_method: `rule-based (${refs.version}); fields are candidates, not verified bibliographic facts`,
          entries: refs.entries.slice(start, start + size),
        });
      }),
  );

  server.registerTool(
    "search_papers",
    {
      title: "Search papers",
      description: `Keyword search over page text (Chinese/English substring, whitespace- and width-insensitive; multiple space-separated terms must all occur on the same page). Returns paper_id + page + snippet; re-read hits with read_paper_pages. Query ≤ ${MAX_QUERY_CHARS} chars.`,
      inputSchema: z.object({
        query: z.string().min(1).max(MAX_QUERY_CHARS),
        paper_ids: z.array(PAPER_ID).max(200).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("default 20"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, paper_ids, limit }) =>
      guarded(async () => {
        let terms: string[];
        try {
          terms = parseQuery(query);
        } catch (error) {
          throw new ToolError("invalid_query", error instanceof Error ? error.message : String(error));
        }
        await library.scan();
        const targets = paper_ids !== undefined ? await Promise.all(paper_ids.map((id) => library.getPaper(id))) : library.listPapers();
        const hits: Array<{ paper_id: string; file_name: string; page: number; match_count: number; snippet: string }> = [];
        const unavailable: string[] = [];
        for (const paper of targets) {
          const { extraction } = await library.extraction(paper);
          if (extraction.status === "failed") {
            unavailable.push(paper.paperId);
            continue;
          }
          for (const page of extraction.pages) {
            const hit = searchPage(page.page, page.text, terms);
            if (hit !== undefined) {
              hits.push({ paper_id: paper.paperId, file_name: fileName(paper.paths[0]!), page: hit.page, match_count: hit.matchCount, snippet: hit.snippet });
            }
          }
        }
        hits.sort((a, b) => b.match_count - a.match_count);
        const size = limit ?? 20;
        return json({
          query,
          terms,
          papers_searched: targets.length - unavailable.length,
          papers_unavailable: unavailable,
          total_hit_pages: hits.length,
          returned: Math.min(size, hits.length),
          hits: hits.slice(0, size).map((h) => ({ ...h, reread: { tool: "read_paper_pages", paper_id: h.paper_id, start_page: h.page } })),
        });
      }),
  );

  server.registerTool(
    "refresh_index",
    {
      title: "Refresh index",
      description: "Rescan the PDF folder and (re)build the local derived cache. Never modifies PDFs. force=true re-parses every paper; otherwise only new/changed files are parsed. One failing file does not stop the others.",
      inputSchema: z.object({ force: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ force }) =>
      guarded(async () => {
        const started = Date.now();
        const scan = await library.scan(true);
        const result = await library.extractAll(force ?? false);
        return json({
          pdf_root: library.config.pdfRoot,
          cache_dir: library.config.cacheDir,
          files_found: scan.files,
          unique_papers: scan.unique,
          duplicate_files: scan.duplicates,
          parsed_now: result.extracted,
          reused_from_cache: result.cached,
          partial: result.partial,
          failed: result.failed,
          elapsed_ms: Date.now() - started,
        });
      }),
  );
}
