/**
 * PDF library: scan the configured root, SHA-256 identity + de-duplication,
 * per-paper derived cache (outside the repo and outside the PDF root),
 * PyMuPDF worker invocation, page-level quality flags.
 *
 * Safety: tools never receive file paths. A paper is addressed by paper_id
 * (derived from content hash); the absolute path is resolved from the scan
 * result and re-checked to be inside the real PDF root before every read.
 * Original PDFs are only ever opened read-only.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { REFERENCE_EXTRACTION_VERSION, extractReferences, type ReferenceExtraction } from "./references.js";

export const WORKER_VERSION = "w3";
export const EXTRACT_VERSION = `x1-${WORKER_VERSION}-${REFERENCE_EXTRACTION_VERSION}`;
const SCAN_TTL_MS = 15_000;
const EXTRACT_CONCURRENCY = 4;
const MAX_SCAN_FILES = 5_000;

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function log(message: string): void {
  process.stderr.write(`[mot-literature-mcp] ${message}\n`);
}

// ---------------- config ----------------

export interface LibraryConfig {
  pdfRoot: string;
  cacheDir: string;
  python: string;
  workerPath: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): LibraryConfig {
  const pdfRoot = env.MOT_LIT_PDF_ROOT?.trim();
  if (pdfRoot === undefined || pdfRoot === "") {
    throw new Error("MOT_LIT_PDF_ROOT is not set (absolute path of the PDF folder)");
  }
  if (!isAbsolute(pdfRoot)) {
    throw new Error(`MOT_LIT_PDF_ROOT must be an absolute path: ${pdfRoot}`);
  }
  const cacheDir = env.MOT_LIT_CACHE_DIR?.trim() || join(tmpdir(), "mot-literature-mcp-cache");
  if (!isAbsolute(cacheDir)) {
    throw new Error(`MOT_LIT_CACHE_DIR must be an absolute path: ${cacheDir}`);
  }
  const python = env.MOT_LIT_PYTHON?.trim() || (process.platform === "win32" ? "python" : "python3");
  const here = dirname(fileURLToPath(import.meta.url));
  return { pdfRoot: resolve(pdfRoot), cacheDir: resolve(cacheDir), python, workerPath: resolve(here, "..", "python", "pdf_worker.py") };
}

// ---------------- data model ----------------

export interface FileRecord {
  relPath: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface Paper {
  paperId: string;
  sha256: string;
  /** relative paths (POSIX separators) of all byte-identical copies, sorted; [0] is primary */
  paths: string[];
  size: number;
}

export type PageFlag = "empty_text" | "low_text" | "garbled_text" | "two_column_layout";

export interface PageRecord {
  page: number;
  text: string;
  chars: number;
  imageCount: number;
  flags: PageFlag[];
}

export interface HeadingRecord {
  page: number;
  text: string;
  signal: string;
}

export interface Extraction {
  extractVersion: string;
  sha256: string;
  status: "ok" | "partial" | "failed";
  error?: { code: string; message: string };
  pageCount: number;
  pymupdfVersion?: string;
  title?: { text: string; method: "pdf_metadata" | "largest_font_line_page1"; confidence: "medium" | "low" };
  toc: Array<[number, string, number]>;
  headings: HeadingRecord[];
  pages: PageRecord[];
  references: ReferenceExtraction;
  notes: string[];
}

interface WorkerExtract {
  ok: boolean;
  code?: string;
  error?: string;
  workerVersion?: string;
  pymupdfVersion?: string;
  pageCount: number;
  metadataTitle: string;
  largestFontLine: string;
  toc: Array<[number, string, number]>;
  headings: Array<{ page: number; text: string; signal: string }>;
  pages: Array<{ page: number; blocks: Array<{ text: string; bbox?: number[] }>; imageCount: number; twoColumn: boolean }>;
  isEncryptedFlag: boolean;
  notes: string[];
}

export interface RenderResult {
  page: number;
  pageCount: number;
  width: number;
  height: number;
  scale: number;
  mimeType: string;
  data: string;
}

// ---------------- library ----------------

export class Library {
  private files: FileRecord[] = [];
  private papers = new Map<string, Paper>();
  private order: string[] = [];
  private lastScan = 0;
  private realRoot = "";
  private memo = new Map<string, Extraction>();
  private inflight = new Map<string, Promise<Extraction>>();

  constructor(readonly config: LibraryConfig) {}

  // ---- scanning ----

  async scan(force = false): Promise<{ files: number; unique: number; duplicates: number }> {
    if (!force && Date.now() - this.lastScan < SCAN_TTL_MS && this.lastScan > 0) {
      return this.scanSummary();
    }
    let rootStat;
    try {
      this.realRoot = await realpath(this.config.pdfRoot);
      rootStat = await stat(this.realRoot);
    } catch {
      throw new ToolError("pdf_root_missing", `PDF root not accessible: ${this.config.pdfRoot}`);
    }
    if (!rootStat.isDirectory()) {
      throw new ToolError("pdf_root_missing", `PDF root is not a directory: ${this.config.pdfRoot}`);
    }
    if (isInside(this.realRoot, this.config.cacheDir)) {
      throw new ToolError("bad_config", "MOT_LIT_CACHE_DIR must not be inside MOT_LIT_PDF_ROOT");
    }
    const manifest = await this.readManifest();
    const found = await walkPdfs(this.realRoot);
    const files: FileRecord[] = [];
    for (const abs of found) {
      const st = await stat(abs);
      const relPath = relative(this.realRoot, abs).split(sep).join("/");
      const prev = manifest.get(relPath);
      const sha256 = prev !== undefined && prev.size === st.size && prev.mtimeMs === st.mtimeMs ? prev.sha256 : await hashFile(abs);
      files.push({ relPath, size: st.size, mtimeMs: st.mtimeMs, sha256 });
    }
    files.sort((a, b) => a.relPath.localeCompare(b.relPath, "zh-Hans-CN"));
    const papers = new Map<string, Paper>();
    const order: string[] = [];
    for (const file of files) {
      const paperId = `p${file.sha256.slice(0, 16)}`;
      const existing = papers.get(paperId);
      if (existing !== undefined) {
        existing.paths.push(file.relPath);
      } else {
        papers.set(paperId, { paperId, sha256: file.sha256, paths: [file.relPath], size: file.size });
        order.push(paperId);
      }
    }
    this.files = files;
    this.papers = papers;
    this.order = order;
    this.lastScan = Date.now();
    await this.writeManifest(files);
    return this.scanSummary();
  }

  private scanSummary() {
    return { files: this.files.length, unique: this.papers.size, duplicates: this.files.length - this.papers.size };
  }

  listPapers(): Paper[] {
    return this.order.map((id) => this.papers.get(id)!);
  }

  async getPaper(paperId: string): Promise<Paper> {
    if (!/^p[0-9a-f]{16}$/.test(paperId)) {
      throw new ToolError("invalid_paper_id", `invalid paper_id: ${JSON.stringify(paperId).slice(0, 60)} (expected p + 16 hex chars, from list_papers)`);
    }
    await this.scan();
    let paper = this.papers.get(paperId);
    if (paper === undefined) {
      await this.scan(true);
      paper = this.papers.get(paperId);
    }
    if (paper === undefined) {
      throw new ToolError("unknown_paper_id", `unknown paper_id ${paperId}; call list_papers`);
    }
    return paper;
  }

  /** Absolute path of the primary copy, verified to still be inside the root and unchanged. */
  private async resolvePath(paper: Paper): Promise<string> {
    for (const rel of paper.paths) {
      const abs = resolve(this.realRoot, ...rel.split("/"));
      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        continue;
      }
      if (!isInside(this.realRoot, real)) {
        throw new ToolError("path_escape", "resolved path escapes the PDF root");
      }
      const st = await stat(real);
      const record = this.files.find((f) => f.relPath === rel);
      if (record !== undefined && record.size === st.size && record.mtimeMs === st.mtimeMs) {
        return real;
      }
    }
    await this.scan(true);
    throw new ToolError("file_changed", `PDF for ${paper.paperId} changed or disappeared; call list_papers again`);
  }

  // ---- extraction & cache ----

  private cachePath(sha256: string): string {
    return join(this.config.cacheDir, "papers", `${sha256}.${EXTRACT_VERSION}.json`);
  }

  async extraction(paper: Paper, force = false): Promise<{ extraction: Extraction; fromCache: boolean }> {
    const key = paper.sha256;
    if (!force) {
      const hit = this.memo.get(key) ?? (await this.readCache(key));
      if (hit !== undefined) {
        this.memo.set(key, hit);
        return { extraction: hit, fromCache: true };
      }
    }
    let pending = this.inflight.get(key);
    if (pending === undefined) {
      pending = this.runExtraction(paper).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const extraction = await pending;
    return { extraction, fromCache: false };
  }

  private async readCache(sha256: string): Promise<Extraction | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.cachePath(sha256), "utf8")) as Extraction;
      return parsed.extractVersion === EXTRACT_VERSION && parsed.sha256 === sha256 ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async runExtraction(paper: Paper): Promise<Extraction> {
    const abs = await this.resolvePath(paper);
    let raw: WorkerExtract;
    try {
      raw = (await this.runWorker(["extract", abs], 180_000)) as unknown as WorkerExtract;
    } catch (error) {
      if (error instanceof ToolError && error.code === "worker_unavailable") {
        throw error; // environment problem: do not cache a per-paper failure
      }
      const code = error instanceof ToolError ? error.code : "extract_failed";
      const extraction = failedExtraction(paper.sha256, code, error instanceof Error ? error.message : String(error));
      await this.writeCache(extraction);
      this.memo.set(paper.sha256, extraction);
      return extraction;
    }
    if (raw.workerVersion !== WORKER_VERSION) {
      throw new ToolError("worker_mismatch", `pdf_worker.py version ${raw.workerVersion} != ${WORKER_VERSION}`);
    }
    const extraction = buildExtraction(paper.sha256, raw);
    await this.writeCache(extraction);
    this.memo.set(paper.sha256, extraction);
    return extraction;
  }

  async extractAll(force: boolean): Promise<{ extracted: number; cached: number; failed: Array<{ paper_id: string; code: string }>; partial: number }> {
    await this.scan();
    const papers = this.listPapers();
    let extracted = 0;
    let cached = 0;
    let partial = 0;
    const failed: Array<{ paper_id: string; code: string }> = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(EXTRACT_CONCURRENCY, papers.length) }, async () => {
      while (cursor < papers.length) {
        const paper = papers[cursor++]!;
        try {
          const { extraction, fromCache } = await this.extraction(paper, force);
          if (fromCache) cached += 1;
          else extracted += 1;
          if (extraction.status === "failed") failed.push({ paper_id: paper.paperId, code: extraction.error?.code ?? "failed" });
          if (extraction.status === "partial") partial += 1;
        } catch (error) {
          if (error instanceof ToolError && error.code === "worker_unavailable") throw error;
          failed.push({ paper_id: paper.paperId, code: error instanceof ToolError ? error.code : "error" });
        }
      }
    });
    await Promise.all(workers);
    return { extracted, cached, failed, partial };
  }

  /** Cached extraction only (no parsing); undefined when not yet indexed. */
  async cachedExtraction(paper: Paper): Promise<Extraction | undefined> {
    const hit = this.memo.get(paper.sha256) ?? (await this.readCache(paper.sha256));
    if (hit !== undefined) this.memo.set(paper.sha256, hit);
    return hit;
  }

  async render(paper: Paper, page: number, scale: number): Promise<RenderResult> {
    const abs = await this.resolvePath(paper);
    return (await this.runWorker(["render", abs, String(page), String(scale)], 60_000)) as unknown as RenderResult;
  }

  // ---- worker ----

  private runWorker(args: string[], timeout: number): Promise<Record<string, unknown>> {
    return new Promise((resolvePromise, reject) => {
      execFile(
        this.config.python,
        ["-X", "utf8", this.config.workerPath, ...args],
        { timeout, maxBuffer: 512 * 1024 * 1024, windowsHide: true, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
        (error, stdout, stderr) => {
          const lastLine = stdout.trim().split("\n").pop() ?? "";
          let payload: Record<string, unknown> | undefined;
          try {
            payload = lastLine === "" ? undefined : (JSON.parse(lastLine) as Record<string, unknown>);
          } catch {
            payload = undefined;
          }
          if (payload === undefined) {
            const spawnFailed = error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
            reject(
              new ToolError(
                spawnFailed ? "worker_unavailable" : "worker_failed",
                spawnFailed
                  ? `Python not found (${this.config.python}); set MOT_LIT_PYTHON`
                  : `pdf worker failed: ${(stderr || String(error ?? "")).slice(-400)}`,
              ),
            );
            return;
          }
          if (payload.ok !== true) {
            const code = String(payload.code ?? "worker_failed");
            reject(new ToolError(code === "dependency_missing" ? "worker_unavailable" : code, String(payload.error ?? "worker error")));
            return;
          }
          resolvePromise(payload);
        },
      );
    });
  }

  // ---- manifest / cache io ----

  private async readManifest(): Promise<Map<string, FileRecord>> {
    try {
      const parsed = JSON.parse(await readFile(join(this.config.cacheDir, "manifest.json"), "utf8")) as { root: string; files: FileRecord[] };
      if (parsed.root !== this.realRoot) return new Map();
      return new Map(parsed.files.map((f) => [f.relPath, f]));
    } catch {
      return new Map();
    }
  }

  private async writeManifest(files: FileRecord[]): Promise<void> {
    await atomicWrite(join(this.config.cacheDir, "manifest.json"), JSON.stringify({ root: this.realRoot, files }));
  }

  private async writeCache(extraction: Extraction): Promise<void> {
    await atomicWrite(this.cachePath(extraction.sha256), JSON.stringify(extraction));
  }
}

// ---------------- helpers ----------------

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function walkPdfs(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      log(`cannot read directory ${dir}: ${String(error)}`);
      continue;
    }
    for (const entry of entries) {
      // symlinks / junctions are skipped: they could point outside the root
      if (entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile() && /\.pdf$/i.test(entry.name)) out.push(abs);
      if (out.length >= MAX_SCAN_FILES) return out;
    }
  }
  return out;
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolvePromise(hash.digest("hex")));
  });
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

function failedExtraction(sha256: string, code: string, message: string): Extraction {
  return {
    extractVersion: EXTRACT_VERSION,
    sha256,
    status: "failed",
    error: { code, message: message.slice(0, 400) },
    pageCount: 0,
    toc: [],
    headings: [],
    pages: [],
    references: { version: REFERENCE_EXTRACTION_VERSION, status: "not_found", style: "unknown", entries: [], issues: ["extraction failed"] },
    notes: [],
  };
}

/** share of replacement / private-use / control characters */
function garbledRatio(text: string): number {
  let bad = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    total += 1;
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0xfffd || (code >= 0xe000 && code <= 0xf8ff) || code < 0x20) bad += 1;
  }
  return total === 0 ? 0 : bad / total;
}

/** lines repeated on >= 3 pages (running headers / footers) */
export function repeatedLines(pages: Array<{ blocks: Array<{ text: string }> }>): Set<string> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const block of page.blocks) {
      for (const line of block.text.split("\n")) {
        const t = line.replace(/\s+/g, " ").trim();
        if (t.length >= 4 && t.length <= 80) seen.add(t);
      }
    }
    for (const t of seen) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4));
  return new Set([...counts].filter(([, n]) => n >= threshold).map(([t]) => t));
}

function plausibleTitle(text: string): boolean {
  const t = text.trim();
  if (t.length < 4 || t.length > 300 || /^\d+$/.test(t) || t.includes("@")) return false;
  const lower = t.toLowerCase();
  if (["untitled", "microsoft word", "document"].includes(lower) || /\.(docx?|tex|pdf|caj)$/i.test(lower) || lower.startsWith("microsoft word -")) return false;
  return /[一-鿿]/.test(t) || t.split(/\s+/).length >= 3;
}

export function buildExtraction(sha256: string, raw: WorkerExtract): Extraction {
  const pages: PageRecord[] = raw.pages.map((p) => {
    const text = p.blocks.map((b) => b.text).join("\n");
    const chars = text.replace(/\s+/g, "").length;
    const flags: PageFlag[] = [];
    if (chars === 0) flags.push("empty_text");
    else if (chars < 80 && p.imageCount > 0) flags.push("low_text");
    if (garbledRatio(text) > 0.05) flags.push("garbled_text");
    if (p.twoColumn) flags.push("two_column_layout");
    return { page: p.page, text, chars, imageCount: p.imageCount, flags };
  });
  const drop = repeatedLines(raw.pages);
  const references = extractReferences(
    raw.pages.map((p) => ({
      page: p.page,
      blocks: p.blocks.map((b) => b.text),
      ...(p.blocks.every((b) => Array.isArray(b.bbox) && b.bbox.length === 4) ? { boxes: p.blocks.map((b) => b.bbox!) } : {}),
    })),
    drop,
  );
  const headings = raw.headings.filter((h) => !drop.has(h.text));
  const notes = [...raw.notes];
  if (raw.isEncryptedFlag) notes.push("PDF carries an encryption flag (opened without password); content may be incomplete");
  const needsVisual = pages.filter((p) => p.flags.some((f) => f === "empty_text" || f === "low_text" || f === "garbled_text"));
  const status: Extraction["status"] = pages.length < raw.pageCount || needsVisual.length > 0 ? "partial" : "ok";
  if (pages.length < raw.pageCount) notes.push(`only ${pages.length}/${raw.pageCount} pages extracted`);
  const title = plausibleTitle(raw.metadataTitle)
    ? { text: raw.metadataTitle, method: "pdf_metadata" as const, confidence: "medium" as const }
    : plausibleTitle(raw.largestFontLine)
      ? { text: raw.largestFontLine, method: "largest_font_line_page1" as const, confidence: "low" as const }
      : undefined;
  return {
    extractVersion: EXTRACT_VERSION,
    sha256,
    status,
    pageCount: raw.pageCount,
    ...(raw.pymupdfVersion !== undefined ? { pymupdfVersion: String(raw.pymupdfVersion) } : {}),
    ...(title !== undefined ? { title } : {}),
    toc: raw.toc,
    headings,
    pages,
    references,
    notes,
  };
}
