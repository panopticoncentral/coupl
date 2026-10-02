import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fetchNodeCatalog } from "../dist/index.js";
import { catalog } from "./fixtures/catalog.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const example = fileURLToPath(new URL("../examples/text-to-image.coupl", import.meta.url));
const expected = JSON.parse(await readFile(new URL("../examples/text-to-image.api.json", import.meta.url), "utf8"));

function run(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, COUPL_BEARER_TOKEN: "", ...extraEnv } });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("CLI timed out")); }, 20_000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

async function serverFor(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "coupl-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("CLI fetches the catalog once, emits API JSON, and never submits a prompt", async t => {
  const requests = [];
  const server = await serverFor(t, (req, res) => { requests.push([req.method, req.url]); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(catalog())); });
  const result = await run(["compile", example, "--server", server]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(result.stderr, "");
  assert.deepEqual(requests, [["GET", "/object_info"]]);
});

test("base URL path and bearer authentication are preserved without printing credentials", async t => {
  const server = await serverFor(t, (req, res) => {
    assert.equal(req.url, "/comfy/object_info");
    assert.equal(req.headers.authorization, "Bearer synthetic-test-token");
    res.end(JSON.stringify(catalog()));
  });
  const result = await run(["compile", example, "--server", server + "/comfy/"], { COUPL_BEARER_TOKEN: "synthetic-test-token" });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-test-token/);
});

test("successful file output replaces an existing file without temporary leftovers", async t => {
  const path = await directory(t), output = join(path, "graph.json");
  await writeFile(output, "old");
  const server = await serverFor(t, (_req, res) => res.end(JSON.stringify(catalog())));
  const result = await run(["compile", example, "--server", server, "--output", output]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), expected);
  assert.deepEqual(await readdir(path), ["graph.json"]);
});

test("compilation failure preserves output and reports source location", async t => {
  const path = await directory(t), input = join(path, "bad.coupl"), output = join(path, "graph.json");
  await writeFile(input, 'x = CheckpointLoaderSimple("missing.safetensors")');
  await writeFile(output, "keep me");
  const server = await serverFor(t, (_req, res) => res.end(JSON.stringify(catalog())));
  const result = await run(["compile", input, "--server", server, "--output", output]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /bad\.coupl:1:28: error E_ENUM/);
  assert.equal(await readFile(output, "utf8"), "keep me");
});

test("source file cannot be overwritten, including through a symlink", async t => {
  const path = await directory(t), input = join(path, "input.coupl"), alias = join(path, "alias.json");
  const source = await readFile(example, "utf8");
  await writeFile(input, source); await symlink(input, alias);
  const server = await serverFor(t, (_req, res) => res.end(JSON.stringify(catalog())));
  for (const output of [input, alias]) {
    const result = await run(["compile", input, "--server", server, "--output", output]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /must differ from the source/);
    assert.equal(await readFile(input, "utf8"), source);
  }
});

test("syntax failure does not fetch the server", async t => {
  let requests = 0;
  const path = await directory(t), input = join(path, "bad.coupl");
  await writeFile(input, "x = (");
  const server = await serverFor(t, (_req, res) => { requests++; res.end("{}"); });
  const result = await run(["compile", input, "--server", server]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /E_SYNTAX/);
  assert.equal(requests, 0);
});

test("HTTP and malformed-catalog failures emit no graph or secret response body", async t => {
  for (const [status, body] of [[401, "secret detail"], [200, "not JSON"], [200, "[]"], [200, "{}"], [200, '{"wrong":true}']]) {
    const server = await serverFor(t, (_req, res) => { res.statusCode = status; res.end(body); });
    const result = await run(["compile", example, "--server", server]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /secret detail/);
    assert.match(result.stderr, /coupl:/);
  }
});

test("catalog client rejects redirects and times out", async t => {
  const redirect = await serverFor(t, (_req, res) => { res.writeHead(302, { Location: "/login" }); res.end(); });
  await assert.rejects(fetchNodeCatalog(redirect));
  const stalled = await serverFor(t, () => {});
  await assert.rejects(fetchNodeCatalog(stalled, { timeoutMs: 30 }));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(fetchNodeCatalog(stalled, { signal: aborted.signal }));
});

test("help and usage failures need no server", async () => {
  assert.equal((await run(["--help"])).code, 0);
  for (const args of [[], ["run"], ["compile", example], ["compile", example, "--server"], ["compile", example, "--typo"], ["compile", example, "--server", "x", "--server", "y"]]) {
    assert.equal((await run(args)).code, 1);
  }
});
