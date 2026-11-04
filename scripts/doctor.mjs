#!/usr/bin/env node
/**
 * Install check for X Literature MCP. Read-only with respect to your files:
 * it never edits MCP client configuration, never deletes caches and never
 * uploads anything. It only
 *   - checks Node.js, the build output and a Python interpreter with PyMuPDF,
 *   - optionally starts the built server over stdio and calls read-only tools
 *     (`--self-test` on a throw-away PDF in a fresh temp folder that is removed
 *     afterwards; `--pdf-root` on your own folder, which builds the normal cache),
 *   - prints the absolute paths to put into an MCP client configuration.
 *
 * Usage: node scripts/doctor.mjs [--self-test] [--pdf-root DIR] [--cache-dir DIR]
 *                                [--python EXE] [--timeout SECONDS] [--json]
 * Exit code: 0 = all requested checks passed, 1 = a check failed, 2 = bad usage.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "server.js");
const EXPECTED_TOOLS = ["get_paper_references", "get_paper_structure", "list_papers", "read_paper_pages", "refresh_index", "render_paper_page", "search_papers"];
const WIN = process.platform === "win32";

function parseArgs(argv) {
  const opts = { selfTest: false, json: false, pdfRoot: undefined, cacheDir: undefined, python: undefined, timeout: 600 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${arg} needs a value`);
      return v;
    };
    if (arg === "--self-test") opts.selfTest = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--pdf-root") opts.pdfRoot = value();
    else if (arg === "--cache-dir") opts.cacheDir = value();
    else if (arg === "--python") opts.python = value();
    else if (arg === "--timeout") opts.timeout = Number(value());
    else if (arg === "-h" || arg === "--help") usage();
    else usage(`unknown argument: ${arg}`);
  }
  if (!(opts.timeout > 0)) usage("--timeout must be a positive number of seconds");
  return opts;
}

function usage(message) {
  if (message) process.stderr.write(`doctor: ${message}\n`);
  process.stderr.write("usage: node scripts/doctor.mjs [--self-test] [--pdf-root DIR] [--cache-dir DIR] [--python EXE] [--timeout SECONDS] [--json]\n");
  process.exit(message ? 2 : 0);
}

const PY_PROBE = "import json, sys\ntry:\n    import pymupdf\n    v = getattr(pymupdf, '__version__', None) or getattr(pymupdf, 'VersionBind', 'unknown')\nexcept Exception as e:\n    v = None\nprint(json.dumps({'executable': sys.executable, 'python': '%d.%d.%d' % sys.version_info[:3], 'ok_version': sys.version_info >= (3, 9), 'pymupdf': v}))";

function probePython(exe) {
  try {
    const out = execFileSync(exe, ["-I", "-c", PY_PROBE], { encoding: "utf8", timeout: 60_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return { candidate: exe, ...JSON.parse(out.trim().split(/\r?\n/).pop()) };
  } catch (error) {
    return { candidate: exe, error: String(error.code ?? error.message).slice(0, 200) };
  }
}

/** --python > X_LIT_PYTHON > <repo>/.venv > python / python3 on PATH. First one with PyMuPDF wins. */
function findPython(explicit) {
  const venv = WIN ? join(ROOT, ".venv", "Scripts", "python.exe") : join(ROOT, ".venv", "bin", "python");
  const candidates = explicit
    ? [explicit]
    : [process.env.X_LIT_PYTHON, existsSync(venv) ? venv : undefined, ...(WIN ? ["python", "python3"] : ["python3", "python"])].filter(Boolean);
  const tried = [];
  for (const c of [...new Set(candidates)]) {
    const r = probePython(c);
    tried.push(r);
    if (r.pymupdf && r.ok_version) return { chosen: r, tried, source: c === explicit ? "--python" : c === process.env.X_LIT_PYTHON ? "X_LIT_PYTHON" : c === venv ? "repo .venv" : "PATH" };
  }
  return { chosen: undefined, tried };
}

function countPdfs(dir, limit = 100_000) {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < limit) {
    let entries;
    try {
      entries = readdirSync(stack.pop(), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(e.parentPath ?? e.path, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".pdf")) n++;
    }
  }
  return n;
}

/** Minimal MCP client over newline-delimited JSON-RPC (stdio transport). */
async function smoke({ pdfRoot, cacheDir, python, timeoutMs, calls }) {
  const env = { ...process.env, X_LIT_PDF_ROOT: pdfRoot, X_LIT_PYTHON: python };
  if (cacheDir) env.X_LIT_CACHE_DIR = cacheDir;
  else delete env.X_LIT_CACHE_DIR;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  const pending = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  let nextId = 1;
  const request = (method, params, ms = 30_000) =>
    Promise.race([
      new Promise((r) => {
        const id = nextId++;
        pending.set(id, r);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }),
      exited.then((code) => ({ error: { message: `server exited with code ${code}` } })),
      new Promise((r) => setTimeout(() => r({ error: { message: `timeout after ${ms / 1000}s` } }), ms)),
    ]);
  const result = { ok: false, steps: [] };
  try {
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x-literature-doctor", version: "1" } });
    if (init.error) throw new Error(`initialize: ${init.error.message}`);
    result.server = init.result.serverInfo;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = await request("tools/list", {});
    if (tools.error) throw new Error(`tools/list: ${tools.error.message}`);
    result.tools = tools.result.tools.map((t) => t.name).sort();
    if (JSON.stringify(result.tools) !== JSON.stringify(EXPECTED_TOOLS)) throw new Error(`unexpected tool list: ${result.tools.join(", ")}`);
    for (const [name, args, check] of calls) {
      const res = await request("tools/call", { name, arguments: args }, timeoutMs);
      if (res.error) throw new Error(`${name}: ${res.error.message}`);
      const text = res.result.content.find((b) => b.type === "text")?.text ?? "";
      if (res.result.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
      result.steps.push({ tool: name, ...check(text) });
    }
    result.ok = true;
  } catch (error) {
    result.error = error.message;
    result.stderr_tail = stderr.trim().split(/\r?\n/).slice(-5).join("\n");
  } finally {
    child.stdin.end();
    setTimeout(() => child.kill(), 1000).unref();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  }
  return result;
}

const listCheck = (text) => {
  const json = JSON.parse(text.split("\n\n")[0]);
  return { papers_returned: json.papers.length, sample: json.papers.slice(0, 3).map((p) => ({ paper_id: p.paper_id, file_name: p.file_name, parse_status: p.parse_status })) };
};

const SELF_TEST_PDF = "import sys, pymupdf\ndoc = pymupdf.open()\npage = doc.new_page()\npage.insert_text((72, 100), 'X Literature MCP self-test page', fontsize=14)\npage.insert_text((72, 130), 'References', fontsize=12)\npage.insert_text((72, 150), '[1] A. Author. A synthetic reference. Journal of Tests, 2024, 1(1): 1-2.', fontsize=9)\ndoc.save(sys.argv[1])";

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = { ok: true, repo: ROOT, checks: {} };
  const fail = (key, detail) => {
    report.ok = false;
    report.checks[key] = { ok: false, ...detail };
  };

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) report.checks.node = { ok: true, version: process.versions.node, executable: process.execPath };
  else fail("node", { version: process.versions.node, fix: "Install Node.js 20 or newer" });

  if (existsSync(SERVER)) report.checks.build = { ok: true, server_js: SERVER };
  else fail("build", { server_js: SERVER, fix: "Run `npm ci` and `npm run build` in the repository folder" });

  const py = findPython(opts.python);
  if (py.chosen) report.checks.python = { ok: true, executable: py.chosen.executable, version: py.chosen.python, pymupdf: py.chosen.pymupdf, found_via: py.source };
  else
    fail("python", {
      tried: py.tried,
      fix: "Create a virtual environment in the repository and install PyMuPDF (see README, step 4), or pass --python / set X_LIT_PYTHON",
    });

  if (opts.pdfRoot !== undefined) {
    const root = opts.pdfRoot;
    if (!isAbsolute(root)) fail("pdf_root", { path: root, fix: "Use an absolute path" });
    else if (!existsSync(root) || !statSync(root).isDirectory()) fail("pdf_root", { path: root, fix: "Folder does not exist" });
    else report.checks.pdf_root = { ok: true, path: resolve(root), pdf_files: countPdfs(root) };
  }
  if (opts.cacheDir !== undefined) {
    const c = opts.cacheDir;
    const rel = opts.pdfRoot && isAbsolute(opts.pdfRoot) && isAbsolute(c) ? relative(resolve(opts.pdfRoot), resolve(c)) : undefined;
    const inside = rel !== undefined && (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)));
    if (!isAbsolute(c)) fail("cache_dir", { path: c, fix: "Use an absolute path" });
    else if (inside) fail("cache_dir", { path: c, fix: "The cache folder must not be inside the PDF folder" });
    else report.checks.cache_dir = { ok: true, path: resolve(c) };
  }

  const ready = report.checks.node?.ok && report.checks.build?.ok && report.checks.python?.ok;
  if (opts.selfTest) {
    if (!ready) fail("self_test", { skipped: "fix the failed checks above first" });
    else {
      const work = mkdtempSync(join(tmpdir(), "x-lit-doctor-"));
      try {
        const pdfDir = join(work, "pdfs");
        mkdirSync(pdfDir);
        execFileSync(py.chosen.executable, ["-I", "-c", SELF_TEST_PDF, join(pdfDir, "self-test.pdf")], { windowsHide: true });
        let paperId;
        const r = await smoke({
          pdfRoot: pdfDir,
          cacheDir: join(work, "cache"),
          python: py.chosen.executable,
          timeoutMs: opts.timeout * 1000,
          calls: [
            ["list_papers", {}, (t) => {
              const out = listCheck(t);
              paperId = out.sample[0]?.paper_id;
              if (out.papers_returned !== 1 || out.sample[0].parse_status !== "ok") throw new Error(`list_papers: expected 1 parsed paper, got ${JSON.stringify(out)}`);
              return out;
            }],
          ],
        });
        if (r.ok) {
          const r2 = await smoke({
            pdfRoot: pdfDir,
            cacheDir: join(work, "cache"),
            python: py.chosen.executable,
            timeoutMs: opts.timeout * 1000,
            calls: [["read_paper_pages", { paper_id: paperId, start_page: 1 }, (t) => {
              if (!t.includes("self-test page")) throw new Error("read_paper_pages: marker text not found");
              return { text_ok: true };
            }]],
          });
          r.steps.push(...r2.steps);
          if (!r2.ok) Object.assign(r, { ok: false, error: r2.error, stderr_tail: r2.stderr_tail });
        }
        if (r.ok) report.checks.self_test = { ok: true, server: r.server, tools: r.tools, steps: r.steps };
        else fail("self_test", r);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
  }

  if (opts.pdfRoot !== undefined && report.checks.pdf_root?.ok) {
    if (!ready) fail("pdf_root_smoke", { skipped: "fix the failed checks above first" });
    else {
      const r = await smoke({
        pdfRoot: resolve(opts.pdfRoot),
        cacheDir: opts.cacheDir ? resolve(opts.cacheDir) : undefined,
        python: py.chosen.executable,
        timeoutMs: opts.timeout * 1000,
        calls: [["list_papers", { limit: 5 }, listCheck]],
      });
      if (r.ok) report.checks.pdf_root_smoke = { ok: true, tools: r.tools, steps: r.steps };
      else fail("pdf_root_smoke", r);
    }
  }

  if (report.checks.build?.ok && report.checks.python?.ok) {
    report.register = {
      // GUI hosts (Cursor, VS Code, Claude Desktop) may not inherit a shell PATH: use node_executable as command there if "node" is not found.
      node_executable: process.execPath,
      command: "node",
      args: [SERVER],
      env: {
        ...(report.checks.pdf_root?.ok ? { X_LIT_PDF_ROOT: report.checks.pdf_root.path } : { X_LIT_PDF_ROOT: "<absolute path of your PDF folder>" }),
        X_LIT_PYTHON: py.chosen.executable,
        ...(report.checks.cache_dir?.ok ? { X_LIT_CACHE_DIR: report.checks.cache_dir.path } : {}),
      },
    };
  }

  if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else {
    for (const [key, value] of Object.entries(report.checks)) {
      const { ok, ...rest } = value;
      process.stdout.write(`${ok ? "OK  " : "FAIL"} ${key}: ${JSON.stringify(rest)}\n`);
    }
    if (report.register) process.stdout.write(`\nValues for the MCP client configuration:\n${JSON.stringify(report.register, null, 2)}\n`);
    process.stdout.write(`\n${report.ok ? "RESULT: OK" : "RESULT: FAILED"}\n`);
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`doctor: ${error.stack ?? error}\n`);
  process.exit(1);
});
