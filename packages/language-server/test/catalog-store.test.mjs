import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../dist/catalog-store.js';
import { catalog } from '../../../test/fixtures/catalog.mjs';

test('saved catalogs cache, refresh, retain last good data, and isolate configurations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coupl-lsp-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'catalog.json');
  const schemas = catalog();
  await writeFile(path, JSON.stringify(schemas));
  const store = new CatalogStore();
  const settings = { serverUrl: '', catalogPath: path };
  assert.deepEqual((await store.get(settings)).catalog, schemas);
  await writeFile(path, '{broken');
  assert.equal((await store.get(settings)).message, undefined);
  store.refresh();
  assert.match((await store.get(settings)).message, /last successful/);
  assert.deepEqual((await store.get(settings)).catalog, schemas);
  assert.equal((await store.get({ ...settings, catalogPath: path + '.missing' })).catalog, undefined);
  store.clear();
  assert.equal((await store.get(settings)).catalog, undefined);
});

test('server failure falls back to a saved catalog with an actionable status', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coupl-lsp-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'catalog.json');
  await writeFile(path, JSON.stringify(catalog()));
  const result = await new CatalogStore().get({ serverUrl: 'invalid://server', catalogPath: path });
  assert.ok(result.catalog);
  assert.match(result.message, /saved catalog; refresh to retry/);
});
