import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { ComfyClient, ExecutionError } from '../dist/index.js';
import { createComfyClient } from '../dist/node-client.js';
import { catalog } from './fixtures/catalog.mjs';

const graph = { preview: { class_type: 'PreviewImage', inputs: {} } };
const outputs = { preview: { images: [{ filename: '../../image.png', subfolder: 'test space', type: 'output' }], text: ['completed'] } };
const success = { outputs, status: { completed: true, status_str: 'success', messages: [] } };
const opts = { pollIntervalMs: 5, timeoutMs: 1000 };
async function body(req) { let data = ''; for await (const chunk of req) data += chunk; return JSON.parse(data); }
async function serverFor(t, handler, upgrade) {
  const server = createServer((req, res) => Promise.resolve(handler(req, res)).catch(error => { res.destroy(error); }));
  if (upgrade) server.on('upgrade', upgrade);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }

test('authenticated websocket progress, early events, prompt filtering, history and output download preserve base paths', async t => {
  const ws = new WebSocketServer({ noServer: true });
  t.after(() => { for (const socket of ws.clients) socket.terminate(); ws.close(); });
  let socket, clientId, submitted = 0;
  const server = await serverFor(t, async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    if (req.url === '/comfy/prompt') {
      const data = await body(req); submitted++;
      assert.deepEqual(data.prompt, graph); assert.equal(data.client_id, clientId);
      socket.send(JSON.stringify({ type: 'execution_error', data: { prompt_id: 'someone-else', exception_message: 'wrong job' } }));
      socket.send(JSON.stringify({ type: 'executing', data: { prompt_id: 'one', node: 'preview' } }));
      socket.send(JSON.stringify({ type: 'progress', data: { prompt_id: 'one', node: 'preview', value: 2, max: 4 } }));
      setTimeout(() => json(res, { prompt_id: 'one', node_errors: {} }), 20);
    } else if (req.url === '/comfy/history/one') json(res, { one: success });
    else if (req.url.startsWith('/comfy/view?')) {
      const url = new URL(req.url, server); assert.equal(url.searchParams.get('subfolder'), 'test space');
      assert.equal(url.searchParams.get('filename'), '../../image.png'); res.end('image bytes');
    } else { res.writeHead(404); res.end(); }
  }, (req, raw, head) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    const url = new URL(req.url, 'http://test'); assert.equal(url.pathname, '/comfy/ws');
    clientId = url.searchParams.get('clientId');
    ws.handleUpgrade(req, raw, head, connection => { socket = connection; });
  });
  const events = [];
  const client = createComfyClient(server + '/comfy/', { headers: { Authorization: 'Bearer test-token' } });
  const result = await client.run(graph, { ...opts, onEvent: event => events.push(event) });
  assert.equal(submitted, 1); assert.equal(result.promptId, 'one'); assert.deepEqual(result.outputs, outputs);
  assert.deepEqual(events.filter(event => event.type === 'progress').map(event => [event.node, event.value, event.max]), [['preview', 2, 4]]);
  assert.equal(events[0].type, 'queued'); assert.equal(result.files.length, 1);
  assert.equal(Buffer.from(await client.download(result.files[0])).toString(), 'image bytes');
});

test('a dropped progress socket and transient history failures do not resubmit', async t => {
  const ws = new WebSocketServer({ noServer: true });
  t.after(() => { for (const socket of ws.clients) socket.terminate(); ws.close(); });
  let requests = 0, histories = 0;
  const server = await serverFor(t, async (req, res) => {
    if (req.url === '/prompt') { await body(req); requests++; for (const socket of ws.clients) socket.terminate(); json(res, { prompt_id: 'one' }); }
    else if (++histories < 3) { res.destroy(); }
    else json(res, { one: success });
  }, (req, raw, head) => ws.handleUpgrade(req, raw, head, () => {}));
  const result = await createComfyClient(server).run(graph, opts);
  assert.equal(result.promptId, 'one'); assert.equal(requests, 1); assert.equal(histories, 3);
});

test('submission validation includes source node names and does not poll', async t => {
  let count = 0;
  const server = await serverFor(t, (_req, res) => { count++; json(res, { error: { message: 'Invalid graph' }, node_errors: { preview: { errors: [{ message: 'Bad image', details: 'missing' }] } } }, 400); });
  await assert.rejects(new ComfyClient(server).run(graph, opts), error => error instanceof ExecutionError && error.issues[0].node === 'preview' && /missing/.test(error.issues[0].message));
  assert.equal(count, 1);
});

test('history execution errors are not mistaken for successful completion', async t => {
  const server = await serverFor(t, (req, res) => req.url === '/prompt' ? json(res, { prompt_id: 'bad' }) : json(res, { bad: { outputs: {}, status: { completed: false, status_str: 'error', messages: [['execution_error', { node_id: 'preview', exception_message: 'Out of memory' }]] } } }));
  await assert.rejects(new ComfyClient(server).run(graph, opts), error => error.promptId === 'bad' && error.issues[0].node === 'preview' && /memory/.test(error.message));
});

test('live execution failures are surfaced even if history is not yet available', async t => {
  let receive;
  const server = await serverFor(t, async (req, res) => {
    if (req.url === '/prompt') { await body(req); receive({ type: 'execution_error', data: { prompt_id: 'one', node_id: 'preview', exception_message: 'GPU failed' } }); json(res, { prompt_id: 'one' }); }
    else json(res, {});
  });
  const client = new ComfyClient(server, { progressTransport: async (_url, _headers, callback) => { receive = callback; return () => {}; } });
  await assert.rejects(client.run(graph, opts), /GPU failed/);
});

test('aborting monitoring never calls interrupt or deletes another queued run', async t => {
  const paths = [], controller = new AbortController();
  const server = await serverFor(t, (req, res) => { paths.push(req.url); if (req.url === '/prompt') json(res, { prompt_id: 'one' }); else { json(res, {}); controller.abort(); } });
  await assert.rejects(new ComfyClient(server).run(graph, { ...opts, signal: controller.signal }), error => error.promptId === 'one' && /may still run/.test(error.message));
  assert.ok(paths.every(path => path === '/prompt' || path === '/history/one'));
});

test('timeouts, malformed history, and unknown submission outcomes fail without duplicate submission', async t => {
  for (const mode of ['timeout', 'malformed', 'lost-submit', 'bad-submit']) {
    let submissions = 0;
    const server = await serverFor(t, (req, res) => {
      if (req.url === '/prompt') { submissions++; if (mode === 'lost-submit') res.destroy(); else json(res, mode === 'bad-submit' ? {} : { prompt_id: 'one' }); }
      else json(res, mode === 'malformed' ? { one: { outputs: {} } } : {});
    });
    await assert.rejects(new ComfyClient(server).run(graph, { ...opts, timeoutMs: 50 }), mode.includes('submit') ? /outcome is unknown/ : mode === 'timeout' ? /timed out/ : /no execution status/);
    assert.equal(submissions, 1);
  }
});

test('redirects do not forward bearer credentials to a second origin', async t => {
  let leaked = 0;
  const other = await serverFor(t, (_req, res) => { leaked++; res.end('secret response'); });
  const server = await serverFor(t, (_req, res) => { res.writeHead(307, { Location: other }); res.end(); });
  await assert.rejects(new ComfyClient(server, { headers: { Authorization: 'Bearer secret' } }).run(graph, opts), /outcome is unknown/);
  assert.equal(leaked, 0);
});

test('invalid monitoring options and pre-aborted runs do not submit', async t => {
  let count = 0;
  const server = await serverFor(t, (_req, res) => { count++; json(res, {}); });
  const client = new ComfyClient(server);
  for (const timeoutMs of [0, -1, NaN, 2 ** 40]) await assert.rejects(client.run(graph, { timeoutMs }));
  await assert.rejects(client.run(graph, { signal: AbortSignal.abort() }));
  assert.equal(count, 0);
});

function cli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), ...args], { env: { ...process.env, COUPL_BEARER_TOKEN: '', ...env } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timeout')); }, 10000);
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('CLI compiles, runs, and safely downloads results; existing output directories prevent submission', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coupl-run-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let submissions = 0;
  const server = await serverFor(t, async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    if (req.url === '/object_info') json(res, catalog());
    else if (req.url === '/prompt') { const data = await body(req); assert.ok(data.prompt.sample); submissions++; json(res, { prompt_id: 'one' }); }
    else if (req.url === '/history/one') json(res, { one: success });
    else if (req.url.startsWith('/view?')) res.end('image bytes');
    else { res.writeHead(404); res.end(); }
  });
  const input = fileURLToPath(new URL('../examples/text-to-image.coupl', import.meta.url));
  const args = ['run', input, '--server', server, '--output-dir', join(directory, 'outputs')];
  const result = await cli(args, { COUPL_BEARER_TOKEN: 'test-token' });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).promptId, 'one');
  assert.deepEqual((await readdir(join(directory, 'outputs'))).sort(), ['1-image.png', 'result.json']);
  assert.equal(await readFile(join(directory, 'outputs', '1-image.png'), 'utf8'), 'image bytes');
  assert.equal((await cli(args, { COUPL_BEARER_TOKEN: 'test-token' })).code, 1); assert.equal(submissions, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /test-token/);
});

test('CLI runtime failures have node source locations and return failure', async t => {
  const server = await serverFor(t, (req, res) => {
    if (req.url === '/object_info') json(res, catalog());
    else if (req.url === '/prompt') json(res, { prompt_id: 'one' });
    else if (req.url === '/history/one') json(res, { one: { status: { status_str: 'error', completed: false, messages: [['execution_error', { node_id: 'sample', exception_message: 'GPU failed' }]] }, outputs: {} } });
    else { res.writeHead(404); res.end(); }
  });
  const result = await cli(['run', fileURLToPath(new URL('../examples/text-to-image.coupl', import.meta.url)), '--server', server]);
  assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /text-to-image\.coupl:\d+:\d+: sample: GPU failed/);
});

test('known prompt monitoring resumes without submitting and preserves text-only outputs', async t => {
  const paths = [];
  const server = await serverFor(t, (req, res) => { paths.push(req.url); json(res, { known: { ...success, outputs: { text: { text: ['hello'] } } } }); });
  const result = await new ComfyClient(server).wait('known', opts);
  assert.deepEqual(paths, ['/history/known']); assert.equal(result.files.length, 0); assert.deepEqual(result.outputs, { text: { text: ['hello'] } });
});

test('throwing progress observers reject monitoring without throwing into the websocket event loop', async t => {
  let receive;
  const server = await serverFor(t, (req, res) => {
    if (req.url === '/prompt') json(res, { prompt_id: 'one' });
    else { receive({ type: 'executing', data: { prompt_id: 'one', node: 'preview' } }); json(res, {}); }
  });
  const client = new ComfyClient(server, { progressTransport: async (_url, _headers, callback) => { receive = callback; return () => {}; } });
  await assert.rejects(client.run(graph, { ...opts, onEvent: event => { if (event.type === 'executing') throw new Error('observer failed'); } }), error => error.promptId === 'one' && /event handler failed/.test(error.message));
});
