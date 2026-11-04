#!/usr/bin/env node
/**
 * mot-literature-mcp — local stdio MCP server.
 * stdout carries MCP protocol messages only; diagnostics go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { Library, configFromEnv, log } from "./library.js";
import { registerTools } from "./tools.js";

export const SERVER_VERSION = "0.1.1";

async function main(): Promise<void> {
  let library: Library;
  try {
    library = new Library(configFromEnv());
  } catch (error) {
    log(`startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const server = new McpServer({ name: "mot-literature", version: SERVER_VERSION });
  registerTools(server, library);
  await server.connect(new StdioServerTransport());
  log(`ready (pdf_root=${library.config.pdfRoot}, cache_dir=${library.config.cacheDir})`);
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
