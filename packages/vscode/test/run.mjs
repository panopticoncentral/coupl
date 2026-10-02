import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog } from '../../../test/fixtures/catalog.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coupl-vscode-test-'));
const workspace = join(directory, 'workspace');
await mkdir(join(workspace, '.vscode'), { recursive: true });
await writeFile(join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'coupl.catalogPath': 'catalog.json', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none' }));
await writeFile(join(workspace, 'catalog.json'), JSON.stringify(catalog()));
await writeFile(join(workspace, 'test.coupl'), 'checkpoint = CheckpointLoaderSimple("example.safetensors")\nx = CLIPTextEncode("hello", clip = checkpoint.');
const code = process.env.COUPL_VSCODE_EXECUTABLE ?? (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' : 'code');
try {
  const child = spawn(code, ['--new-window', '--wait', '--user-data-dir', join(directory, 'profile'), '--extensions-dir', join(directory, 'extensions'),
    '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    `--extensionDevelopmentPath=${resolve(root, 'packages/vscode')}`, `--extensionTestsPath=${resolve(root, 'packages/vscode/test/extension.cjs')}`, workspace], { stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill(), 60000);
  try {
    const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    if (exit !== 0) throw new Error(`VS Code smoke test exited with ${exit}.`);
    console.log(await readFile(join(workspace, 'smoke-result.txt'), 'utf8'));
  } finally { clearTimeout(timeout); }
} finally { await rm(directory, { recursive: true, force: true }); }
