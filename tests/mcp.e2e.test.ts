/**
 * Protocol-level acceptance: spawn the built server over real stdio, initialize,
 * list the 7 tools and call each one against synthetic PDFs generated at test time.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const SERVER = join(ROOT, "dist", "server.js");
const PYTHON = process.env.X_LIT_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const TOOLS = ["get_paper_references", "get_paper_structure", "list_papers", "read_paper_pages", "refresh_index", "render_paper_page", "search_papers"];

let work: string;
let pdfRoot: string;
let cacheDir: string;
let client: Client;

type Block = { type: string; text?: string; data?: string; mimeType?: string };

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; blocks: Block[]; json: any }> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Block[] };
  const first = result.content.find((b) => b.type === "text")?.text ?? "";
  let json: any;
  try {
    json = JSON.parse(first.split("\n\n")[0]!);
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, blocks: result.content, json };
}

async function idOf(fileName: string): Promise<string> {
  const { json } = await call("list_papers", {});
  return json.papers.find((p: any) => p.file_name === fileName).paper_id;
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "x-lit-test-"));
  pdfRoot = join(work, "文献 库");
  cacheDir = join(work, "cache");
  execFileSync(PYTHON, [join(ROOT, "tests", "fixtures", "make_fixtures.py"), pdfRoot]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, X_LIT_PDF_ROOT: pdfRoot, X_LIT_CACHE_DIR: cacheDir } as Record<string, string>,
    stderr: "pipe",
  });
  client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
  rmSync(work, { recursive: true, force: true });
});

describe("MCP stdio server", () => {
  it("initializes and lists exactly the 7 tools", async () => {
    expect(client.getServerVersion()?.name).toBe("x-literature");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
  });

  it("refresh_index: dedupes, isolates failures, second run reuses cache", async () => {
    const first = (await call("refresh_index", {})).json;
    expect(first).toMatchObject({ files_found: 6, unique_papers: 5, duplicate_files: 1, parsed_now: 5 });
    expect(first.failed.map((f: any) => f.code).sort()).toEqual(["encrypted", "open_failed"]);
    const second = (await call("refresh_index", {})).json;
    expect(second).toMatchObject({ parsed_now: 0, reused_from_cache: 5 });
  });

  it("list_papers: Chinese/space file names, duplicate alias, statuses, pagination, no full text", async () => {
    const { json, blocks } = await call("list_papers", { limit: 2, offset: 0 });
    expect(json.total).toBe(5);
    expect(json.returned).toBe(2);
    expect(json.next_offset).toBe(2);
    const all = (await call("list_papers", {})).json.papers;
    const zh = all.find((p: any) => p.file_name === "中文 样例 论文.pdf");
    expect(zh).toMatchObject({ page_count: 4, parse_status: "ok", references_found: 4 });
    expect(all.find((p: any) => p.file_name === "english paper.pdf").duplicate_paths).toEqual(["sub/copy of english.pdf"]);
    expect(all.find((p: any) => p.file_name === "broken.pdf").parse_status).toBe("failed");
    expect(blocks[0]!.text).not.toContain("马氏距离");
    expect((await call("list_papers", { query: "english" })).json.total).toBe(1);
  });

  it("get_paper_structure: inferred sections are labelled, references located", async () => {
    const { json } = await call("get_paper_structure", { paper_id: await idOf("中文 样例 论文.pdf") });
    expect(json.page_count).toBe(4);
    expect(json.bookmarks).toEqual([]);
    expect(json.sections.map((s: any) => s.text)).toEqual(expect.arrayContaining(["1 引言", "2 方法", "参考文献"]));
    expect(json.sections.every((s: any) => s.source === "inferred_heading")).toBe(true);
    expect(json.references).toMatchObject({ status: "found", entries: 4, heading: { page: 3 } });
    expect(json.pages).toHaveLength(4);
  });

  it("read_paper_pages: per-page markers, bounded output with exact continuation", async () => {
    const id = await idOf("中文 样例 论文.pdf");
    const full = await call("read_paper_pages", { paper_id: id, start_page: 2, end_page: 3 });
    const text = full.blocks[0]!.text!;
    expect(text).toContain("=== page 2/4 ===");
    expect(text).toContain("=== page 3/4 ===");
    expect(full.json.pages.map((p: any) => p.page)).toEqual([2, 3]);
    expect(full.json.next).toEqual({ start_page: 4, char_offset: 0 });

    expect(full.json.pages[0].page_chars).toBeGreaterThan(500);
    const cut = await call("read_paper_pages", { paper_id: id, start_page: 2, end_page: 3, max_chars: 500 });
    expect(cut.json.pages).toHaveLength(1);
    expect(cut.json.pages[0]).toMatchObject({ page: 2, chars_returned: 500, truncated: true });
    expect(cut.json.next).toEqual({ start_page: 2, char_offset: 500 });
    const rest = await call("read_paper_pages", { paper_id: id, start_page: 2, char_offset: 500 });
    const page2 = (await call("read_paper_pages", { paper_id: id, start_page: 2 })).blocks[0]!.text!.split("===\n")[1]!;
    const firstPart = cut.blocks[0]!.text!.split("=== page 2/4 ===\n")[1]!.replace("\n[... truncated: page continues ...]", "");
    const secondPart = rest.blocks[0]!.text!.split("===\n")[1]!;
    expect(rest.blocks[0]!.text).toContain("=== page 2/4 (from char 500) ===");
    expect(firstPart + secondPart).toBe(page2);
  });

  it("read_paper_pages: page bounds and too many pages are rejected", async () => {
    const id = await idOf("中文 样例 论文.pdf");
    const out = await call("read_paper_pages", { paper_id: id, start_page: 5 });
    expect(out.isError).toBe(true);
    expect(out.blocks[0]!.text).toContain("page_out_of_range");
    expect((await call("read_paper_pages", { paper_id: id, start_page: 3, end_page: 2 })).isError).toBe(true);
    expect((await call("read_paper_pages", { paper_id: id, start_page: 0 })).isError).toBe(true);
  });

  it("render_paper_page: returns a decodable PNG image block", async () => {
    const id = await idOf("中文 样例 论文.pdf");
    const out = await call("render_paper_page", { paper_id: id, page: 2, scale: 1 });
    const image = out.blocks.find((b) => b.type === "image")!;
    expect(image.mimeType).toBe("image/png");
    const bytes = Buffer.from(image.data!, "base64");
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(bytes.readUInt32BE(16)).toBe(595); // IHDR width = A4 width at scale 1
    expect((await call("render_paper_page", { paper_id: id, page: 99 })).isError).toBe(true);
  });

  it("get_paper_references: cross-page entry keeps page_start/page_end; fields are candidates", async () => {
    const { json } = await call("get_paper_references", { paper_id: await idOf("中文 样例 论文.pdf") });
    expect(json.total).toBe(4);
    expect(json.entries[2]).toMatchObject({ number: 3, page_start: 3, page_end: 4 });
    expect(json.entries[0].fields).toMatchObject({ title: "基于检测的多目标跟踪综述", year: 2021 });
    // v0.1.1 optional additions; the v0.1.0 fields above are unchanged
    expect(json.entries[0].quality).toEqual({ year: "verified_by_pattern" });
    expect(json.excluded).toEqual([]);
    expect(json.extraction_method).toContain("r5.pt-v4n3");
    const en = (await call("get_paper_references", { paper_id: await idOf("english paper.pdf") })).json;
    expect(en.entries[1].fields.doi).toBe("10.1234/test.2020.01");
    const blank = (await call("get_paper_references", { paper_id: await idOf("blank.pdf") })).json;
    expect(blank).toMatchObject({ status: "not_found", total: 0 });
    const paged = (await call("get_paper_references", { paper_id: await idOf("中文 样例 论文.pdf"), offset: 1, limit: 2 })).json;
    expect(paged.entries.map((e: any) => e.number)).toEqual([2, 3]);
    expect(paged.next_offset).toBe(3);
  });

  it("search_papers: Chinese across line break, hit is reproducible with read_paper_pages", async () => {
    const { json } = await call("search_papers", { query: "卡尔曼滤波" });
    expect(json.papers_unavailable).toHaveLength(2);
    const hit = json.hits.find((h: any) => h.page === 1);
    expect(hit.file_name).toBe("中文 样例 论文.pdf");
    const page = await call("read_paper_pages", { paper_id: hit.reread.paper_id, start_page: hit.reread.start_page });
    expect(page.blocks[0]!.text!.replace(/\s+/g, "")).toContain("卡尔曼滤波");
    const scoped = (await call("search_papers", { query: "Kalman", paper_ids: [await idOf("english paper.pdf")] })).json;
    expect(scoped.hits).toHaveLength(1);
  });

  it("rejects invalid input: empty/long query, bad or unknown paper_id, path-like ids", async () => {
    expect((await call("search_papers", { query: "   " })).isError).toBe(true);
    expect((await call("search_papers", { query: "x".repeat(201) })).isError).toBe(true);
    expect((await call("read_paper_pages", { paper_id: "..\\..\\Windows\\win.ini", start_page: 1 })).isError).toBe(true);
    expect((await call("render_paper_page", { paper_id: "C:/Windows/win.ini", page: 1 })).isError).toBe(true);
    const unknown = await call("get_paper_structure", { paper_id: "p0000000000000000" });
    expect(unknown.isError).toBe(true);
    expect(unknown.blocks[0]!.text).toContain("unknown_paper_id");
    const failed = await call("read_paper_pages", { paper_id: await idOf("encrypted.pdf"), start_page: 1 });
    expect(failed.isError).toBe(true);
    expect(failed.blocks[0]!.text).toContain("encrypted");
  });

  it("changed PDF content invalidates its cache and its paper_id; originals are never written", async () => {
    const before = await idOf("中文 样例 论文.pdf");
    const englishMtime = statSync(join(pdfRoot, "english paper.pdf")).mtimeMs;
    execFileSync(PYTHON, [join(ROOT, "tests", "fixtures", "make_fixtures.py"), pdfRoot, "variant"]);
    const refreshed = (await call("refresh_index", {})).json;
    expect(refreshed).toMatchObject({ parsed_now: 1, reused_from_cache: 4 });
    const after = await idOf("中文 样例 论文.pdf");
    expect(after).not.toBe(before);
    expect((await call("get_paper_structure", { paper_id: before })).isError).toBe(true);
    expect((await call("get_paper_structure", { paper_id: after })).json.title_candidate.text).toContain("修订版");
    expect(statSync(join(pdfRoot, "english paper.pdf")).mtimeMs).toBe(englishMtime);
  });
});

describe("process behaviour", () => {
  it("stdout carries only JSON-RPC; missing X_LIT_PDF_ROOT fails fast on stderr", async () => {
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, X_LIT_PDF_ROOT: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("X_LIT_PDF_ROOT");

    const ok = spawn(process.execPath, [SERVER], { env: { ...process.env, X_LIT_PDF_ROOT: pdfRoot, X_LIT_CACHE_DIR: cacheDir } });
    let out = "";
    ok.stdout.on("data", (d) => (out += d));
    ok.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } })}\n`);
    await new Promise((r) => setTimeout(r, 1500));
    ok.kill();
    const lines = out.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(JSON.parse(line).jsonrpc).toBe("2.0");
  });
});
