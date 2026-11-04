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

export const REFERENCE_EXTRACTION_VERSION = "r4.pt-v4n3";

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
}

export interface ReferenceFields {
  authors?: string[];
  year?: number;
  title?: string;
  venue?: string;
  doi?: string;
  arxiv_id?: string;
}

export interface ReferenceEntry {
  index: number;
  number?: number;
  raw_text: string;
  page_start: number;
  page_end: number;
  fields: ReferenceFields;
  issues: string[];
}

export interface ReferenceExtraction {
  version: string;
  status: "found" | "not_found";
  style: "numeric" | "author-year" | "unknown";
  heading?: { page: number; text: string };
  entries: ReferenceEntry[];
  issues: string[];
}

// ---------------- section locator (new) ----------------

/** matched against the NFKC-folded, whitespace-free text of 1–5 consecutive lines */
const HEADING_FULL =
  /^[[【(]?(?:\d{1,2}[.、]?)?(?:参考文献|references|bibliography|referencelist)[\]】)]?:?(?:\((?:references|bibliography)\))?:?$/i;
/** heading followed on the same line by the first entry: "参考文献：[1] ..." */
const HEADING_INLINE = /^\s*(?:参\s*考\s*文\s*献|references)\s*(?:[(（]\s*references\s*[)）])?\s*[:：]\s*(?=[[［]\s*[1１]\s*[\]］])/i;
/** lines that end the reference list (author bios, editor notes, appended English abstract) */
const SECTION_END =
  /^\s*(?:作者简介|作者介绍|\[?作者简介\]?|[（(]\s*责任编辑|责任编辑|附\s*录|appendix\b|abstract\s*[:：]|key\s*words\s*[:：])/i;

interface HeadingHit {
  pageIdx: number;
  blockIdx: number;
  lineIdx: number;
  lines: number;
  text: string;
  inlineRest?: string;
}

/** All heading-shaped lines, in document order. */
function locateHeadings(pages: PageLines[]): HeadingHit[] {
  const found: HeadingHit[] = [];
  pages.forEach((page, pageIdx) => {
    page.blocks.forEach((block, blockIdx) => {
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
function collectUnits(pages: PageLines[], heading: HeadingHit, dropLines: Set<string>): Unit[] {
  const units: Unit[] = [];
  const push = (page: number, raw: string): boolean => {
    for (const line of dropLetterSpacedRuns(raw.replace(MIDLINE_ENTRY, "$1\n").split("\n"))) {
      const text = line.replace(/\s+/g, " ").trim();
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

const AUTHOR_YEAR_ENTRY_END =
  /(?:[］\]]|[）)](?:\s*[．.;,;])?|pdf\b|html?\b|https?\s*[：:]\/\/\S*|\d{1,4}\s*[-–—]\s*\d{1,4}\s*[.．]?|[,，]\s*\d{1,3}$)\s*$/i;

const NUMERIC_HEAD = /^[[［]\s*([0-9０-９]{1,3})\s*[\]］]\s*/;

interface Collected {
  number?: number;
  text: string;
  pageStart: number;
  pageEnd: number;
}

export function extractReferences(pages: PageLines[], dropLines: Set<string> = new Set()): ReferenceExtraction {
  const candidates = locateHeadings(pages);
  if (candidates.length === 0) {
    return { version: REFERENCE_EXTRACTION_VERSION, status: "not_found", style: "unknown", entries: [], issues: ["no References/参考文献 heading found"] };
  }
  // Later headings win (body mentions come first), but only if entries follow them.
  let chosen: { hit: HeadingHit; collected: Collected[]; numeric: boolean } | undefined;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const hit = candidates[i]!;
    const units = collectUnits(pages, hit, dropLines);
    const numeric = units.filter((unit) => NUMERIC_HEAD.test(unit.text)).length >= 1;
    const collected = numeric ? collectNumeric(units) : collectAuthorYear(units);
    if (chosen === undefined) chosen = { hit, collected, numeric };
    if (collected.length >= 2) {
      chosen = { hit, collected, numeric };
      break;
    }
  }
  const { hit, numeric } = chosen!;
  let { collected } = chosen!;
  const heading = { page: pages[hit.pageIdx]!.page, text: hit.text };
  const issues: string[] = [];
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
    return {
      index: i + 1,
      ...(entry.number !== undefined ? { number: entry.number } : {}),
      raw_text: rawText,
      page_start: entry.pageStart,
      page_end: entry.pageEnd,
      fields: toSnakeFields(parseReferenceFields(entry.text.normalize("NFKC"))),
      issues: entryIssues,
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
  }
  return { version: REFERENCE_EXTRACTION_VERSION, status: "found", style, heading, entries, issues };
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
    if (AUTHOR_YEAR_ENTRY_START.test(unit.text) && (last === undefined || terminated)) {
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

// ---------------- field parsing (from ReferenceExtractor.ts, unchanged logic) ----------------

interface InternalFields {
  authors?: string[];
  year?: number;
  title?: string;
  venue?: string;
  doi?: string;
  arxivId?: string;
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

  const yearsText = identifiers
    .replace(/10\s*[.．]\s*\d{4,5}\s*[/／][^\s］\]]*/gi, " ")
    .replace(/arxiv(?:\.org)?[/:\s.]*(?:abs|pdf)?\/?\s*\d{4}\.\d{4,5}(?:v\d+)?/gi, " ")
    .replace(/https?\s*[：:]\s*\/\s*\/\S*/gi, " ");
  const years = [...yearsText.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)].map((m) => Number.parseInt(m[1] ?? "0", 10));
  if (years.length > 0) {
    out.year = years[years.length - 1];
  }

  const structured: { authors?: string[]; title: string; venue?: string; year?: number } | null =
    parseQuotedTitleStyle(text) ?? parseCjigAuthorYearStyle(identifiers) ?? parseGbt7714Style(text);
  if (structured !== null) {
    if (structured.authors !== undefined) out.authors = structured.authors;
    out.title = structured.title;
    if (Number.isInteger(structured.year)) out.year = structured.year;
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
