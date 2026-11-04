import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { configFromEnv } from "../src/library.js";

const ROOT = resolve(tmpdir(), "x-lit-config-root");
const LEGACY_ROOT = resolve(tmpdir(), "x-lit-config-legacy");

describe("configFromEnv", () => {
  it("reads X_LIT_* variables", () => {
    const cache = resolve(tmpdir(), "x-lit-config-cache");
    const config = configFromEnv({ X_LIT_PDF_ROOT: ROOT, X_LIT_CACHE_DIR: cache, X_LIT_PYTHON: "py-x" });
    expect(config.pdfRoot).toBe(ROOT);
    expect(config.cacheDir).toBe(cache);
    expect(config.python).toBe("py-x");
  });

  it("defaults the cache to <tmp>/x-literature-mcp-cache", () => {
    expect(configFromEnv({ X_LIT_PDF_ROOT: ROOT }).cacheDir).toBe(resolve(join(tmpdir(), "x-literature-mcp-cache")));
  });

  it("accepts deprecated MOT_LIT_* only as a fallback", () => {
    expect(configFromEnv({ MOT_LIT_PDF_ROOT: LEGACY_ROOT, MOT_LIT_PYTHON: "py-legacy" })).toMatchObject({
      pdfRoot: LEGACY_ROOT,
      python: "py-legacy",
    });
    expect(configFromEnv({ X_LIT_PDF_ROOT: ROOT, MOT_LIT_PDF_ROOT: LEGACY_ROOT }).pdfRoot).toBe(ROOT);
  });

  it("names X_LIT_PDF_ROOT when the root is missing or relative", () => {
    expect(() => configFromEnv({})).toThrow("X_LIT_PDF_ROOT is not set");
    expect(() => configFromEnv({ X_LIT_PDF_ROOT: "relative/dir" })).toThrow("X_LIT_PDF_ROOT must be an absolute path");
  });
});
