/**
 * Deterministic full-text page search (no index server, no embeddings).
 *
 * Matching is substring-based on a normalized form: NFKC (full-width → half-width),
 * lower-case, and all whitespace removed — PDF text layers break Chinese words
 * across lines ("多目\n标跟踪"), so whitespace must not block a match. Each
 * whitespace-separated query term must occur on the page (AND). Results keep the
 * page number so every hit can be re-read with read_paper_pages.
 */

export const MAX_QUERY_CHARS = 200;
const SNIPPET_RADIUS = 70;

export interface NormalizedText {
  norm: string;
  /** norm index → original index */
  map: number[];
}

export function normalizeForSearch(text: string): NormalizedText {
  let norm = "";
  const map: number[] = [];
  let index = 0;
  for (const ch of text) {
    const folded = ch.normalize("NFKC").toLowerCase();
    if (!/^\s+$/u.test(folded) && folded !== "") {
      for (const unit of folded) {
        if (/\s/u.test(unit)) continue;
        norm += unit;
        map.push(index);
      }
    }
    index += ch.length;
  }
  return { norm, map };
}

export function parseQuery(query: string): string[] {
  const trimmed = query.trim();
  if (trimmed === "") {
    throw new Error("query must not be empty");
  }
  if (trimmed.length > MAX_QUERY_CHARS) {
    throw new Error(`query too long (${trimmed.length} > ${MAX_QUERY_CHARS} chars)`);
  }
  const terms = [...new Set(trimmed.split(/\s+/u).map((t) => normalizeForSearch(t).norm).filter((t) => t !== ""))];
  if (terms.length === 0) {
    throw new Error("query has no searchable characters");
  }
  return terms.slice(0, 10);
}

export interface PageHit {
  page: number;
  matchCount: number;
  snippet: string;
}

/** Search one page; undefined if not every term occurs. */
export function searchPage(page: number, text: string, terms: string[]): PageHit | undefined {
  const { norm, map } = normalizeForSearch(text);
  let total = 0;
  let firstPos = -1;
  for (const term of terms) {
    let count = 0;
    let from = 0;
    for (;;) {
      const pos = norm.indexOf(term, from);
      if (pos < 0) break;
      if (count === 0 && term === terms[0]) firstPos = pos;
      count += 1;
      from = pos + term.length;
    }
    if (count === 0) return undefined;
    total += count;
  }
  const start = map[firstPos] ?? 0;
  const lo = Math.max(0, start - SNIPPET_RADIUS);
  const hi = Math.min(text.length, start + SNIPPET_RADIUS * 2);
  const snippet = `${lo > 0 ? "…" : ""}${text.slice(lo, hi).replace(/\s+/g, " ").trim()}${hi < text.length ? "…" : ""}`;
  return { page, matchCount: total, snippet };
}
