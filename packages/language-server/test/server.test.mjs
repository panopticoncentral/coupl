import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { catalog } from '../../../test/fixtures/catalog.mjs';

async function server(t, options = {}) {
  const child = fork(resolve('packages/vscode/dist/server.cjs'), ['--node-ipc'], { silent: true });
  let next = 0, stderr = '';
  const pending = new Map(), notifications = [], listeners = new Set();
  child.stderr.on('data', data => stderr += data);
  child.on('message', message => {
    if (message.method && message.id !== undefined) {
      const result = message.method === 'workspace/configuration'
        ? message.params.items.map(item => options.configuration?.(item.scopeUri) ?? {}) : null;
      child.send({ jsonrpc: '2.0', id: message.id, result });
    } else if (message.id !== undefined) {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      if (callback) message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
    } else {
      notifications.push(message);
      for (const listener of listeners) listener();
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}; ${stderr}`)); }, 8000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.send({ jsonrpc: '2.0', id, method, params });
  });
  const notify = (method, params) => child.send({ jsonrpc: '2.0', method, params });
  const waitFor = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Notification timed out; ${stderr}`)); }, 8000);
    function check() {
      const found = notifications.find(predicate);
      if (found) { clearTimeout(timer); listeners.delete(check); resolve(found.params); }
    }
    listeners.add(check); check();
  });
  t.after(async () => {
    try { await request('shutdown', null); notify('exit'); }
    finally { if (child.exitCode === null) child.kill(); }
  });
  const initialize = await request('initialize', {
    processId: process.pid, rootUri: null, workspaceFolders: options.folders ?? null,
    capabilities: { workspace: { configuration: true, workspaceFolders: true } },
    initializationOptions: { trusted: options.trusted !== false },
  });
  assert.equal(initialize.capabilities.definitionProvider, true);
  notify('initialized', {});
  return { request, notify, waitFor, notifications };
}

test('bundled server handles IPC, unsaved incremental edits, configuration, definitions, and close', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coupl-lsp-protocol-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'catalog.json'), JSON.stringify(catalog()));
  const uri = pathToFileURL(join(directory, 'test.coupl')).href;
  const app = await server(t, { folders: [{ uri: pathToFileURL(directory).href, name: 'test' }], configuration: () => ({ catalogPath: 'catalog.json' }) });
  const line = 'x = CLIPTextEncode("hi", clip = checkpoint.CLIP)';
  const referenceStart = line.indexOf('checkpoint');
  app.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'coupl', version: 1, text: `checkpoint = CheckpointLoaderSimple("example.safetensors")\n${line}` } });
  const diagnostics = await app.waitFor(event => event.method === 'textDocument/publishDiagnostics' && event.params.version === 1);
  assert.ok(!diagnostics.diagnostics.some(item => item.severity === 1 || item.code === 'CATALOG_STATUS'));
  const definition = await app.request('textDocument/definition', { textDocument: { uri }, position: { line: 1, character: 40 } });
  assert.equal(definition.range.start.line, 0);
  app.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start: { line: 1, character: referenceStart }, end: { line: 1, character: line.length - 1 } }, text: 'checkpoint.' }] });
  const items = await app.request('textDocument/completion', { textDocument: { uri }, position: { line: 1, character: referenceStart + 'checkpoint.'.length } });
  assert.ok(items.some(item => item.label === 'CLIP'));
  const changed = await app.waitFor(event => event.method === 'textDocument/publishDiagnostics' && event.params.version === 2);
  assert.ok(changed.diagnostics.some(item => item.code === 'E_SYNTAX'));
  app.notify('textDocument/didClose', { textDocument: { uri } });
  await app.waitFor(event => event.method === 'textDocument/publishDiagnostics' && event.params.version === undefined && event.params.diagnostics.length === 0);
});

test('untrusted workspace never requests a catalog and still reports syntax errors', async t => {
  let reads = 0;
  const app = await server(t, { trusted: false, configuration: () => { reads++; return { serverUrl: 'https://example.invalid' }; } });
  const uri = 'untitled:test.coupl';
  app.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'coupl', version: 1, text: 'x = Node(' } });
  const result = await app.waitFor(event => event.method === 'textDocument/publishDiagnostics');
  assert.equal(reads, 0);
  assert.ok(result.diagnostics.some(item => item.code === 'E_SYNTAX'));
  assert.match(result.diagnostics.find(item => item.code === 'CATALOG_STATUS').message, /Trust/);
});

test('slow catalog loading cannot publish diagnostics for an obsolete document version', async t => {
  let reply;
  const started = new Promise(resolve => reply = resolve);
  const http = createServer((request, response) => { reply(() => response.end(JSON.stringify(catalog()))); });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => { http.closeAllConnections(); http.close(); });
  const app = await server(t, { configuration: () => ({ serverUrl: `http://127.0.0.1:${http.address().port}` }) });
  const uri = 'file:///test.coupl';
  app.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'coupl', version: 1, text: 'x = Unknown()' } });
  const finish = await started;
  app.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'x = CheckpointLoaderSimple("example.safetensors")' }] });
  // A request acts as an ordering barrier, ensuring didChange has reached the server.
  await app.request('textDocument/definition', { textDocument: { uri }, position: { line: 0, character: 0 } });
  finish();
  const result = await app.waitFor(event => event.method === 'textDocument/publishDiagnostics' && event.params.version === 2);
  assert.ok(!result.diagnostics.some(item => item.code === 'E_NODE_CLASS'));
  assert.ok(!app.notifications.some(event => event.method === 'textDocument/publishDiagnostics' && event.params.version === 1));
});
