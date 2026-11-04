import { describe, expect, it } from "vitest";

import { extractReferences, parseReferenceFields, type PageLines } from "../src/references.js";

// v0.1.1 regressions. Text is synthetic; the layouts (bbox geometry, markers, number/year
// patterns) reproduce the failure modes found in the real CNKI corpus (Phase 36 audit).

type Box = [number, number, number, number];
const laid = (n: number, ...items: Array<[string, Box]>): PageLines => ({
  page: n,
  blocks: items.map(([t]) => t),
  boxes: items.map(([, b]) => b),
});
// two-column page: left x 58–293, right x 311–546
const L = (y: number): Box => [58, y, 293, y + 18];
const R = (y: number): Box => [311, y, 546, y + 18];

describe("continuation markers (another article on the same journal page)", () => {
  it("下转 → 上接: uses this article's heading, skips the other heading and the upper region", () => {
    const result = extractReferences([
      laid(
        8,
        ["本文结论。", L(660)],
        ["参考文献", L(684)],
        ["[1] ALPHA A. First own entry[J]. Journal A, 2020, 1(1): 1-2.", L(705)],
        ["[2] BETA B. Second own entry[J]. Journal B, 2019, 2(2): 3-4.", R(72)],
        ["(下转第1471页)", [466, 743, 549, 768]],
      ),
      laid(
        9,
        ["另一篇文章的结语。", L(71)],
        ["参考文献", L(100)],
        ["[1] OTHER O. Fuel cell durability[J]. Power Sources, 2008, 182(2): 469-475.", L(120)],
        ["[2] OTHER P. Fuel cells[M]. Springer, 2013.", R(72)],
        ["（上接第1426页）", [57, 466, 140, 490]],
        ["[3] GAMMA C. Third own entry[J]. Journal C, 2017, 35(4): 629-634.", L(483)],
        ["[4] DELTA D. Fourth own entry[J]. Journal D, 2018, 18(19): 8074-8084.", R(509)],
      ),
    ]);
    expect(result.heading?.page).toBe(8);
    expect(result.entries.map((e) => e.number)).toEqual([1, 2, 3, 4]);
    expect(result.entries.map((e) => e.raw_text).join(" ")).not.toContain("OTHER");
    expect(result.entries[2]).toMatchObject({ page_start: 9, page_end: 9 });
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded![0]).toMatchObject({ page: 9, numbers: [1, 2] });
    expect(result.issues.join(" ")).toContain("FOREIGN_HEADING_SKIPPED");
    expect(result.issues.join(" ")).toContain("OTHER_ARTICLE_TEXT_EXCLUDED");
  });

  it("上接 without 下转: the lower region is another article's tail and is excluded", () => {
    const result = extractReferences([
      laid(3, ["正文。", L(100)]),
      laid(
        4,
        ["参考文献:", L(539)],
        ["[1] ALPHA A. Own entry one[J]. Journal, 2017, 34(6): 1909-1912.", L(554)],
        ["[2] BETA B. Own entry two[J]. Journal, 2018, 35(2): 632-636.", R(55)],
        ["( 上接第3127 页)\n[12] OTHER O. Mapping framework[C]//Proc. 2017: 1-8.", L(636)],
        ["[13] OTHER P. Line drawing[P]. 1998.", R(636)],
      ),
    ]);
    expect(result.entries.map((e) => e.number)).toEqual([1, 2]);
    expect(result.excluded![0]).toMatchObject({ page: 4, numbers: [12, 13] });
  });

  it("without bboxes nothing is split (v0.1.0 behaviour)", () => {
    const result = extractReferences([
      { page: 4, blocks: ["参考文献:", "[1] A A. One[J]. J, 2017, 1(1): 1-2.", "(上接第3127页)", "[12] B B. Other[J]. J, 2016, 2(2): 3-4."] },
    ]);
    expect(result.entries.map((e) => e.number)).toEqual([1, 12]);
    expect(result.excluded).toBeUndefined();
  });
});

describe("detached hanging number labels", () => {
  it("re-attaches '[n]' blocks emitted after their entry text (no off-by-one numbering)", () => {
    const result = extractReferences([
      laid(
        8,
        ["参考文献(References):", [66, 724, 182, 737]],
        ["王某, 李某. 第一条中文标题[J]. 学报, 2017, 40(1): 1-6.", [85, 748, 297, 757]],
        ["[1]", [66, 748, 78, 757]],
        ["KIM C, LI F. Multiple hypothesis tracking revisited[C]. ICCV, 2015: 4696-4704.", [336, 124, 548, 134]],
        ["[2]", [317, 124, 329, 133]],
        ["HU H, ZHOU L. An automatic tracking method[J]. IEEE Access, 2018, 6: 69782-69793.", [336, 197, 548, 206]],
        ["[3]", [317, 197, 329, 206]],
      ),
    ]);
    expect(result.entries.map((e) => [e.number, e.raw_text.slice(0, 8)])).toEqual([
      [1, "[1] 王某, "],
      [2, "[2] KIM "],
      [3, "[3] HU H"],
    ]);
    expect(result.issues.join(" ")).toContain("NUMBER_LABELS_REATTACHED: 3");
  });

  it("does not attach a label to a table cell on the same baseline", () => {
    const result = extractReferences([
      laid(
        10,
        ["参考文献：", L(100)],
        ["[1] A A. One[J]. J, 2017, 1(1): 1-2.", L(120)],
        ["[7]", [100, 300, 112, 310]],
        ["43.09 45.18 48.52", [114, 300, 200, 310]],
      ),
    ]);
    expect(result.issues.join(" ")).not.toContain("NUMBER_LABELS_REATTACHED");
  });
});

describe("numbering checks are flags, never deletions", () => {
  it("a second list restarting at [1] is kept but marked suspected_other_article", () => {
    const result = extractReferences([
      {
        page: 9,
        blocks: [
          [
            "参考文献",
            "[1] ALPHA A. Own entry one[J]. Journal, 2001, 1(1): 1-2.",
            "[2] BETA B. Own entry two[J]. Journal, 2002, 2(1): 3-4.",
            "[3] GAMMA C. Own entry three[J]. Journal, 2003, 3(1): 5-6.",
            "[1] XI X. Other article one[J]. Other, 2010, 4(1): 7-8.",
            "[2] YU Y. Other article two[J]. Other, 2011, 5(1): 9-10.",
          ].join("\n"),
        ],
      },
    ]);
    expect(result.entries).toHaveLength(5);
    expect(result.entries.slice(3).every((e) => e.quality?.attribution === "suspected_other_article")).toBe(true);
    expect(result.entries[0]!.quality?.attribution).toBeUndefined();
    expect(result.issues.join(" ")).toContain("NUMBERING_RESTART_SUSPECTED");
  });

  it("bilingual pairs sharing a number are not flagged", () => {
    const result = extractReferences([
      { page: 9, blocks: ["参考文献\n[1] 张三. 中文题名[J]. 学报, 2020, 1(1): 1-2.\n[1] ZHANG S. English title[J]. Journal, 2020, 1(1): 1-2.\n[2] 李四. 题名二[J]. 学报, 2021, 2(1): 3-4."] },
    ]);
    expect(result.entries.flatMap((e) => e.issues).join(" ")).not.toMatch(/NUMBER_OUT_OF_SEQUENCE|NUMBERING_RESTART/);
  });
});

describe("author-year splitting", () => {
  it("CJIG entries without a recognised terminator are still split at the next 'Authors. Year.' line", () => {
    const result = extractReferences([
      {
        page: 17,
        blocks: [
          [
            "参考文献（References）",
            "Dosovitskiy A， Beyer L and Kolesnikov A. 2021. An image is worth 16 × 16 words//Proceedings of ICLR. Vienna， Austria： OpenReview.net",
            "Hao X Y， Luo S J and Wu H. 2024. Infrared small target detection with super-resolution. IEEE Transactions， 62： #5000412",
            "He J B and Hua X S. 2021. α-IoU： a family of power IoU losses. Advances in NeurIPS， 34： 20230-20242",
          ].join("\n"),
        ],
      },
    ]);
    expect(result.entries).toHaveLength(3);
    expect(result.entries[1]!.fields.year).toBe(2024);
  });

  it("joined initials ('Sittler RW．') start a new entry", () => {
    const result = extractReferences([
      {
        page: 7,
        blocks: [
          "参考文献\nHu W，Li X，Luo W，et al．Single and multiple object tracking［J］．IEEE TPAMI，2012，34( 12) : 2420-2440．\nSittler ＲW．An optimal data association problem［J］．IEEE Transactions on Military Electronics，2007，8 ( 2) : 125-139．",
        ],
      },
    ]);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.fields.year)).toEqual([2012, 2007]);
  });
});

describe("publication year (fields.year only when placed by pattern)", () => {
  const y = (text: string) => {
    const f = parseReferenceFields(text.normalize("NFKC"));
    return { year: f.year, evidence: f.yearEvidence, candidates: f.yearCandidates, issues: f.yearIssues ?? [] };
  };

  it("page ranges are not years (the 'future year' failure)", () => {
    expect(y("Author A. Title[J]. IEEE TPAMI, 2016, 38(10): 2054-2068").year).toBe(2016);
    expect(y("Author A. Title[J]. Acta Automatica Sinica, 2023, 49(10): 2073－ 2083.").year).toBe(2023);
    expect(y("Author A. Title[C]. CVPR, Portland, USA, 2013: 2043–2050. doi: 10.1109/CVPR.2013.266.").year).toBe(2013);
    expect(y("Author A. Title[J]. Control and Decision, 2021, 36(9): 2049-2062.)").year).toBe(2021);
  });

  it("page ranges inside 2019–2026 and volume numbers do not override the imprint year", () => {
    expect(y("Author A. Title[J]. Journal, 2015, 37(9): 2019-2026.").year).toBe(2015);
    expect(y("Author A. Title[J]. Journal, 2008, 2008(1): 1-10.").year).toBe(2008);
  });

  it("DOI and arXiv digits are not years", () => {
    expect(y("Author A. Title[J]. Pattern Recognition Letters, 2019, arXiv: 1908. 05641.").year).toBe(2019);
    expect(y("Author A. Title[C]. ICIP 2016: 3464-3468. doi: 10.1109/ICIP.2016.7533003.").year).toBe(2016);
  });

  it("access date of an online source is not the publication year", () => {
    const r = y("Author A. MOT16: a benchmark[OL]. [2022-07-25]. https://arxiv.org/abs/1603.00831");
    expect(r.year).toBeUndefined();
    expect(r.evidence).toBe("not_found");
    expect(r.candidates).toEqual([2016]);
    expect(r.issues.join(" ")).toContain("YEAR_NOT_FOUND");
    expect(y("Author A. YOLOX[EB/OL]. (2021-07-18) [2022-04-11]. https://arxiv.org/abs/2107.08430.").year).toBe(2021);
    expect(y("刘某. 某综述[J]. 自动化学报, 2019-11-08:1-13.").year).toBe(2019);
  });

  it("classic imprints and unmapped private-use punctuation (CNKI fonts)", () => {
    expect(y("Author A. Tracking with JPDA[J]. IEEE J Oceanic Eng, 1983, 8(3): 173-184.").year).toBe(1983);
    expect(y("Author A. Ensemble tracking[J]. IEEE Transactions on Pattern Analysis and Machine Intelligence\uE00F2007\uE00F29 ( 2) : 261-271．").year).toBe(2007);
    expect(y("Author A. Title[J]. 中国图象图形学报，2008\uE00F13( 10) : 1873- 1877．").year).toBe(2008);
    expect(y("Author A. Title[C]//IEEE Conference on Computer Vision and Pattern Recognition2015: 2113- 2120．").year).toBe(2015);
  });

  it("conflicting placed years → ambiguous, no fields.year", () => {
    const r = y("Hu W. Title one[J]. IEEE TPAMI, 2012, 34(12): 2420-2440. Sittler RW. Title two[J]. Electronics, 2007, 8(2): 125-139.");
    expect(r.year).toBeUndefined();
    expect(r.evidence).toBe("ambiguous");
    expect(r.candidates?.sort()).toEqual([2007, 2012]);
  });

  it("an implausible future year is rejected, never reported as fields.year", () => {
    const r = y("Author A. Title[J]. Journal, 2087, 1(1): 1-2.");
    expect(r.year).toBeUndefined();
    expect(r.issues.join(" ")).toContain("YEAR_FUTURE_REJECTED");
  });

  it("entries carry quality.year", () => {
    const result = extractReferences([{ page: 1, blocks: ["参考文献\n[1] A A. One[J]. J, 2017, 1(1): 1-2.\n[2] B B. Two[OL]. [2022-07-25]. https://example.org/x"] }]);
    expect(result.entries.map((e) => e.quality?.year)).toEqual(["verified_by_pattern", "not_found"]);
  });
});
