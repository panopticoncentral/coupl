import test from 'node:test';
import assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parse, parseForEditor } from '../../../dist/index.js';
import { LanguageDocument } from '../dist/language.js';
import { catalog, node } from '../../../test/fixtures/catalog.mjs';

function document(source, schemas = catalog()) {
  const offset = source.indexOf('|');
  source = source.replace('|', '');
  const text = TextDocument.create('file:///workspace/test.coupl', 'coupl', 1, source);
  return { language: new LanguageDocument(text, schemas), position: text.positionAt(offset < 0 ? source.length : offset) };
}
function completions(source, schemas) { const { language, position } = document(source, schemas); return language.completions(position); }

test('editor recovery preserves preceding, partial, and following declarations without changing strict parsing', () => {
  const source = 'a = CheckpointLoaderSimple("example.safetensors")\nb = CLIPTextEncode(text = "hello",\nc = SaveImage(images = b)';
  const editor = parseForEditor(source);
  assert.deepEqual(editor.declarations.map(d => d.name), ['a', 'b', 'c']);
  assert.equal(editor.declarations[1].args[0].name, 'text');
  assert.ok(editor.diagnostics.length);
  assert.deepEqual(parse(source).declarations, []);
});

test('recovery ignores declaration-shaped text inside strings and comments, and survives lexical errors', () => {
  const source = 'x = """hello\npretend = Node()\n"""\n// other = Node()\n!\ny = SaveImage()';
  assert.deepEqual(parseForEditor(source).declarations.map(d => d.name), ['x', 'y']);
  assert.deepEqual(parseForEditor('bad = "unfinished\ny = SaveImage()').declarations.map(d => d.name), ['y']);
});

test('completion includes catalog classes and quotes nonidentifier names', () => {
  const items = completions('x = Ve|', { ...catalog(), 'Vendor: Node': node({}, []) });
  assert.equal(items.find(item => item.label === 'Vendor: Node').textEdit.newText, '"Vendor: Node"');
});

test('unfinished calls offer inputs, enum choices, and exclude already supplied inputs', () => {
  let items = completions('x = CheckpointLoaderSimple(ckpt_name = |');
  assert.ok(items.some(item => item.textEdit.newText === '"example.safetensors"'));
  items = completions('x = CLIPTextEncode(text = "hello", |');
  assert.ok(items.some(item => item.label === 'clip'));
  assert.ok(!items.some(item => item.label === 'text'));
});

test('enum completion replaces the entire quoted value', () => {
  const { language, position } = document('x = CheckpointLoaderSimple("exa|mple")');
  const item = language.completions(position).find(item => item.label === 'example.safetensors');
  assert.equal(TextDocument.applyEdits(language.document, [item.textEdit]), 'x = CheckpointLoaderSimple("example.safetensors")');
});

test('port completion supports unfinished selectors, quoted names, and duplicate names', () => {
  const schemas = { ...catalog(), Odd: node({}, ['IMAGE', 'CLIP', 'CLIP'], { names: ['output name', 'duplicate', 'duplicate'] }) };
  let items = completions('a = Odd()\nb = SaveImage(images = a.|', schemas);
  assert.equal(items[0].textEdit.newText, '["output name"]');
  assert.deepEqual(items.slice(1).map(item => item.textEdit.newText), ['[1]', '[2]']);
  const { language, position } = document('a = Odd()\nb = SaveImage(images = a["out|"])', schemas);
  items = language.completions(position);
  assert.equal(TextDocument.applyEdits(language.document, [items[0].textEdit]), 'a = Odd()\nb = SaveImage(images = a["output name"])');
});

test('signature help follows named inputs and positional order', () => {
  let data = document('x = CLIPTextEncode(clip = |');
  assert.equal(data.language.signatureHelp(data.position).activeParameter, 1);
  data = document('x = CLIPTextEncode("hello", |');
  assert.equal(data.language.signatureHelp(data.position).activeParameter, 1);
  const schemas = catalog(); delete schemas.CLIPTextEncode.input_order;
  data = document('x = CLIPTextEncode(|', schemas);
  assert.equal(data.language.signatureHelp(data.position).activeParameter, undefined);
});

test('definitions work without a catalog, including forward references and nested maps', () => {
  const dataWithoutCatalog = document('x = CLIPTextEncode(clip = check|point.CLIP)\ncheckpoint = CheckpointLoaderSimple("example.safetensors")');
  const { position } = dataWithoutCatalog;
  const language = new LanguageDocument(dataWithoutCatalog.language.document);
  assert.deepEqual(language.definition(position), { uri: language.document.uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } } });
  const data = document('x = Custom(settings = { value = check|point.CLIP })\ncheckpoint = CheckpointLoaderSimple("example.safetensors")');
  assert.equal(data.language.definition(data.position).range.start.line, 1);
});

test('completion replaces existing identifiers at token boundaries without duplicating punctuation', () => {
  let data = document('a = CheckpointLoaderSimple("example.safetensors")\nb = CLIPTextEncode(clip = a.|CLIP)');
  let item = data.language.completions(data.position).find(item => item.label === 'CLIP');
  assert.equal(TextDocument.applyEdits(data.language.document, [item.textEdit]), data.language.source);
  assert.equal(item.filterText, '.CLIP');
  data = document('x = CLIPTextEncode(cl|ip = checkpoint.CLIP)');
  item = data.language.completions(data.position).find(item => item.label === 'clip');
  assert.equal(TextDocument.applyEdits(data.language.document, [item.textEdit]), data.language.source);
});

test('hover explains node inputs and outputs, and named input types', () => {
  let data = document('x = CheckpointLo|aderSimple("example.safetensors")');
  assert.match(data.language.hover(data.position).contents.value, /CLIP: CLIP/);
  data = document('x = EmptyLatentImage(wid|th = 64, height = 64, batch_size = 1)');
  assert.match(data.language.hover(data.position).contents.value, /width: INT \(min 16, max 16384\)/);
});

test('comments and multiline prompts do not offer code completion', () => {
  assert.deepEqual(completions('// x = |'), []);
  assert.deepEqual(completions('x = """hello\nx = |\n"""'), []);
  assert.deepEqual(completions('x = CLIPTextEncode(// text = |'), []);
});

test('diagnostics retain compiler codes, related locations, and UTF-16 positions', () => {
  const { language } = document('a = CheckpointLoaderSimple("example.safetensors")\na = CLIPTextEncode("😀", clip = missing)');
  const duplicate = language.diagnostics().find(item => item.code === 'E_DUPLICATE_NODE');
  assert.equal(duplicate.relatedInformation[0].location.range.start.line, 0);
  const other = document('a = CLIPTextEncode("😀", clip = missing)');
  const missing = other.language.diagnostics().find(item => item.code === 'E_REFERENCE');
  assert.ok(missing);
  assert.equal(missing.range.start.character, other.language.source.indexOf('missing'));
});

test('incomplete dynamic maps retain selectors and offer only active children', () => {
  const schemas = { Choice: node({ mode: ['COMFY_DYNAMICCOMBO_V3', { options: [
    { key: 'off', inputs: {} }, { key: 'on', inputs: { required: { temperature: ['FLOAT'] } } },
  ] }] }, []) };
  const items = completions('x = Choice(mode = { mode = "on", |', schemas);
  assert.ok(items.some(item => item.label === 'temperature'));
  assert.ok(!items.some(item => item.label === 'mode'));
  assert.ok(!completions('x = Choice(mode = { mode = "off", |', schemas).some(item => item.label === 'temperature'));
});

test('dynamic map completion distinguishes nested children from literal dotted keys', () => {
  const dynamic = options => ['COMFY_DYNAMICCOMBO_V3', { options }];
  const schemas = { Choice: node({ mode: dynamic([{ key: 'on', inputs: { required: {
    'literal.key': ['STRING'], inner: dynamic([{ key: 'yes', inputs: { required: { count: ['INT'] } } }]),
  } } }]) }, []) };
  const source = 'x = Choice(mode = { mode = "on", inner = { inner = "yes", |';
  const items = completions(source, schemas);
  assert.ok(items.some(item => item.label === 'count'));
  assert.ok(!items.some(item => item.label === 'literal.key'));
  const outer = completions('x = Choice(mode = { mode = "on", |', schemas);
  assert.equal(outer.find(item => item.label === 'literal.key').textEdit.newText, '"literal.key" = ');
  assert.ok(!outer.some(item => item.label === 'inner.count'));
});
