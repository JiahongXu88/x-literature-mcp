import { describe, expect, it } from "vitest";

import { MAX_QUERY_CHARS, normalizeForSearch, parseQuery, searchPage } from "../src/search.js";

describe("search", () => {
  it("Chinese substring matches across line breaks and full-width characters", () => {
    expect(searchPage(3, "结合卡尔\n曼滤波与外观特征", parseQuery("卡尔曼滤波"))).toMatchObject({ page: 3, matchCount: 1 });
    expect(searchPage(1, "ＭＯＴＡ达到７５.６", parseQuery("mota 75.6"))?.matchCount).toBe(2);
  });

  it("all terms must occur on the page; English is case-insensitive", () => {
    const terms = parseQuery("ByteTrack 遮挡");
    expect(searchPage(1, "bytetrack handles occlusion", terms)).toBeUndefined();
    expect(searchPage(1, "BYTETRACK 在遮挡下", terms)?.matchCount).toBe(2);
  });

  it("snippet maps back to original text around the first term", () => {
    const text = `${"前".repeat(200)}匈牙利算法${"后".repeat(200)}`;
    const hit = searchPage(1, text, parseQuery("匈牙利算法"))!;
    expect(hit.snippet).toContain("匈牙利算法");
    expect(hit.snippet.startsWith("…")).toBe(true);
  });

  it("rejects empty / whitespace / overlong queries", () => {
    expect(() => parseQuery("")).toThrow(/empty/);
    expect(() => parseQuery("   \n ")).toThrow(/empty/);
    expect(() => parseQuery("x".repeat(MAX_QUERY_CHARS + 1))).toThrow(/too long/);
  });

  it("normalization keeps an index map", () => {
    const n = normalizeForSearch("A b\nＣ");
    expect(n.norm).toBe("abc");
    expect(n.map).toEqual([0, 2, 4]);
  });
});
