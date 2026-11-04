# PaperTeam reuse notes

Source repository: https://github.com/JiahongXu88/PaperTeam (MIT, Copyright (c) 2026 Jiahong Xu)
Audited at `main` HEAD **642103d80dbe7ea63fc7131d1b022b9de74e3ed2** (2026-11-03), from a local read-only clone (nothing in PaperTeam was modified).
Each row was decided after reading the source file and its imports, not the README.

| PaperTeam path (last change) | Depends on | Decision | What landed here |
|---|---|---|---|
| `backend/src/paper/ReferenceExtractor.ts` (e2aa82f) | `util/hash`, `citation/integrity` types, `citation/referenceText`, `paper/types` | **extract small functions** | `src/references.ts`: `parseReferenceFields` and its helpers (`parseQuotedTitleStyle`, `parseCjigAuthorYearStyle`, `parseGbt7714Style`, `splitChineseAuthors`, `despaceIdentifierSpans`, `normalizeDoi`, `splitAuthors`, `pickTitleSegment`, `segmentsOf`), `NON_ENTRY_UNIT`, `AUTHOR_YEAR_ENTRY_START/END`, numeric and author-year entry collection. Logic unchanged except: GB/T type list also accepts `Z`, `A`, `M/OL`; the page-number unit pattern also accepts `- 33 -` footers; arXiv id pattern tolerates `arXiv.2103.08808`; year matching uses digit look-arounds instead of `\b` (years glued to letters such as `CVPR2019` count); fields are parsed on the NFKC-folded entry text (full-width `［Ｊ］`, `２０２２`). Dropped: body citation-callout extraction (`extractCallouts`, `resolveAuthorYear`, `sentenceAround`, `expandNumericList`), sha256 fingerprints, PaperTeam `PaperChunk`/`ReferenceEntry` types. |
| `backend/src/citation/referenceText.ts` (d3744a8) | none | **extract small function** | `normalizeReferenceText`, `repairLineBreakHyphenation` (copied). Title-matching helpers (`titleQueryVariants`, `compactTitle`, …) skipped — no verification here. |
| `backend/tools/parse_paper_pdf.py` (ceb7153) | PyMuPDF | **thin rewrite following the same pattern** | `python/pdf_worker.py` reuses the stdout isolation trick (fd 1 → fd 2 while MuPDF runs, JSON via duplicated handle), the "metadata title → largest first-page font line" title heuristic and the structured `{ok:false, code}` errors. New: per-page block lists, font-based heading candidates, two-column detection, page rendering. |
| `backend/src/paper/sectionChunking.ts` (d3744a8) | `paper/types`, `PdfParser` types | **skip (vocabulary only)** | Chinese/English heading keyword list reused in `KEYWORD_HEADING` of the worker. Its TOC/heading section builder and References-page finder (`findReferencesPage`) were not portable to the target corpus: all 53 PDFs have no TOC, and headings such as vertical `参\n考\n文\n献`, `［参…献］`, `参考文献(References):` are missed by its regex — a new locator was written in `src/references.ts`. |
| `backend/test/paper/referenceExtraction.test.ts` | vitest, PaperTeam test stack | **port regression cases** | `tests/references.test.ts`: IEEE / GB/T 7714 / APA field cases and the M15.15 CJIG cases (full-width DOI brackets, typographic DOI spaces, broken arXiv URL, figure-caption/page-number exclusion). The HTTP/service e2e (attention.pdf) was not ported. |
| `backend/src/ingestion/LegacyPdfTextParser.ts` (—) | `PdfParser`, `sectionChunking`, `PdfAnalyzer`, ingestion types | **skip** | Wrapper over PaperTeam's ingestion state; the useful part (PyMuPDF text layer) is covered by the worker. |
| `backend/src/ingestion/DoclingParser.ts` (508803f) | `DoclingToolchain`, ingestion types, Docling Python env | **skip in MVP** | Docling needs a large model download; not required for text-layer CNKI PDFs (53/53 have text). Can be added later as an optional backend. |
| `backend/src/ingestion/ParsedDocumentStore.ts`, `types.ts` | project store | **skip** | Cache here is one JSON per PDF hash under `X_LIT_CACHE_DIR`. |
| `backend/src/retrieval/lexicalIndex.ts` (3bac8f8), `tokenize.ts`, `SourceChunker.ts`, `chunking.ts` | `SourceChunk` types | **skip** | BM25 over chunks is unnecessary for ~500 pages; `src/search.ts` does whitespace/width-insensitive substring matching per page, which keeps exact page provenance and handles Chinese words broken across lines. |
| `backend/src/sources/identity.ts` | `referenceText.compactTitle` | **skip** | De-duplication is by file SHA-256 only. |
| ProjectStore / EvidenceStore / AgentRuntime / WorkflowOrchestrator / Web UI / Quality Gate / target-journal services | — | **skip (out of scope)** | — |

**v0.1.1 divergence from the ported code** (in `src/references.ts`; PaperTeam unchanged): the year selection of
`parseReferenceFields` (last four-digit number in the entry) was replaced by a position-based `pickYear`; the author-year
collector gained two start rules (joined initials, a CJIG `Authors. Year.` line); the bbox-based layout pass
(continuation markers, detached labels) is new code with no PaperTeam counterpart.

`docs/research/M15_15_*` and `M15_16_*` were used only as background on CJIG layouts; their constraints are reflected by the ported CJIG tests.

Third-party: `@modelcontextprotocol/server` (Apache-2.0), `zod` (MIT). PyMuPDF (AGPL-3.0 or Artifex commercial) is **not bundled**; the user installs it and it runs as a separate Python process.
