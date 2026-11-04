import { describe, expect, it } from "vitest";

import { extractReferences, parseReferenceFields, type PageLines } from "../src/references.js";

const page = (n: number, ...blocks: string[]): PageLines => ({ page: n, blocks });

// ---- Ported from PaperTeam backend/test/paper/referenceExtraction.test.ts (MIT, 642103d8) ----

describe("parseReferenceFields (PaperTeam regression cases)", () => {
  it("IEEE quoted title + initials", () => {
    const fields = parseReferenceFields(
      "C.-Y. Wang, A. Bochkovskiy, and H.-Y. M. Liao, “Yolov7: Trainable bag-of-freebies sets new state-of-the-art for real-time object detectors,” in Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition, 2023, pp. 7464–7475.",
    );
    expect(fields.title).toBe("Yolov7: Trainable bag-of-freebies sets new state-of-the-art for real-time object detectors");
    expect(fields.authors).toEqual(["C.-Y. Wang", "A. Bochkovskiy", "H.-Y. M. Liao"]);
    expect(fields.year).toBe(2023);
    expect(fields.venue).toContain("Proceedings of the IEEE/CVF Conference");
  });

  it("GB/T 7714 Chinese", () => {
    const fields = parseReferenceFields("张三, 李四. 基于检测的多目标跟踪综述[J]. 计算机学报, 2021, 44(3): 1-20.");
    expect(fields.title).toBe("基于检测的多目标跟踪综述");
    expect(fields.authors).toEqual(["张三", "李四"]);
    expect(fields.year).toBe(2021);
  });

  it("APA style", () => {
    const fields = parseReferenceFields(
      "Vaswani, A., Shazeer, N., Parmar, N. Attention is all you need. In Advances in Neural Information Processing Systems, 2017.",
    );
    expect(fields.title).toBe("Attention is all you need");
    expect(fields.year).toBe(2017);
  });

  it("CJIG author-year with full-width DOI brackets", () => {
    const fields = parseReferenceFields(
      "Baek Y， Lee B， Han D， Yun S and Lee H. 2019. Character region awareness for text detection//Proceedings of 2019 IEEE/CVF Conference on Computer Vision and Pattern Recognition. Long Beach， USA： IEEE： 9357-9366 ［DOI： 10.1109/CVPR.2019.00959］",
    );
    expect(fields.title).toBe("Character region awareness for text detection");
    expect(fields.authors?.[0]).toBe("Baek Y");
    expect(fields.year).toBe(2019);
    expect(fields.doi).toBe("10.1109/cvpr.2019.00959");
  });

  it("DOI with typographic spaces", () => {
    const fields = parseReferenceFields(
      "Bottou L. 2010. Large-scale machine learning with stochastic gradient descent//Proceedings of the 19th International Conference on Computational Statistics. Paris, France: Physica-Verlag HD: 177-186 [DOI: 10. 1007 / 978-3-7908-2604-3_16]",
    );
    expect(fields.doi).toBe("10.1007/978-3-7908-2604-3_16");
  });

  it("broken arXiv URL → arxivId", () => {
    const fields = parseReferenceFields(
      "Child R, Gray S, Radford A and Sutskever I. 2019. Generating long sequences with sparse transformers [ EB / OL ]. [ 2021-08-13 ]. https:/ / arxiv. org/ pdf/ 1904. 10509. pdf",
    );
    expect(fields.arxivId).toBe("1904.10509");
  });
});

describe("CJIG author-year list (PaperTeam M15.15 fixture)", () => {
  it("merges wrapped lines per author start; figure captions / page numbers are not entries", () => {
    const pages = [
      page(
        5,
        "正文结尾。",
        [
          "参考文献（References）",
          "Baek Y， Lee B， Han D， Yun S and Lee H. 2019. Character region",
          "awareness for text detection//Proceedings of 2019 IEEE/CVF Con⁃",
          "ference on Computer Vision and Pattern Recognition. Long Beach，",
          "USA： IEEE： 9357-9366 ［DOI： 10.1109/CVPR.2019.00959］",
          "Ch'ng C K and Chan C S. 2017. Total-text： a comprehensive dataset for",
          "scene text detection and recognition//Proceedings of the 14th IAPR",
          "International Conference on Document Analysis and Recognition. Kyoto，",
          "Japan： IEEE： 935-942 ［DOI： 10.1109/ICDAR.2017.157］",
          "图8　不同应用场景下的相同实体类别“姓名”",
          "2292",
        ].join("\n"),
      ),
    ];
    const result = extractReferences(pages);
    expect(result.style).toBe("author-year");
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.fields.doi).toBe("10.1109/cvpr.2019.00959");
    expect(result.entries[1]!.raw_text).toContain("Total-text");
  });
});

// ---- New cases from the real CNKI layouts seen in the target corpus (synthetic text) ----

describe("extractReferences: section locator and numeric lists", () => {
  it("vertical heading 参/考/文/献 and an entry crossing a page break", () => {
    const result = extractReferences([
      page(6, "前文。\n参\n考\n文\n献\n[1] 张三, 李四. 标题甲[J]. 期刊甲, 2021, 1(1): 1-2.\n[2] 王五. 跨页条目的标题"),
      page(7, "页眉 第27卷第5期", "[J]. 期刊乙, 2020, 2(2): 3-4.\n[3] 赵六. 标题丙[C]//会议. 2019: 5-6."),
    ]);
    expect(result.status).toBe("found");
    expect(result.heading?.page).toBe(6);
    expect(result.entries.map((e) => e.number)).toEqual([1, 2, 3]);
    expect(result.entries[1]).toMatchObject({ page_start: 6, page_end: 7 });
    expect(result.entries[1]!.fields.title).toBe("跨页条目的标题");
    expect(result.issues).toEqual([]);
  });

  it("bracketed vertical heading, full-width numbers and markup (NFKC for fields only)", () => {
    const result = extractReferences([
      page(3, "［参\n考\n文\n献\n］\n［１］　甲乙丙，丁戊．合成测试用的跟踪算法综述［Ｊ］．控制与决策，\n２０２２，３７（１）：１-２０．"),
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.number).toBe(1);
    expect(result.entries[0]!.raw_text).toContain("［Ｊ］");
    expect(result.entries[0]!.fields.title).toBe("合成测试用的跟踪算法综述");
    expect(result.entries[0]!.fields.year).toBe(2022);
  });

  it("'参考文献(References):' heading; entry starting mid-line after a period is split", () => {
    const result = extractReferences([
      page(8, "结论。\n参考文献(References):\n[1] A B. Title one[J]. Journal, 2015: 1-2. [2] C D. Title two[J]. Journal, 2016: 3-4."),
    ]);
    expect(result.entries.map((e) => e.number)).toEqual([1, 2]);
  });

  it("picks the later heading that is actually followed by entries", () => {
    const result = extractReferences([
      page(7, "参考文献\n[1] 张三. 真实条目一[J]. 期刊, 2020.\n[2] 李四. 真实条目二[J]. 期刊, 2021."),
      page(8, "英文摘要页\nReferences\nThis line mentions nothing numbered."),
    ]);
    expect(result.heading?.page).toBe(7);
    expect(result.entries).toHaveLength(2);
  });

  it("stops at 作者简介 and reports numbering gaps", () => {
    const result = extractReferences([
      page(9, "参考文献：\n[1] 张三. 条目一[J]. 期刊, 2020.\n[3] 李四. 条目三[J]. 期刊, 2021.\n作者简介\n王五，男，硕士研究生。"),
    ]);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]!.raw_text).not.toContain("硕士");
    expect(result.issues.join(" ")).toContain("numbering gaps");
  });

  it("drops short duplicate-numbered table fragments interleaved by two-column order", () => {
    const result = extractReferences([
      page(
        8,
        "参考文献：\n[1] MILAN A, LEAL-TAIXE L. MOT16: a benchmark[J]. arXiv, 2016.\n[2] ByteTrack\n[2] ZHANG Y F, SUN P Z. ByteTrack: multi-object tracking[C]//ECCV. 2022: 1-21.",
      ),
    ]);
    expect(result.entries.map((e) => e.number)).toEqual([1, 2]);
    expect(result.issues.join(" ")).toContain("dropped 1 short duplicate-numbered");
  });

  it("letter-spaced running header (one char per line) does not leak into a cross-page entry", () => {
    const result = extractReferences([
      page(10, "参考文献(References)\n[42] Wang Z D, Zheng L. Towards real-time"),
      page(11, "900\n控\n制\n与\n决\n策\n第38卷", "multi-object tracking[C]. ECCV 2020: 107-122.\n[43] Zhang Y F. A simple baseline[J]. 2020."),
    ]);
    expect(result.entries[0]!.raw_text).toBe("[42] Wang Z D, Zheng L. Towards real-time multi-object tracking[C]. ECCV 2020: 107-122.");
    expect(result.entries[0]).toMatchObject({ page_start: 10, page_end: 11 });
  });

  it("no heading → not_found, no entries", () => {
    const result = extractReferences([page(1, "只有正文，没有参考文献列表。[1] 是正文里的引用标记。")]);
    expect(result.status).toBe("not_found");
    expect(result.entries).toEqual([]);
  });

  it("running header lines passed in dropLines are excluded", () => {
    const header = "某作者，等：基于某方法的研究";
    const result = extractReferences(
      [page(6, "参考文献\n[1] 张三. 跨页条目[J]."), page(7, `${header}\n期刊, 2020, 1(1): 1-2.\n[2] 李四. 条目二[J]. 期刊, 2021.`)],
      new Set([header]),
    );
    expect(result.entries[0]!.raw_text).not.toContain(header);
    expect(result.entries[0]!.page_end).toBe(7);
  });
});
