/**
 * Reference-list extraction (deterministic, no model).
 *
 * Ported from PaperTeam (MIT, Copyright (c) JiahongXu88), commit
 * 642103d80dbe7ea63fc7131d1b022b9de74e3ed2:
 *   - backend/src/paper/ReferenceExtractor.ts  — entry splitting (numeric [n] /
 *     CJIG author-year), NON_ENTRY_UNIT, AUTHOR_YEAR_ENTRY_START/END,
 *     parseReferenceFields and helpers (GB/T 7714, CJIG, IEEE quoted, APA).
 *   - backend/src/citation/referenceText.ts    — normalizeReferenceText,
 *     repairLineBreakHyphenation.
 * Changes: input is page-tagged text lines instead of PaperTeam chunks; body
 * citation-callout extraction is dropped; the References-section locator is new
 * (handles vertical "参\n考\n文\n献" headings and headings in the middle of a
 * block); entries keep page_start/page_end; numbering anomalies become issues.
 *
 * Extracted fields are candidates. Nothing here verifies that a reference exists
 * or states how the citing paper uses it.
 */

export const REFERENCE_EXTRACTION_VERSION = "r5.pt-v4n3";

// ---------------- text normalization (from referenceText.ts) ----------------

const SOFT_HYPHEN = /\u00AD/g;
const EXOTIC_SPACES = /[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g;
const HYPHEN_VARIANTS = /[\u2010\u2011\u2012\u2212\u2043]/g;
const HYPHENATION_MARKER = "\u00AD";

export function repairLineBreakHyphenation(text: string): string {
  return text.replace(/(\p{L})-[ \t]*\n+[ \t]*(\p{Ll})/gu, `$1${HYPHENATION_MARKER}$2`);
}

export function normalizeReferenceText(text: string): string {
  return repairLineBreakHyphenation(
    text.normalize("NFC").replace(SOFT_HYPHEN, "").replace(EXOTIC_SPACES, " ").replace(HYPHEN_VARIANTS, "-"),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

// ---------------- types ----------------

export interface PageLines {
  page: number;
  /** text blocks of the page, in extraction order */
  blocks: string[];
  /** optional block bboxes [x0, y0, x1, y1] aligned with `blocks` (enables layout-aware checks) */
  boxes?: Array<readonly number[]>;
}

export interface ReferenceFields {
  authors?: string[];
  year?: number;
  title?: string;
  venue?: string;
  doi?: string;
  arxiv_id?: string;
}

/**
 * How `fields.year` was obtained. `verified_by_pattern`: the year sits in a recognized
 * bibliographic position (", 2019, 45(3)", ", 2017: pages", "(2021-07-18)", CJIG "Authors. 2019.").
 * `ambiguous`: four-digit candidates exist but none in such a position, or they disagree —
 * `fields.year` is then omitted and the candidates are in `candidates.year`.
 */
export type YearEvidence = "verified_by_pattern" | "ambiguous" | "not_found";

export interface ReferenceEntry {
  index: number;
  number?: number;
  raw_text: string;
  page_start: number;
  page_end: number;
  fields: ReferenceFields;
  issues: string[];
  quality?: { year: YearEvidence; attribution?: "suspected_other_article" };
  candidates?: { year?: number[] };
}

/** Text left out of `entries` on layout evidence; `pages` lets an agent re-check with render_paper_page. */
export interface ExcludedRegion {
  page: number;
  reason: string;
  lines: number;
  /** "[n]" numbers seen at line starts in the excluded text */
  numbers: number[];
  preview: string;
}

export interface ReferenceExtraction {
  version: string;
  status: "found" | "not_found";
  style: "numeric" | "author-year" | "unknown";
  heading?: { page: number; text: string };
  entries: ReferenceEntry[];
  issues: string[];
  excluded?: ExcludedRegion[];
}

// ---------------- section locator (new) ----------------

/** matched against the NFKC-folded, whitespace-free text of 1–5 consecutive lines */
const HEADING_FULL =
  /^[[【(]?(?:\d{1,2}[.、]?)?(?:参考文献|references|bibliography|referencelist)[\]】)]?:?(?:\((?:references|bibliography)\))?:?$/i;
/** heading followed on the same line by the first entry: "参考文献：[1] ..." */
const HEADING_INLINE = /^\s*(?:参\s*考\s*文\s*献|references)\s*(?:[(（]\s*references\s*[)）])?\s*[:：]\s*(?=[[［]\s*[1１]\s*[\]］])/i;
/** lines that end the reference list (author bios, editor notes, appended English abstract) */
const SECTION_END =
  /^\s*(?:作者简介|作者介绍|\[?作者简介\]?|[（(]\s*责任编辑|责任编辑|[（(]\s*编辑\s*[:：]|附\s*录|appendix\b|abstract\s*[:：]|key\s*words\s*[:：])/i;

// ---------------- layout evidence (new in r5; needs PageLines.boxes) ----------------

/** journal continuation markers: "（下转第1471页）" ends a column run, "（上接第1426页）" resumes one */
const CONT_TO = /^[(（]\s*下\s*转\s*第\s*[0-9０-９]+\s*页\s*[)）]/;
const CONT_FROM = /^[(（]\s*上\s*接\s*第\s*[0-9０-９]+\s*页\s*[)）]/;
const CONT_ANY = /^[(（]\s*(?:下\s*转|上\s*接)\s*第\s*[0-9０-９]+\s*页\s*[)）]\s*/;
/** a block that is only a reference number ("[12]"), typeset as a hanging label */
const BARE_LABEL = /^\s*[[［]\s*[0-9０-９]{1,3}\s*[\]］]\s*$/;

const firstLine = (text: string): string => (text.split("\n")[0] ?? "").normalize("NFKC").trim();

interface Layout {
  pages: PageLines[];
  /** "pageIdx:blockIdx" → reason the block belongs to another article */
  foreign: Map<string, string>;
  /** page numbers of re-attached "[n]" labels (one item per label) */
  reattached: number[];
  issues: string[];
}

/**
 * Two deterministic, bbox-based repairs:
 * 1. Detached hanging labels: some PDFs emit "[n]" as its own block *after* the entry text,
 *    which shifts every number by one entry. A bare label is re-attached to the block that
 *    starts on the same baseline just to its right.
 * 2. Continuation markers: a "（上接第N页）" band splits a page into an upper and a lower region
 *    owned by different articles. If an earlier page of this PDF has "（下转第M页）", the
 *    lower region continues this article and the upper region is another article's;
 *    otherwise the lower region is another article's tail.
 */
function layoutPass(input: PageLines[]): Layout {
  const issues: string[] = [];
  const foreign = new Map<string, string>();
  const reattached: number[] = [];
  const pages = input.map((page): PageLines => {
    const boxes = page.boxes;
    if (boxes === undefined || boxes.length !== page.blocks.length) return page;
    const blocks = [...page.blocks];
    const keep = blocks.map(() => true);
    blocks.forEach((text, i) => {
      if (!BARE_LABEL.test(text)) return;
      const [, y0, x1] = [boxes[i]![0]!, boxes[i]![1]!, boxes[i]![2]!];
      let target = -1;
      for (let j = 0; j < blocks.length; j += 1) {
        const b = boxes[j]!;
        // entry text starts with a letter; table cells ("43.09 45.18") never get a label
        if (j === i || !keep[j] || !/^\s*\p{L}/u.test(blocks[j]!)) continue;
        if (Math.abs(b[1]! - y0) <= 3 && b[0]! >= x1 - 2 && b[0]! - x1 <= 40) {
          if (target < 0 || b[0]! < boxes[target]![0]!) target = j;
        }
      }
      if (target < 0) return;
      blocks[target] = `${text.trim()} ${blocks[target]}`;
      keep[i] = false;
      reattached.push(page.page);
    });
    if (keep.every(Boolean)) return page;
    return { page: page.page, blocks: blocks.filter((_, i) => keep[i]), boxes: boxes.filter((_, i) => keep[i]) };
  });

  let continuedTo: number | undefined;
  pages.forEach((page, pageIdx) => {
    const boxes = page.boxes;
    if (boxes === undefined) return;
    page.blocks.forEach((text, blockIdx) => {
      if (CONT_TO.test(firstLine(text)) && continuedTo === undefined) continuedTo = page.page;
      if (!CONT_FROM.test(firstLine(text))) return;
      if (pageIdx === 0) {
        issues.push(`CONTINUATION_MARKER_UNRESOLVED: "${firstLine(text)}" on first page ${page.page}; regions not split`);
        return;
      }
      const split = boxes[blockIdx]![1]! - 3;
      const lowerIsOurs = continuedTo !== undefined;
      const reason = lowerIsOurs
        ? `upper region of page ${page.page}, above "${firstLine(text)}" (this article resumes below it, after 下转 on page ${continuedTo})`
        : `lower region of page ${page.page}, from "${firstLine(text)}" (tail of an article continued from another issue page; no 下转 in this PDF)`;
      page.blocks.forEach((_, j) => {
        const isLower = boxes[j]![1]! >= split;
        if (isLower !== lowerIsOurs) foreign.set(`${pageIdx}:${j}`, reason);
      });
      if (lowerIsOurs) continuedTo = undefined;
    });
  });
  return { pages, foreign, reattached, issues };
}

interface HeadingHit {
  pageIdx: number;
  blockIdx: number;
  lineIdx: number;
  lines: number;
  text: string;
  inlineRest?: string;
}

/** All heading-shaped lines, in document order. */
function locateHeadings(pages: PageLines[], foreign: Map<string, string>, skipped: string[]): HeadingHit[] {
  const found: HeadingHit[] = [];
  pages.forEach((page, pageIdx) => {
    page.blocks.forEach((block, blockIdx) => {
      const foreignReason = foreign.get(`${pageIdx}:${blockIdx}`);
      if (foreignReason !== undefined) {
        if (HEADING_FULL.test(block.normalize("NFKC").replace(/\s+/g, "").slice(0, 40)) || HEADING_INLINE.test(block)) {
          skipped.push(`page ${page.page}: ${foreignReason}`);
        }
        return;
      }
      const lines = block.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const inline = HEADING_INLINE.exec(lines[i] ?? "");
        if (inline !== null) {
          found.push({ pageIdx, blockIdx, lineIdx: i, lines: 1, text: inline[0].trim(), inlineRest: (lines[i] ?? "").slice(inline[0].length) });
          continue;
        }
        for (let k = 1; k <= 6 && i + k <= lines.length; k += 1) {
          const joined = lines.slice(i, i + k).join("").normalize("NFKC").replace(/\s+/g, "");
          if (joined.length > 40) break;
          if (HEADING_FULL.test(joined)) {
            found.push({ pageIdx, blockIdx, lineIdx: i, lines: k, text: lines.slice(i, i + k).join("").replace(/\s+/g, "").trim() });
            i += k - 1;
            break;
          }
        }
      }
    });
  });
  return found;
}

interface Unit {
  page: number;
  text: string;
}

/** Entries that start mid-line after a period ("…680-696. ［9］ZHOU X…") get their own line. */
const MIDLINE_ENTRY = /([.．。])[ \t]*(?=[[［][0-9０-９]{1,3}[\]］])/g;

/**
 * Letter-spaced running headers ("控 制 与 决 策") come out of the text layer as
 * one character per line; a run of >= 3 single-character lines is never entry text.
 */
function dropLetterSpacedRuns(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j < lines.length && lines[j]!.trim().length === 1) j += 1;
    if (j - i >= 3) {
      i = j;
      continue;
    }
    out.push(...lines.slice(i, Math.max(j, i + 1)));
    i = Math.max(j, i + 1);
  }
  return out;
}

/**
 * Collect page-tagged line units after the heading until a section-end line.
 * `dropLines` (running headers/footers detected across pages) are skipped.
 */
function collectUnits(
  pages: PageLines[],
  heading: HeadingHit,
  dropLines: Set<string>,
  foreign: Map<string, string>,
  excluded: ExcludedRegion[],
): Unit[] {
  const units: Unit[] = [];
  const exclude = (page: number, reason: string, raw: string): void => {
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !CONT_ANY.test(l));
    if (lines.length === 0) return;
    let region = excluded.find((r) => r.page === page && r.reason === reason);
    if (region === undefined) {
      region = { page, reason, lines: 0, numbers: [], preview: "" };
      excluded.push(region);
    }
    region.lines += lines.length;
    for (const l of lines) {
      const m = NUMERIC_HEAD.exec(l);
      if (m !== null) region.numbers.push(Number.parseInt((m[1] ?? "0").normalize("NFKC"), 10));
    }
    if (region.preview.length < 80) region.preview = `${region.preview} ${lines.join(" ")}`.trim().slice(0, 80);
  };
  const push = (page: number, raw: string): boolean => {
    for (const line of dropLetterSpacedRuns(raw.replace(MIDLINE_ENTRY, "$1\n").split("\n"))) {
      const text = line.replace(/\s+/g, " ").trim().replace(CONT_ANY, "");
      if (text === "") continue;
      if (SECTION_END.test(text)) return false;
      if (dropLines.has(text) || isNonEntryUnit(text)) continue;
      units.push({ page, text });
    }
    return true;
  };
  for (let p = heading.pageIdx; p < pages.length; p += 1) {
    const page = pages[p]!;
    const startBlock = p === heading.pageIdx ? heading.blockIdx : 0;
    for (let b = startBlock; b < page.blocks.length; b += 1) {
      const foreignReason = foreign.get(`${p}:${b}`);
      if (foreignReason !== undefined) {
        exclude(page.page, foreignReason, normalizeReferenceText(page.blocks[b] ?? ""));
        continue;
      }
      let text = normalizeReferenceText(page.blocks[b] ?? "");
      if (p === heading.pageIdx && b === heading.blockIdx) {
        const lines = (page.blocks[b] ?? "").split("\n");
        text = normalizeReferenceText([heading.inlineRest ?? "", ...lines.slice(heading.lineIdx + heading.lines)].join("\n"));
      }
      if (!push(page.page, text)) return units;
    }
  }
  return units;
}

// ---------------- entry splitting (from ReferenceExtractor.ts) ----------------

const NON_ENTRY_UNIT =
  /^(?:[图表]\s*\d+|Fig\.?\s*\d+|Tab\.?\s+\d+|Figure\s+\d+|Table\s+\d+|作者简介|基金项目|通信作者|资助信息|Vol\.?\s*\d+|[-–—\s]*\d{1,4}[-–—\s]*$)/;

function isNonEntryUnit(text: string): boolean {
  return NON_ENTRY_UNIT.test(text) || (text.length < 120 && /第\s*\d+\s*[卷期]/.test(text));
}

const AUTHOR_YEAR_ENTRY_START =
  /^(?:(?:van|von|de|del|der|den|di|da|dos|do|du|la|le|el|al|bin|ibn|mac|mc)\s+)?\p{Lu}[\p{L}\p{M}'’\--]*(?:\s+\p{Lu}\.?){1,3}(?:\s*[，,.．]|\s+and\s+|\s+(?=(?:19|20)\d{2}))/u;

/** "Surname RW." — initials printed without spaces (NFKC-folded line) */
const AUTHOR_JOINED_INITIALS = /^\p{Lu}[\p{Ll}\p{M}'’-]+\s+\p{Lu}{2,3}\s*[，,.．]\s*\S/u;
/** CJIG "Surname X Y， … and Surname Z. 2024. Title": an author block followed by ". year." */
const CJIG_ENTRY_HEAD = /^\p{Lu}[\p{L}\p{M}'’-]*\s+\p{Lu}[^.．]{0,240}?[.．]\s*(?:19|20)\d{2}[a-z]?\s*[.．]\s+\S/u;

const AUTHOR_YEAR_ENTRY_END =
  /(?:[］\]]|[）)](?:\s*[．.;,;])?|pdf\b|html?\b|https?\s*[：:]\/\/\S*|\d{1,4}\s*[-–—]\s*\d{1,4}\s*[.．]?|[,，]\s*\d{1,3}$)\s*$/i;

const NUMERIC_HEAD = /^[[［]\s*([0-9０-９]{1,3})\s*[\]］]\s*/;

interface Collected {
  number?: number;
  text: string;
  pageStart: number;
  pageEnd: number;
}

export function extractReferences(input: PageLines[], dropLines: Set<string> = new Set()): ReferenceExtraction {
  const layout = layoutPass(input);
  const pages = layout.pages;
  const skippedHeadings: string[] = [];
  const candidates = locateHeadings(pages, layout.foreign, skippedHeadings);
  if (candidates.length === 0) {
    return {
      version: REFERENCE_EXTRACTION_VERSION,
      status: "not_found",
      style: "unknown",
      entries: [],
      issues: ["no References/参考文献 heading found", ...layout.issues],
    };
  }
  // Later headings win (body mentions come first), but only if entries follow them.
  let chosen: { hit: HeadingHit; collected: Collected[]; numeric: boolean; excluded: ExcludedRegion[] } | undefined;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const hit = candidates[i]!;
    const excluded: ExcludedRegion[] = [];
    const units = collectUnits(pages, hit, dropLines, layout.foreign, excluded);
    const numeric = units.filter((unit) => NUMERIC_HEAD.test(unit.text)).length >= 1;
    const collected = numeric ? collectNumeric(units) : collectAuthorYear(units);
    if (chosen === undefined) chosen = { hit, collected, numeric, excluded };
    if (collected.length >= 2) {
      chosen = { hit, collected, numeric, excluded };
      break;
    }
  }
  const { hit, numeric, excluded } = chosen!;
  let { collected } = chosen!;
  const heading = { page: pages[hit.pageIdx]!.page, text: hit.text };
  const issues: string[] = [...layout.issues];
  const reattached = layout.reattached.filter((p) => p >= heading.page).length;
  if (reattached > 0) {
    issues.push(`NUMBER_LABELS_REATTACHED: ${reattached} "[n]" labels printed as separate text blocks were re-attached to the entry starting on the same baseline`);
  }
  for (const skipped of skippedHeadings) {
    issues.push(`FOREIGN_HEADING_SKIPPED: a References heading inside another article's region was not used (${skipped})`);
  }
  if (excluded.length > 0) {
    const lines = excluded.reduce((n, r) => n + r.lines, 0);
    const where = [...new Set(excluded.map((r) => r.page))].join(",");
    issues.push(
      `OTHER_ARTICLE_TEXT_EXCLUDED: ${lines} lines on page(s) ${where} left out on continuation-marker evidence; see 'excluded' and verify with render_paper_page`,
    );
  }
  const style = numeric ? "numeric" : collected.length > 0 ? "author-year" : "unknown";
  if (collected.length === 0) {
    issues.push("heading found but no entries could be split");
  }
  if (numeric) {
    // Table cells / body text interleaved by two-column reading order look like
    // "[18] ByteTrack": a very short entry whose number also has a full-length entry.
    const fullNumbers = new Set(collected.filter((e) => e.text.length >= 25).map((e) => e.number));
    const dropped = collected.filter((e) => e.text.length < 25 && fullNumbers.has(e.number));
    if (dropped.length > 0) {
      collected = collected.filter((e) => !dropped.includes(e));
      issues.push(`dropped ${dropped.length} short duplicate-numbered fragments (likely table/body citation markers): ${dropped.map((e) => `[${e.number}] ${e.text}`).join(" | ").slice(0, 200)}`);
    }
  }
  const entries = collected.map((entry, i): ReferenceEntry => {
    const rawText = entry.number !== undefined ? `[${entry.number}] ${entry.text}` : entry.text;
    const entryIssues: string[] = [];
    if (rawText.length > 600) {
      entryIssues.push("very long entry: may have absorbed following text or merged entries");
    }
    if (entry.text.trim().length < 12) {
      entryIssues.push("very short entry: may be truncated");
    }
    const parsed = parseReferenceFields(entry.text.normalize("NFKC"));
    entryIssues.push(...(parsed.yearIssues ?? []));
    return {
      index: i + 1,
      ...(entry.number !== undefined ? { number: entry.number } : {}),
      raw_text: rawText,
      page_start: entry.pageStart,
      page_end: entry.pageEnd,
      fields: toSnakeFields(parsed),
      issues: entryIssues,
      quality: { year: parsed.yearEvidence ?? "not_found" },
      ...(parsed.yearCandidates !== undefined ? { candidates: { year: parsed.yearCandidates } } : {}),
    };
  });
  if (style === "numeric") {
    const numbers = entries.map((e) => e.number).filter((n): n is number => n !== undefined);
    const seen = new Set<number>();
    const dup: number[] = [];
    for (const n of numbers) {
      if (seen.has(n)) dup.push(n);
      seen.add(n);
    }
    const max = numbers.length > 0 ? Math.max(...numbers) : 0;
    const missing: number[] = [];
    for (let n = 1; n <= max; n += 1) if (!seen.has(n)) missing.push(n);
    if (missing.length > 0) issues.push(`numbering gaps (possible split/reading-order problems): ${missing.slice(0, 30).join(",")}`);
    if (dup.length > 0) issues.push(`duplicate numbers (bilingual pairs, or another article sharing a journal page; otherwise a split problem): ${dup.slice(0, 30).join(",")}`);
    for (let i = 1; i < numbers.length; i += 1) {
      if (numbers[i]! < numbers[i - 1]!) {
        issues.push("numbers not monotonic (two-column reading order?) — verify with render_paper_page");
        break;
      }
    }
    // Per-entry: a number already used that also breaks the running sequence (table cells,
    // body citation markers). Bilingual pairs repeat the number of the *previous* entry and pass.
    let maxSoFar = 0;
    const seenSoFar = new Set<number>();
    for (const e of entries) {
      if (e.number === undefined) continue;
      if (seenSoFar.has(e.number) && e.number < maxSoFar) {
        e.issues.push(`NUMBER_OUT_OF_SEQUENCE: [${e.number}] appears again after [${maxSoFar}]; may be a table cell, a body citation or another article's entry — check page ${e.page_start}`);
      }
      seenSoFar.add(e.number);
      maxSoFar = Math.max(maxSoFar, e.number);
    }
    // A second list starting again at [1] after a run of >= 3 entries is suspected to be another
    // article's list (journals print several articles per page). Flagged only, never removed.
    const restartAt = entries.findIndex(
      (e, i) => i >= 3 && e.number === 1 && entries.slice(0, i).filter((x) => x.number !== undefined).length >= 3,
    );
    if (restartAt > 0) {
      const tail = entries.slice(restartAt);
      for (const e of tail) {
        e.quality = { ...(e.quality ?? { year: "not_found" }), attribution: "suspected_other_article" };
        e.issues.push("NUMBERING_RESTART_SUSPECTED: this entry follows a second [1]; it may belong to another article on the same journal page");
      }
      const pagesList = [...new Set(tail.map((e) => e.page_start))].join(",");
      issues.push(
        `NUMBERING_RESTART_SUSPECTED: numbering restarts at [1] (entry index ${restartAt + 1}, page ${pagesList}); ${tail.length} entries kept but marked quality.attribution=suspected_other_article — verify with render_paper_page`,
      );
    }
  }
  return { version: REFERENCE_EXTRACTION_VERSION, status: "found", style, heading, entries, issues, ...(excluded.length > 0 ? { excluded } : {}) };
}

function collectNumeric(units: Unit[]): Collected[] {
  const out: Collected[] = [];
  for (const unit of units) {
    const match = NUMERIC_HEAD.exec(unit.text);
    if (match !== null) {
      out.push({ number: Number.parseInt((match[1] ?? "0").normalize("NFKC"), 10), text: unit.text.slice(match[0].length).trim(), pageStart: unit.page, pageEnd: unit.page });
      continue;
    }
    // units before the first [n] (end of previous section on the same page) are dropped
    const last = out[out.length - 1];
    if (last !== undefined) {
      last.text = joinLine(last.text, unit.text);
      last.pageEnd = unit.page;
    }
  }
  return out;
}

function collectAuthorYear(units: Unit[]): Collected[] {
  const out: Collected[] = [];
  for (const unit of units) {
    const last = out[out.length - 1];
    const terminated = last !== undefined && AUTHOR_YEAR_ENTRY_END.test(last.text);
    const folded = unit.text.normalize("NFKC");
    const starts = AUTHOR_YEAR_ENTRY_START.test(unit.text) || AUTHOR_JOINED_INITIALS.test(folded);
    // An unterminated previous entry ("…OpenReview.net", "…： #3429") still ends where a line opens
    // with a complete CJIG author block + year, provided the previous entry has its own year already.
    const strongStart = CJIG_ENTRY_HEAD.test(folded) && last !== undefined && CJIG_ENTRY_HEAD.test(last.text.normalize("NFKC"));
    if ((starts && (last === undefined || terminated)) || strongStart) {
      out.push({ text: unit.text, pageStart: unit.page, pageEnd: unit.page });
      continue;
    }
    if (last !== undefined) {
      last.text = joinLine(last.text, unit.text);
      last.pageEnd = unit.page;
    }
  }
  return out;
}

/** Join wrapped lines: no space between CJK characters, soft-hyphen marker removed. */
function joinLine(left: string, right: string): string {
  const a = left.replace(/\u00AD$/, "");
  if (a === "") return right;
  const cjkJoin = /[\p{Script=Han}，。：；、（）]$/u.test(a) && /^[\p{Script=Han}，。：；、（）]/u.test(right);
  return cjkJoin ? `${a}${right}` : `${a} ${right}`.replace(/\s+/g, " ").trim();
}

function toSnakeFields(fields: InternalFields): ReferenceFields {
  return {
    ...(fields.authors !== undefined ? { authors: fields.authors } : {}),
    ...(fields.year !== undefined ? { year: fields.year } : {}),
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(fields.venue !== undefined ? { venue: fields.venue } : {}),
    ...(fields.doi !== undefined ? { doi: fields.doi } : {}),
    ...(fields.arxivId !== undefined ? { arxiv_id: fields.arxivId } : {}),
  };
}

// ---------------- field parsing (from ReferenceExtractor.ts; year selection replaced in r5) ----------------

interface InternalFields {
  authors?: string[];
  year?: number;
  title?: string;
  venue?: string;
  doi?: string;
  arxivId?: string;
  yearEvidence?: YearEvidence;
  /** four-digit candidates kept when no year could be placed in a bibliographic position */
  yearCandidates?: number[];
  yearIssues?: string[];
}

/** title/year/doi/arxiv/authors/venue best-effort (fields that fail to parse stay empty) */
export function parseReferenceFields(text: string): InternalFields {
  const out: InternalFields = {};
  const identifiers = despaceIdentifierSpans(text);

  const doiMatch = /(?:doi:|https?:\/\/doi\.org\/|DOI:\s*)?(10\.\d{4,9}\/[^\s"<>[\]]+)/i.exec(identifiers);
  if (doiMatch !== null) {
    out.doi = normalizeDoi(doiMatch[1] ?? "");
  }

  const arxivMatch = /arxiv(?:\.org)?[/:\s.]*(?:abs|pdf)?\/?\s*(\d{4}\.\d{4,5})(v\d+)?/i.exec(identifiers);
  if (arxivMatch !== null) {
    out.arxivId = arxivMatch[1] ?? "";
  }

  const structured: { authors?: string[]; title: string; venue?: string; year?: number } | null =
    parseQuotedTitleStyle(text) ?? parseCjigAuthorYearStyle(identifiers) ?? parseGbt7714Style(text);
  const year = pickYear(identifiers, Number.isInteger(structured?.year) ? structured!.year : undefined);
  out.yearEvidence = year.evidence;
  if (year.year !== undefined) out.year = year.year;
  if (year.candidates.length > 0) out.yearCandidates = year.candidates;
  if (year.issues.length > 0) out.yearIssues = year.issues;
  if (structured !== null) {
    if (structured.authors !== undefined) out.authors = structured.authors;
    out.title = structured.title;
    if (structured.venue !== undefined) out.venue = structured.venue;
  } else {
    const guarded = segmentsOf(text, /(?<=[a-z)\]”"])[.!?]\s+/);
    const plain = segmentsOf(text, /(?<=[.!?])\s+|\.\s+/);
    const picked = pickTitleSegment(guarded) ?? pickTitleSegment(plain);
    if (picked !== undefined) {
      const authors = splitAuthors(picked.authorSegment);
      if (authors !== undefined) out.authors = authors;
      out.title = picked.title;
    }
  }

  if (out.venue === undefined) {
    const withoutTitle = out.title !== undefined ? text.replace(out.title, " ") : text;
    const venueMatch = segmentsOf(withoutTitle, /(?<=[a-z)\]”"])[.,]\s+/)
      .slice(1)
      .find((segment) =>
        /\b(proceedings|journal|transactions|letters|review|conference|workshop|symposium|nature|science|ieee|acm|springer|elsevier|corr|abs\/)\b/i.test(segment),
      );
    if (venueMatch !== undefined) {
      out.venue = venueMatch.replace(/^[“”",.\s]+/, "").replace(/\s*\(\d{4}\)\s*$/, "").trim().slice(0, 200);
    }
  }
  return out;
}

// ---------------- publication year (new in r5) ----------------

const Y = String.raw`(?<!\d)((?:19|20)\d{2})[a-z]?`;
/** year positions in GB/T 7714, IEEE, APA and CJIG lists; tier 1 is the journal/proceedings imprint */
const YEAR_POSITIONS_TIER1: RegExp[] = [
  new RegExp(String.raw`[,，.．]\s*${Y}\s*[,，(（]`, "g"), // ", 2017, 34(6)" / ", 2017(3)" / "[J/OL]. 2018, arXiv: …"
  new RegExp(String.raw`[,，.．]\s*${Y}\s*[:：]`, "g"), // ", 2017: <pages>"
  new RegExp(String.raw`${Y}\s*[:：]\s*⟨pages⟩`, "g"), // "Recognition2015: 2113-2120" (comma lost in the text layer)
];
const YEAR_POSITIONS_TIER2: RegExp[] = [
  new RegExp(String.raw`[(（]\s*${Y}\s*(?:-\s*\d{1,2}\s*){1,2}[)）]`, "g"), // online-first / update date "(2021-07-18)"
  new RegExp(String.raw`[,，]\s*${Y}\s*-\s*\d{1,2}\s*-\s*\d{1,2}\s*[:：]`, "g"), // GB/T online-first ", 2019-11-08: 1-13"
  new RegExp(String.raw`[(（]\s*${Y}\s*[)）]\s*[.．]`, "g"), // APA "(2019)."
  new RegExp(String.raw`\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(?:\d{1,2}\s*[-–]?\s*\d{0,2}\s*[,，]?\s*)?${Y}`, "g"),
  new RegExp(String.raw`[,，.．]\s*${Y}\s*[.．]?\s*(?=$|⟨|[[［(（]|doi\b|https?\b)`, "gi"), // ", 2015." at the end / before an identifier or "(in Chinese)"
  new RegExp(String.raw`\s${Y}\s*[.．]?\s*$`, "g"), // "Springer 2013." (comma lost)
];
const MAX_FUTURE_YEARS = 1;

/**
 * The publication year is taken only from a bibliographic position after removing what
 * commonly looks like a year but is not: page ranges ("1909-1912"), bracketed access dates of
 * online sources ("[2022-04-11]"), arXiv ids ("2005.11475"), DOIs and URLs.
 */
function pickYear(text: string, structuredYear: number | undefined): { year?: number; evidence: YearEvidence; candidates: number[]; issues: string[] } {
  const issues: string[] = [];
  const latest = new Date().getUTCFullYear() + MAX_FUTURE_YEARS;
  let accessDate = false;
  let arxivYear: number | undefined;
  const arxivId = /arxiv[^0-9]{0,25}(\d{2})(\d{2})\s*\.\s*\d{4,5}|\b(?:abs|pdf)\s*\/\s*(\d{2})(\d{2})\s*\.\s*\d{4,5}/i.exec(text);
  if (arxivId !== null) {
    const yy = Number.parseInt(arxivId[1] ?? arxivId[3] ?? "", 10);
    const mm = Number.parseInt(arxivId[2] ?? arxivId[4] ?? "", 10);
    if (yy >= 7 && mm >= 1 && mm <= 12) arxivYear = 2000 + yy;
  }
  const cleaned = text
    .replace(/\s+/g, " ")
    // an unmapped private-use glyph before a digit is punctuation the PDF font did not map:
    // "Intelligence<U+E00F>2007<U+E00F>29(2)" is printed as "Intelligence, 2007, 29(2)"
    .replace(/(?<=[\p{L}\d])[\uE000-\uF8FF](?=\s*\d)/gu, ", ")
    .replace(/[[［]\s*(?:19|20)\d{2}\s*-\s*\d{1,2}\s*(?:-\s*\d{1,2}\s*)?[\]］]/g, () => {
      accessDate = true;
      return " ⟨accessed⟩ ";
    })
    .replace(/10\s*[.．]\s*\d{4,5}\s*[/／][^\s］\]]*/gi, " ⟨doi⟩ ")
    .replace(/arxiv[^0-9]{0,25}\d{4}\s*\.\s*\d{4,5}(?:v\d+)?/gi, " ⟨arxiv⟩ ")
    .replace(/\b(?:abs|pdf)\s*\/\s*\d{4}\s*\.\s*\d{4,5}(?:v\d+)?/gi, " ⟨arxiv⟩ ")
    .replace(/https?\s*[：:]\s*(?:\/\s*\/|∥)\S*/gi, " ⟨url⟩ ")
    .replace(/([:：]|\bpp?\.)\s*[A-Za-z]?\d{1,6}\s*[-–—−－~～]+\s*[A-Za-z]?\d{1,6}(?!\d)/gi, "$1 ⟨pages⟩");
  const all = [...cleaned.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)].map((m) => Number.parseInt(m[1]!, 10));
  const placedBy = (patterns: RegExp[]): Set<number> => {
    const found = new Set<number>();
    for (const pattern of patterns) {
      for (const m of cleaned.matchAll(pattern)) found.add(Number.parseInt(m[1]!, 10));
    }
    return found;
  };
  const tier1 = placedBy(YEAR_POSITIONS_TIER1);
  if (structuredYear !== undefined) tier1.add(structuredYear);
  const tier2 = placedBy(YEAR_POSITIONS_TIER2);
  const future = [...new Set([...tier1, ...tier2])].filter((y) => y > latest);
  if (future.length > 0) {
    issues.push(`YEAR_FUTURE_REJECTED: ${future.join(",")} is later than ${latest}; not used as publication year (page number or misread digits?)`);
    for (const y of future) {
      tier1.delete(y);
      tier2.delete(y);
    }
  }
  const placed = tier1.size > 0 ? tier1 : tier2;
  if (placed.size === 1) {
    return { year: [...placed][0]!, evidence: "verified_by_pattern", candidates: [], issues };
  }
  if (placed.size > 1) {
    issues.push(`YEAR_AMBIGUOUS: several years in bibliographic positions (${[...placed].join(",")}); verify raw_text`);
    return { evidence: "ambiguous", candidates: [...placed], issues };
  }
  const distinct = [...new Set(all)].filter((y) => !future.includes(y));
  if (distinct.length > 0) {
    issues.push(`YEAR_AMBIGUOUS: four-digit number(s) ${distinct.join(",")} not in a publication-year position; verify raw_text`);
    return { evidence: "ambiguous", candidates: distinct, issues };
  }
  if (accessDate || arxivYear !== undefined) {
    const notes = [accessDate ? "only an access date ([YYYY-MM-DD]) is printed, which is not the publication year" : "no year printed"];
    if (arxivYear !== undefined) notes.push(`the arXiv id suggests first posting in ${arxivYear} (candidate only)`);
    issues.push(`YEAR_NOT_FOUND: ${notes.join("; ")}`);
  }
  return { evidence: "not_found", candidates: arxivYear !== undefined ? [arxivYear] : [], issues };
}

function segmentsOf(text: string, splitter: RegExp): string[] {
  return text
    .split(splitter)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

function pickTitleSegment(segments: string[]): { authorSegment: string; title: string } | undefined {
  if (segments.length < 2) return undefined;
  const titleSegment = segments
    .slice(1)
    .find(
      (segment) =>
        countWords(segment) >= 4 &&
        !/^(in|proceedings|vol|no|pp|pages|arxiv|corr|abs\/)/i.test(segment) &&
        !/^\d{4}$/.test(segment) &&
        !/\b(?:et al|editor|Proceedings of the)\b/i.test(segment),
    );
  if (titleSegment === undefined) return undefined;
  return { authorSegment: segments[0] ?? "", title: titleSegment.replace(/["“”]/g, "").trim() };
}

function parseQuotedTitleStyle(text: string): { authors?: string[]; title: string } | null {
  const match = /^(.*?)[,.]?\s*[“"]([^”"]{8,400})[,.]?[”"]/.exec(text);
  if (match === null) return null;
  const title = (match[2] ?? "").replace(/[,.\s]+$/, "").trim();
  if (countWords(title) < 2 && title.length < 12) return null;
  const authors = splitAuthors((match[1] ?? "").trim());
  return { ...(authors !== undefined ? { authors } : {}), title };
}

/** GB/T 7714: `张三, 李四. 标题[J]. 期刊, 2021, 44(3): 1-20.` */
function parseGbt7714Style(text: string): { authors?: string[]; title: string } | null {
  const match = /^(.*?)[.．]\s*([^.．[]{4,300}?)\s*\[(?:J|C|M|D|N|P|R|S|Z|A|EB\/OL|DB\/OL|J\/OL|C\/OL|M\/OL)\]/.exec(text);
  if (match === null) return null;
  const title = (match[2] ?? "").trim();
  if (title === "") return null;
  const authors = splitChineseAuthors((match[1] ?? "").trim());
  return { ...(authors !== undefined ? { authors } : {}), title };
}

function splitChineseAuthors(segment: string): string[] | undefined {
  const names = segment
    .split(/[,，;；]|\s+and\s+|\s+等/)
    .map((name) => name.trim())
    .filter((name) => name !== "" && name.length <= 40 && !/\d/.test(name));
  return names.length >= 1 && names.length <= 15 ? names : undefined;
}

export function despaceIdentifierSpans(text: string): string {
  return text
    .replace(/10\s*[.．]\s*\d{4,5}\s*[/／][^］\]]*/g, (span) => span.replace(/\s+/g, ""))
    .replace(/https?\s*[：:]\s*\/\s*\/[^［\]]*/gi, (span) => span.replace(/\s+/g, ""));
}

/** CJIG author-year: `Authors. Year. Title//Venue. Place： Publisher： pages ［DOI：…］` */
function parseCjigAuthorYearStyle(text: string): { authors?: string[]; title: string; venue?: string; year?: number } | null {
  const match = /^([\p{L}\p{M}\u00AD'’\-.,，;；、\s]{3,200}?)[.．]\s*((?:19|20)\d{2}\s?[a-z]?)[.．]\s+(.+)$/u.exec(text);
  if (match === null) return null;
  const authors = splitChineseAuthors((match[1] ?? "").trim());
  if (authors === undefined) return null;
  const rest = (match[3] ?? "").replace(/\/\s*\//g, "//");
  const separator = rest.indexOf("//");
  const body = separator >= 0 ? rest.slice(0, separator) : rest;
  const title = (body.split(/[.．]/)[0] ?? "").replace(/\s*[［[]\s*[A-Za-z]{1,2}(?:\s*\/\s*OL)?\s*[\]］]\s*.*$/u, "").trim();
  if (title === "" || countWords(title) < 2) return null;
  const venuePart = separator >= 0 ? rest.slice(separator + 2) : rest.slice(body.length);
  const venue = venuePart.split(/[.．]/)[0]?.replace(/^[\s:：,，]+/, "").trim();
  return {
    ...(venue !== undefined && venue !== "" && countWords(venue) >= 2 ? { venue: venue.slice(0, 200) } : {}),
    year: Number.parseInt((match[2] ?? "").trim(), 10),
    authors,
    title,
  };
}

function normalizeDoi(raw: string): string {
  return raw
    .replace(/^doi:/i, "")
    .replace(/^https?:\/\/doi\.org\//i, "")
    .replace(/[.,;)\]］」，；:：]+$/u, "")
    .trim()
    .toLowerCase();
}

function splitAuthors(segment: string): string[] | undefined {
  const names = segment
    .split(/,| and |&/i)
    .map((name) => name.trim())
    .filter((name) => name !== "" && countWords(name) <= 5 && !/\d/.test(name));
  return names.length >= 1 && names.length <= 15 ? names : undefined;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((part) => part !== "").length;
}
