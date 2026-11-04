/**
 * Guards for the agent-first install path: the README must stay self-contained for an
 * AI agent, must not leak machine-specific paths, and scripts/doctor.mjs must work.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const TOOLS = ["get_paper_references", "get_paper_structure", "list_papers", "read_paper_pages", "refresh_index", "render_paper_page", "search_papers"];

function doctor(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "doctor.mjs"), ...args], { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout };
}

describe("README agent install section", () => {
  it("comes right after the project description and carries the copy-paste request", () => {
    const agent = README.indexOf("## Install with an AI Agent");
    expect(agent).toBeGreaterThan(0);
    expect(agent).toBeLessThan(README.indexOf("## Agent installation checklist"));
    expect(agent).toBeLessThan(README.indexOf("## Manual install"));
    expect(README).toContain("请帮我安装 https://github.com/JiahongXu88/x-literature-mcp 。");
    expect(README).toContain("not a hosted service");
  });

  it("covers every step and host the checklist promises", () => {
    for (const heading of ["Step 0", "Step 1", "Step 2", "Step 3", "Step 4", "Step 5", "Step 6", "Step 7", "#### Claude Code", "#### Codex CLI", "#### Gemini CLI", "#### Cursor", "#### VS Code / GitHub Copilot"]) {
      expect(README).toContain(heading);
    }
    for (const command of ["claude mcp add --scope user x-literature", "codex mcp add x-literature", "gemini mcp add --scope user", "claude mcp list", "codex mcp list", "gemini mcp list", "X_LIT_PYTHON", "doctor.mjs --self-test"]) {
      expect(README).toContain(command);
    }
    for (const tool of TOOLS) expect(README).toContain(`\`${tool}\``);
  });

  it("uses placeholders only, no machine-specific paths or personal e-mail addresses", () => {
    for (const file of ["README.md", "docs/AGENT_INSTALL.md", ".mcp.json.example", "scripts/doctor.mjs"]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, file).not.toMatch(/[A-Z]:[\\/](Projects|Tmp|Reports)[\\/]/i);
      expect(text, file).not.toMatch(/@qq\.com|zphz/i);
    }
  });
});

describe("scripts/doctor.mjs", () => {
  it("self-test starts the server over stdio and calls read-only tools", () => {
    const r = doctor(["--self-test", "--json"]);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(true);
    expect(report.checks.self_test.tools).toEqual(TOOLS);
    expect(report.checks.self_test.steps.map((s: { tool: string }) => s.tool)).toEqual(["list_papers", "read_paper_pages"]);
    expect(report.register.args).toEqual([join(ROOT, "dist", "server.js")]);
    expect(report.register.env.X_LIT_PYTHON).toBeTruthy();
  });

  it("rejects a relative PDF folder and bad arguments", () => {
    expect(doctor(["--pdf-root", "relative/papers", "--json"]).status).toBe(1);
    expect(doctor(["--no-such-flag"]).status).toBe(2);
  });
});
