#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { compile, fetchNodeCatalog, formatDiagnostic, parse } from "./index.js";

const help = `Usage: coupl compile <file.coupl> --server <url> [--output <file.json>]

Compile a Coupl graph against a ComfyUI instance's /object_info catalog.
Without --output, JSON is written to stdout. Diagnostics go to stderr.
Compilation does not submit or execute the graph.

Options:
  --server <url>   ComfyUI base URL (required)
  --output <file>  Write JSON to a file after successful compilation
  --help, -h      Show this help

Set COUPL_BEARER_TOKEN for a server protected by bearer authentication.
`;

interface Options { file: string; server: string; output?: string }

function argumentsFor(argv: string[]): Options {
  if (argv[0] !== "compile") throw new Error("Expected the 'compile' command. Use --help for usage.");
  let file: string | undefined, server: string | undefined, output: string | undefined;
  const seen = new Set<string>();
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--server" || arg === "--output") {
      if (seen.has(arg)) throw new Error(`${arg} was supplied more than once.`);
      seen.add(arg);
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      if (arg === "--server") server = value; else output = value;
    } else if (arg.startsWith("-")) { throw new Error(`Unknown option ${arg}.`); }
    else if (file) { throw new Error("Expected exactly one source file."); }
    else file = arg;
  }
  if (!file) throw new Error("A source file is required.");
  if (!server) throw new Error("--server is required.");
  return output === undefined ? { file, server } : { file, server, output };
}

async function writeOutput(file: string, output: string, text: string): Promise<void> {
  const sourcePath = await realpath(file);
  const outputPath = resolve(output);
  if (sourcePath === outputPath) throw new Error("The output file must differ from the source file.");
  try {
    const [sourceStat, targetStat, targetPath] = await Promise.all([stat(file), stat(outputPath), realpath(outputPath)]);
    if (sourcePath === targetPath || (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)) throw new Error("The output file must differ from the source file.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temporary = join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, outputPath);
  } finally { await rm(temporary, { force: true }); }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(help); return; }
  const options = argumentsFor(argv);
  const source = await readFile(options.file, "utf8");
  // Report syntax errors without requiring a healthy server.
  const syntax = parse(source);
  if (syntax.diagnostics.length) {
    for (const diagnostic of syntax.diagnostics) process.stderr.write(formatDiagnostic(diagnostic, source, options.file) + "\n");
    process.exitCode = 1; return;
  }
  const token = process.env.COUPL_BEARER_TOKEN;
  const catalog = await fetchNodeCatalog(options.server, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const result = compile(source, catalog);
  for (const diagnostic of result.diagnostics) process.stderr.write(formatDiagnostic(diagnostic, source, options.file) + "\n");
  if (!result.ok) { process.exitCode = 1; return; }
  const json = JSON.stringify(result.graph, null, 2) + "\n";
  if (options.output) await writeOutput(options.file, options.output, json);
  else process.stdout.write(json);
}

main().catch((error: unknown) => {
  process.stderr.write(`coupl: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exitCode = 1;
});
