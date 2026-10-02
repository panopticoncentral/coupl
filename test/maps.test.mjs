import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, parse } from '../dist/index.js';
import { node } from './fixtures/catalog.mjs';
import { DYNAMIC, MATCH, matchInput } from './fixtures/krea-catalog.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
function catalog() {
  const inner = [DYNAMIC, { options: [
    { key: 'go', inputs: { required: { count: ['INT'] } } },
    { key: 'stop', inputs: {} },
  ] }];
  return {
    Dynamic: node({
      mode: [DYNAMIC, { options: [
        { key: 'on', inputs: {
          required: { amount: ['FLOAT', { min: 0, max: 1 }] },
          optional: { text: ['STRING'], flag: ['BOOLEAN'], model: ['MODEL'], inner },
        } },
        { key: 'off', inputs: {} },
      ] }],
      tail: ['STRING'],
    }, ['MODEL']),
    Model: node({}, ['MODEL']), Text: node({}, ['STRING']), Any: node({ value: ['*'] }, []),
  };
}
function success(source, definitions = catalog()) {
  const result = compile(source, definitions);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result;
}
function failure(source, code, definitions = catalog()) {
  const result = compile(source, definitions);
  assert.equal(result.ok, false);
  assert.equal('graph' in result, false);
  const diagnostic = result.diagnostics.find(d => d.code === code);
  assert.ok(diagnostic, JSON.stringify(result.diagnostics));
  return diagnostic;
}

test('maps lower to flat API inputs without creating extra nodes or changing literal text', () => {
  const source = `x = Dynamic(
  mode = {
    amount = 0.7, // Selector order does not matter.
    "mode" = "on",
    flag = false,
    text = """Line one.
Line two.""",
  },
  tail = "done",
)`;
  const expected = {
    x: { class_type: 'Dynamic', inputs: {
      mode: 'on', 'mode.amount': 0.7, 'mode.flag': false, 'mode.text': 'Line one.\nLine two.', tail: 'done',
    } },
  };
  assert.deepEqual(plain(success(source).graph), expected);
  const dotted = 'x = Dynamic("on", "done", "mode.amount" = 0.7, "mode.flag" = false, "mode.text" = "Line one.\\nLine two.")';
  assert.deepEqual(plain(success(dotted).graph), expected);
});

test('positional maps preserve top-level input order and named maps need no order metadata', () => {
  assert.equal(success('x = Dynamic({mode = "on", amount = 0.7}, "tail")').graph.x.inputs.tail, 'tail');
  const definitions = catalog(); delete definitions.Dynamic.input_order;
  success('x = Dynamic(tail = "tail", mode = {mode = "on", amount = 0.7})', definitions);
  failure('x = Dynamic({mode = "off"}, "tail")', 'E_INPUT_ORDER', definitions);
});

test('nested maps and dotted arguments can be combined independently of source order', () => {
  const inputs = { mode: 'on', tail: 'tail', 'mode.amount': 0.7, 'mode.inner': 'go', 'mode.inner.count': 3 };
  for (const source of [
    'x = Dynamic(mode = {mode = "on", amount = 0.7, inner = {inner = "go", count = 3}}, tail = "tail")',
    'x = Dynamic("mode.inner" = {inner = "go", count = 3}, mode = {mode = "on", amount = 0.7}, tail = "tail")',
    'x = Dynamic("mode.inner.count" = 3, mode = {mode = "on", amount = 0.7, inner = "go"}, tail = "tail")',
    'x = Dynamic(mode = "on", "mode.inner" = {inner = "go", count = 3}, "mode.amount" = 0.7, tail = "tail")',
  ]) assert.deepEqual(plain(success(source).graph.x.inputs), inputs);
});

test('map selection is per instance and does not mutate the catalog', () => {
  const definitions = catalog(), before = structuredClone(definitions);
  const result = success('a = Dynamic({mode = "on", amount = 0.1}, "a")\nb = Dynamic({mode = "off"}, "b")', definitions);
  assert.deepEqual(plain(result.graph.b.inputs), { mode: 'off', tail: 'b' });
  assert.deepEqual(definitions, before);
});

test('map selectors, missing children, inactive/unknown fields and ranges are validated', () => {
  for (const [value, code] of [
    ['{}', 'E_REQUIRED'], ['{amount = 0.7}', 'E_REQUIRED'],
    ['{mode = "on"}', 'E_REQUIRED'], ['{mode = "invalid"}', 'E_ENUM'],
    ['{mode = true}', 'E_ENUM'], ['{mode = 1}', 'E_ENUM'],
    ['{mode = selector}', 'E_SCHEMA'], ['{mode = {mode = "on"}}', 'E_SCHEMA'],
    ['{mode = "off", amount = 0.7}', 'E_INPUT'],
    ['{mode = "on", amount = 0.7, typo = 1}', 'E_INPUT'],
    ['{mode = "on", amount = 2}', 'E_RANGE'],
    ['{mode = "on", amount = "bad"}', 'E_TYPE'],
    ['{mode = "on", amount = 0.7, inner = {inner = "go"}}', 'E_REQUIRED'],
    ['{mode = "on", amount = 0.7, inner = {inner = "stop", count = 1}}', 'E_INPUT'],
    ['{mode = "on", amount = 0.7, inner = {count = 1}}', 'E_REQUIRED'],
  ]) failure(`selector = Text()\nx = Dynamic(mode = ${value}, tail = "tail")`, code);
  const definitions = catalog();
  definitions.Dynamic.input.optional.mode = definitions.Dynamic.input.required.mode;
  delete definitions.Dynamic.input.required.mode;
  success('x = Dynamic(tail = "tail")', definitions);
  failure('x = Dynamic(tail = "tail", mode = {})', 'E_REQUIRED', definitions);
});

test('duplicate keys and mixed representations fail without last-value-wins behavior', () => {
  for (const source of [
    'x = Dynamic({mode = "on", "mode" = "off"}, "tail")',
    'x = Dynamic({mode = "on", amount = 1, "amount" = 0}, "tail")',
    'x = Dynamic({mode = "on", inner = {inner = "go", count = 1, count = 2}}, "tail")',
  ]) failure(source, 'E_DUPLICATE_KEY');
  for (const source of [
    'x = Dynamic(mode = {mode = "on", amount = 0.7}, "mode.amount" = 0.7, tail = "tail")',
    'x = Dynamic("mode.amount" = 0.7, mode = {mode = "on", amount = 0.7}, tail = "tail")',
    'x = Dynamic({mode = "off"}, "tail", mode = "off")',
    'x = Dynamic(mode = {mode = "on", amount = 0.7, inner = {inner = "go", count = 1}}, "mode.inner.count" = 1, tail = "tail")',
  ]) failure(source, 'E_DUPLICATE_INPUT');
});

test('references inside maps retain output checks, type inference, and cycle detection', () => {
  const result = success('x = Dynamic({mode = "on", amount = 0.7, model = m}, "tail")\nm = Model()');
  assert.deepEqual(plain(result.graph.x.inputs['mode.model']), ['m', 0]);
  failure('x = Dynamic({mode = "on", amount = 0.7, model = missing}, "tail")', 'E_REFERENCE');
  failure('x = Dynamic({mode = "on", amount = 0.7, model = t}, "tail")\nt = Text()', 'E_TYPE');
  failure('x = Dynamic({mode = "on", amount = 0.7, model = m[1]}, "tail")\nm = Model()', 'E_OUTPUT');
  failure('x = Dynamic({mode = "on", amount = 0.7, model = x}, "tail")', 'E_CYCLE');
  const definitions = catalog();
  definitions.Dynamic.input.required.mode[1].options[0].inputs.optional.model = matchInput('chosen');
  definitions.Dynamic.output = [MATCH];
  definitions.Dynamic.output_name = ['chosen'];
  definitions.Dynamic.output_matchtypes = ['chosen'];
  definitions.Sink = node({ input: ['MODEL'] }, []);
  success('sink = Sink(x)\nx = Dynamic({mode = "on", amount = 0.7, model = m}, "tail")\nm = Model()', definitions);
  failure('sink = Sink(x)\nx = Dynamic({mode = "on", amount = 0.7, model = t}, "tail")\nt = Text()', 'E_TYPE', definitions);
});

test('maps are not serialized into unsupported ordinary or wildcard inputs', () => {
  failure('x = Any({value = true})', 'E_MAP');
  failure('x = Dynamic({mode = "off"}, {tail = "bad"})', 'E_MAP');
  failure('x = Dynamic({mode = "on", amount = {amount = 0.7}}, "tail")', 'E_MAP');
  failure('x = Dynamic(mode = "off", "mode.inner" = {inner = "go", count = 1}, tail = "tail")', 'E_INPUT');
  failure('x = Dynamic(unknown = {unknown = "on"}, tail = "tail")', 'E_INPUT');
});

test('quoted and prototype-like field names use exact schema names', () => {
  const definitions = catalog();
  definitions.Dynamic.input.required.mode[1].options[0].inputs.optional = JSON.parse('{"__proto__":["STRING"],"constructor":["STRING"],"a.b":["STRING"]}');
  const inputs = success('x = Dynamic({mode = "on", amount = 0.7, __proto__ = "safe", constructor = "safe", "a.b" = "exact"}, "tail")', definitions).graph.x.inputs;
  assert.equal(inputs['mode.__proto__'], 'safe');
  assert.equal(inputs['mode.constructor'], 'safe');
  assert.equal(inputs['mode.a.b'], 'exact');
  // Local selector names may themselves contain punctuation; do not split them at dots.
  const weird = { Weird: node({ 'a.b': [DYNAMIC, { options: [{key: 'on', inputs: { required: {n: ['INT']} }}] }] }, []) };
  assert.deepEqual(plain(success('x = Weird("a.b" = {"a.b" = "on", n = 1})', weird).graph.x.inputs), { 'a.b': 'on', 'a.b.n': 1 });
});

test('selector-name collisions have a clear dotted-syntax fallback', () => {
  const definitions = catalog();
  definitions.Dynamic.input.required.mode[1].options[0].inputs.optional.mode = ['STRING'];
  failure('x = Dynamic({mode = "on", amount = 0.7}, "tail")', 'E_MAP', definitions);
  success('x = Dynamic("on", "tail", "mode.amount" = 0.7, "mode.mode" = "child")', definitions);
});

test('map diagnostics retain nested source locations', () => {
  const source = 'x = Dynamic(mode = {\n  mode = "on",\n  amount = 2,\n}, tail = "tail")';
  const diagnostic = failure(source, 'E_RANGE');
  assert.equal(diagnostic.span.start.line, 3);
  assert.equal(diagnostic.span.start.column, 12);
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  const map = parsed.declarations[0].args[0].value;
  assert.equal(map.kind, 'map');
  assert.deepEqual(map.entries.map(entry => entry.name), ['mode', 'amount']);
  assert.equal(map.span.end.line, 4);
});

test('map syntax requires named comma-separated entries and bounded nesting', () => {
  for (const source of [
    'x = {}', 'x = Dynamic({"on"}, "tail")', 'x = Dynamic({mode: "on"}, "tail")',
    'x = Dynamic({mode = "off" tail = 1}, "tail")', 'x = Dynamic({mode = "off", "tail")',
    'x = Dynamic({1 = "off"}, "tail")', 'x = Dynamic({mode = "on", amount = Model()}, "tail")',
    `x = Any(${'{x = '.repeat(33)}0${'}'.repeat(33)})`,
  ]) assert.equal(parse(source).diagnostics[0]?.code, 'E_SYNTAX', source);
  assert.deepEqual(parse(`x = Any(${'{x = '.repeat(32)}0${'}'.repeat(32)})`).diagnostics, []);
  assert.deepEqual(parse('x = Dynamic({\r\n mode = "off", // comment\r\n}, "tail")').diagnostics, []);
});
