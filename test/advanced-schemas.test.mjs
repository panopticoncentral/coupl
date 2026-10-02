import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compile, parse } from '../dist/index.js';
import { node } from './fixtures/catalog.mjs';
import { DYNAMIC, MATCH, kreaCatalog, matchInput, switchNode } from './fixtures/krea-catalog.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
function success(source, catalog) {
  const result = compile(source, catalog);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result;
}
function failure(source, catalog, code) {
  const result = compile(source, catalog);
  assert.equal(result.ok, false);
  assert.equal('graph' in result, false);
  const diagnostic = result.diagnostics.find(d => d.code === code);
  assert.ok(diagnostic, JSON.stringify(result.diagnostics));
  return diagnostic;
}

const dynamic = () => ({
  Dynamic: node({ mode: [DYNAMIC, { options: [
    { key: 'on', inputs: { required: { amount: ['FLOAT', { min: 0, max: 1 }] }, optional: { seed: ['INT'] } } },
    { key: 'off', inputs: { required: {} } },
  ] }], tail: ['STRING'] }, ['STRING'], { optional: { enabled: ['BOOLEAN'] } }),
  Text: node({ text: ['STRING'] }, ['STRING']),
});

test('dynamic inputs select per instance and preserve flat API keys', () => {
  const definitions = dynamic();
  const original = structuredClone(definitions);
  const result = success('a = Dynamic("on", "tail", "mode.amount" = 0.7, "mode.seed" = 42)\nb = Dynamic(mode = "off", tail = "second")', definitions);
  assert.deepEqual(plain(result.graph.a.inputs), { mode: 'on', tail: 'tail', 'mode.amount': 0.7, 'mode.seed': 42 });
  assert.deepEqual(plain(result.graph.b.inputs), { mode: 'off', tail: 'second' });
  assert.deepEqual(definitions, original, 'catalog must not be mutated');
});

test('dynamic children are named; top-level positional order remains stable', () => {
  const result = success('a = Dynamic("on", "tail", true, "mode.amount" = 0.2)', dynamic());
  assert.equal(result.graph.a.inputs.enabled, true);
  failure('a = Dynamic("on", "tail", true, 0.2)', dynamic(), 'E_ARGUMENT_COUNT');
  const defs = dynamic(); delete defs.Dynamic.input_order;
  success('a = Dynamic("mode.amount" = 0.2, tail = "tail", mode = "on")', defs);
  failure('a = Dynamic("off", "tail")', defs, 'E_INPUT_ORDER');
});

test('dynamic selectors, required children, inactive inputs, duplicates and ranges are checked', () => {
  for (const [source, code] of [
    ['a = Dynamic(mode = "on", tail = "x")', 'E_REQUIRED'],
    ['a = Dynamic(mode = "off", tail = "x", "mode.amount" = 1)', 'E_INPUT'],
    ['a = Dynamic(mode = "missing", tail = "x")', 'E_ENUM'],
    ['a = Dynamic(tail = "x")', 'E_REQUIRED'],
    ['a = Dynamic(mode = "on", tail = "x", "mode.amount" = 2)', 'E_RANGE'],
    ['a = Dynamic(mode = "on", tail = "x", "mode.amount" = "bad")', 'E_TYPE'],
    ['a = Dynamic(mode = "on", tail = "x", "mode.amount" = 1, "mode.amount" = 0)', 'E_DUPLICATE_INPUT'],
    ['a = Dynamic("on", "x", mode = "off", "mode.amount" = 1)', 'E_DUPLICATE_INPUT'],
    ['a = Dynamic(mode = t[0], tail = "x")\nt = Text("on")', 'E_SCHEMA'],
  ]) failure(source, dynamic(), code);
});

test('nested and optional dynamic choices activate only selected children', () => {
  const definitions = { Nested: node({}, [], { optional: {
    outer: [DYNAMIC, { options: [
      { key: 'a', inputs: { required: { inner: [DYNAMIC, { options: [
        { key: 'b', inputs: { required: { value: ['INT'] } } },
      ] }] } } },
    ] }],
  } }) };
  success('n = Nested()', definitions);
  const source = 'n = Nested(outer = "a", "outer.inner" = "b", "outer.inner.value" = 3)';
  assert.equal(success(source, definitions).graph.n.inputs['outer.inner.value'], 3);
  failure('n = Nested(outer = "a")', definitions, 'E_REQUIRED');
  failure('n = Nested("outer.inner.value" = 3)', definitions, 'E_INPUT');
});

test('malformed dynamic metadata and flattened name collisions fail explicitly', () => {
  for (const options of [undefined, {}, [{ key: 'on' }], [{ key: 1, inputs: {} }], [{ key: 'on', inputs: {} }, { key: 'on', inputs: {} }], [{ key: 'on', inputs: { required: { n: ['FLOAT', { min: 'bad' }] } } }]]) {
    failure('n = Broken(mode = "on")', { Broken: node({ mode: [DYNAMIC, { options }] }, []) }, 'E_SCHEMA');
  }
  const defs = dynamic();
  defs.Dynamic.input.required['mode.amount'] = ['STRING'];
  failure('n = Dynamic(mode = "on", tail = "x")', defs, 'E_SCHEMA');
  for (const type of ['COMFY_AUTOGROW_V3', 'COMFY_DYNAMICSLOT_V3', 'INT,FLOAT', 'bad*']) {
    failure('n = Broken()', { Broken: node({ value: [type] }, []) }, 'E_SCHEMA');
  }
});

const flex = () => ({
  Switch: switchNode(),
  Model: node({}, ['MODEL']), Text: node({ text: ['STRING'] }, ['STRING']),
  Any: node({}, ['*']), Preview: node({ source: ['*'] }, ['STRING'], { outputNode: true }),
  UseModel: node({ model: ['MODEL'] }, []), UseText: node({ text: ['STRING'] }, []),
});

test('wildcards accept primitive literals and typed connections without weakening fixed checks', () => {
  const defs = flex();
  for (const value of ['"text"', '42', '0.5', 'true', 'm[0]']) success(`m = Model()\np = Preview(${value})`, defs);
  success('a = Any()\nu = UseModel(a[0])', defs);
  failure('m = Model()\nu = UseText(m[0])', defs, 'E_TYPE');
  failure('p = Preview(missing[0])', defs, 'E_REFERENCE');
  failure('a = Any()\np = Preview(a[1])', defs, 'E_OUTPUT');
});

test('MatchType follows branches and templates are scoped per instance', () => {
  const result = success(`
image_model = Model()
text = Text("hello")
m = Switch(true, on_false = image_model[0], on_true = image_model[0])
s = Switch(false, on_false = text[0], on_true = "world")
use_model = UseModel(m.output)
use_text = UseText(s[0])
`, flex());
  assert.deepEqual(plain(result.graph.use_model.inputs.model), ['m', 0]);
});

test('MatchType rejects mixed branches and incompatible consumers in either declaration order', () => {
  const declarations = ['m = Model()', 't = Text("hi")', 's = Switch(true, on_false = m[0], on_true = t[0])'];
  failure(declarations.join('\n'), flex(), 'E_TYPE');
  failure(declarations.toReversed().join('\n'), flex(), 'E_TYPE');
  for (const declarations of [
    ['m = Model()', 's = Switch(true, on_true = m[0])', 'u = UseText(s[0])'],
    ['s = Switch(true)', 'm = UseModel(s[0])', 't = UseText(s[0])'],
  ]) {
    failure(declarations.join('\n'), flex(), 'E_TYPE');
    failure(declarations.toReversed().join('\n'), flex(), 'E_TYPE');
  }
});

test('MatchType constraints propagate through connected switches with forward references', () => {
  const declarations = ['m = Model()', 'a = Switch(true, on_true = m[0])', 'b = Switch(false, on_false = a[0])', 'u = UseModel(b[0])'];
  success(declarations.toReversed().join('\n'), flex());
  failure(declarations.toReversed().join('\n').replace('UseModel(b', 'UseText(b'), flex(), 'E_TYPE');
  // A wildcard supplies no evidence and must not erase evidence from another branch.
  failure('a = Any()\nm = Model()\ns = Switch(true, on_false = a[0], on_true = m[0])\nu = UseText(s[0])', flex(), 'E_TYPE');
});

test('MatchType restrictions, literal inference, and separate template groups', () => {
  const defs = { ...flex(), Switch: switchNode('INT,FLOAT'), Float: node({ value: ['FLOAT'] }, []) };
  success('s = Switch(true, on_false = 1, on_true = 1.5)\nf = Float(s[0])', defs);
  success('f = Float(s[0])\ns = Switch(true, on_false = 1, on_true = 1.5)', defs);
  failure('s = Switch(true, on_true = "text")', defs, 'E_TYPE');
  failure('m = Model()\ns = Switch(true, on_true = m[0])', defs, 'E_TYPE');
  const pair = { ...node({ a: matchInput('a'), b: matchInput('b') }, [MATCH, MATCH]), output_matchtypes: ['a', 'b'] };
  success('m = Model()\np = Pair(a = m[0], b = "hello")\nu = UseModel(p[0])\nt = UseText(p[1])', { ...flex(), Pair: pair });
});

test('malformed MatchType metadata cannot silently turn into wildcard ports', () => {
  const cases = [
    { ...switchNode(), output_matchtypes: undefined },
    { ...switchNode(), output_matchtypes: ['missing'] },
    { ...switchNode(), output_matchtypes: [] },
    { ...node({}, ['STRING']), output_matchtypes: ['switch'] },
    node({ value: [MATCH] }, []),
    node({ value: [MATCH, { template: { template_id: 'x', allowed_types: '' } }] }, []),
    node({ a: matchInput('x', 'MODEL'), b: matchInput('x', 'STRING') }, []),
  ];
  for (const schema of cases) failure('n = Broken()', { Broken: schema }, 'E_SCHEMA');
});

test('MatchType cycles fail and long chains avoid recursive type resolution', () => {
  failure('a = Switch(true, on_true = b[0])\nb = Switch(true, on_true = a[0])', flex(), 'E_CYCLE');
  const source = Array.from({ length: 3000 }, (_, i) => `n${i} = Switch(true, on_true = n${i + 1}[0])`).join('\n') + '\nn3000 = Model()\nu = UseModel(n0[0])';
  success(source, flex());
  failure(source.replace('UseModel(n0', 'UseText(n0'), flex(), 'E_TYPE');
});

test('Krea example compiles to the original API graph with IDs renamed', async () => {
  const source = await readFile(new URL('../examples/krea-2-turbo.coupl', import.meta.url), 'utf8');
  const original = JSON.parse(await readFile(new URL('./fixtures/krea-2-turbo.api.json', import.meta.url), 'utf8'));
  const names = {
    '71:51': 'positive', '71:52': 'latent', '71:53': 'sample', '71:54': 'decoded',
    '71:55': 'base_model', '71:56': 'clip', '71:57': 'vae', '71:58': 'negative',
    '71:59': 'lora_model', '71:60': 'refined_prompt', '71:61': 'refinement_input',
    '71:62': 'system_prompt', '71:63': 'user_prompt', '71:64': 'prompt_preview',
    '71:65': 'selected_prompt', '71:66': 'model', '71:67': 'enable_lora',
    '71:68': 'refine_prompt', '71:69': 'lora_prompt', '71:70': 'final_prompt',
  };
  const expected = Object.fromEntries(Object.entries(original).map(([id, entry]) => [names[id], {
    class_type: entry.class_type,
    inputs: Object.fromEntries(Object.entries(entry.inputs).map(([name, value]) => [name, Array.isArray(value) ? [names[value[0]], value[1]] : value])),
  }]));
  const result = success(source, kreaCatalog());
  assert.deepEqual(plain(result.graph), expected);
  assert.deepEqual(result.diagnostics, []);
  const legacyCatalog = kreaCatalog();
  legacyCatalog.TextGenerate.output = ['STRING'];
  legacyCatalog.TextGenerate.output_name = ['generated_text'];
  assert.deepEqual(plain(success(source, legacyCatalog).graph), expected);
  const withSave = success(source.replace('// save =', 'save ='), kreaCatalog());
  assert.deepEqual(plain(withSave.graph.save.inputs), { images: ['decoded', 0], filename_prefix: 'Krea-2-Turbo' });
  assert.deepEqual(parse(source).diagnostics, []);
});
