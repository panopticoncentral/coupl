#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { compile, ExecutionError, fetchNodeCatalog, formatDiagnostic, parse } from "./index.js";
import { createComfyClient } from "./node-client.js";

const help = `Usage: coupl compile <file.coupl> --server <url> [--output <file.json>]
       coupl run <file.coupl> --server <url> [--output-dir <new-directory>] [--timeout <seconds>]

Compile a Coupl graph against a ComfyUI instance's /object_info catalog.
Without --output, JSON is written to stdout. Diagnostics go to stderr.
The compile command does not submit or execute the graph.
The run command submits once, waits for completion, and prints result JSON.
Run progress goes to stderr. Ctrl-C stops monitoring; server work may continue.

Options:
  --server <url>   ComfyUI base URL (required)
  --output <file>  Write JSON to a file after successful compilation
  --output-dir <dir>  Download run outputs into a new directory
  --timeout <seconds> Monitoring deadline including queue time (default: 3600)
  --help, -h      Show this help

Set COUPL_BEARER_TOKEN for a server protected by bearer authentication.
`;

interface Options { command: "compile" | "run"; file: string; server: string; output?: string; outputDir?: string; timeoutMs: number }

function argumentsFor(argv: string[]): Options {
  const command = argv[0];
  if (command !== "compile" && command !== "run") throw new Error("Expected compile or run. Use --help for usage.");
  let file: string | undefined, server: string | undefined, output: string | undefined, outputDir: string | undefined;
  let timeoutMs = 3_600_000;
  const seen = new Set<string>();
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--server" || arg === "--output" || arg === "--output-dir" || arg === "--timeout") {
      if (seen.has(arg)) throw new Error(`${arg} was supplied more than once.`);
      seen.add(arg);
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      if (arg === "--server") server = value;
      else if (arg === "--output") output = value;
      else if (arg === "--output-dir") outputDir = value;
      else { timeoutMs = Number(value) * 1000; if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("--timeout must be a positive number of seconds."); }
    } else if (arg.startsWith("-")) { throw new Error(`Unknown option ${arg}.`); }
    else if (file) { throw new Error("Expected exactly one source file."); }
    else file = arg;
  }
  if (!file) throw new Error("A source file is required.");
  if (!server) throw new Error("--server is required.");
  if (command === "compile" && (outputDir || seen.has("--timeout"))) throw new Error("--output-dir and --timeout require the run command.");
  if (command === "run" && output) throw new Error("Use --output-dir with run, or redirect stdout for result JSON.");
  return { command, file, server, timeoutMs, ...(output ? { output } : {}), ...(outputDir ? { outputDir } : {}) };
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
  if (options.command === "run") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    const client = createComfyClient(options.server, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    try {
      // Reserve a new directory before queuing; never overwrite existing user files.
      if (options.outputDir) await mkdir(options.outputDir);
      const completed = await client.run(result.graph, { signal: controller.signal, timeoutMs: options.timeoutMs, onEvent: event => {
        if (event.type === "queued") {
          process.stderr.write(`Queued ${event.promptId}\n`);
          for (const issue of event.issues ?? []) process.stderr.write(`Warning: ${issue.node}: ${issue.message}\n`);
        } else if (event.type === "executing") process.stderr.write(`Executing ${event.node}\n`);
        else if (event.type === "progress") process.stderr.write(`${event.node ?? "Progress"}: ${event.value}/${event.max}\n`);
        else if (event.message) process.stderr.write(event.message + "\n");
      } });
      const json = JSON.stringify(completed, null, 2) + "\n";
      // Emit the durable prompt id and server output references even if a later download fails.
      process.stdout.write(json);
      if (options.outputDir) {
        await writeFile(join(options.outputDir, "result.json"), json, { flag: "wx" });
        for (const [index, file] of completed.files.entries()) {
          const name = `${index + 1}-${basename(file.filename.replaceAll("\\", "/")).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
          await writeFile(join(options.outputDir, name), await client.download(file, controller.signal), { flag: "wx" });
          process.stderr.write(`Saved ${name}\n`);
        }
      }
    } catch (error) {
      if (error instanceof ExecutionError) {
        if (error.promptId) process.stderr.write(`Prompt: ${error.promptId}\n`);
        for (const issue of error.issues) {
          const declaration = syntax.declarations.find(node => node.name === issue.node);
          process.stderr.write(`${options.file}:${declaration?.span.start.line ?? 1}:${declaration?.span.start.column ?? 1}: ${issue.node}: ${issue.message}\n`);
        }
      }
      throw error;
    } finally { process.removeListener("SIGINT", stop); }
    return;
  }
  const json = JSON.stringify(result.graph, null, 2) + "\n";
  if (options.output) await writeOutput(options.file, options.output, json);
  else process.stdout.write(json);
}

main().catch((error: unknown) => {
  process.stderr.write(`coupl: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exitCode = 1;
});
