import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, parse } from '../dist/index.js';
import { node } from './fixtures/catalog.mjs';
import { DYNAMIC, switchNode } from './fixtures/krea-catalog.mjs';

const definitions = {
  Source: node({}, ['MODEL'], { names: ['loaded model'] }),
  Pair: node({}, ['MODEL', 'STRING']),
  SameTypes: node({}, ['MODEL', 'MODEL']),
  Sink: node({ model: ['MODEL'] }, [], { outputNode: true }),
  Pass: node({ model: ['MODEL'] }, ['MODEL']),
  Text: node({ value: ['STRING'] }, ['STRING']),
  PrimitiveString: node({ value: ['STRING'] }, ['STRING']),
  Switch: switchNode(),
};
const plain = value => JSON.parse(JSON.stringify(value));
function success(source, catalog = definitions) {
  const result = compile(source, catalog);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result;
}
function failure(source, code, catalog = definitions) {
  const result = compile(source, catalog);
  assert.equal(result.ok, false);
  assert.equal('graph' in result, false);
  const diagnostic = result.diagnostics.find(d => d.code === code);
  assert.ok(diagnostic, JSON.stringify(result.diagnostics));
  return diagnostic;
}

test('bare, named and indexed references compile identically, including forward references', () => {
  const expected = success('sink = Sink(source[0])\nsource = Source()').graph;
  for (const reference of ['source', 'source[0]', 'source["loaded model"]']) {
    assert.deepEqual(plain(success(`sink = Sink(model = ${reference})\nsource = Source()`).graph), plain(expected));
  }
  assert.deepEqual(plain(success('prompt = "hi"\ncopy = Text(prompt)').graph.copy.inputs), { value: ['prompt', 0] });
});

test('zero and multiple outputs require unambiguous selection regardless of type matching', () => {
  for (const classType of ['Pair', 'SameTypes']) {
    const diagnostic = failure(`source = ${classType}()\nsink = Sink(source)`, 'E_OUTPUT');
    assert.match(diagnostic.message, /2 outputs; select one explicitly/);
    assert.equal(diagnostic.span.start.line, 2);
    assert.equal(diagnostic.span.start.column, 13);
    assert.equal(diagnostic.related[0].span.start.line, 1);
    success(`source = ${classType}()\nsink = Sink(source[0])`);
  }
  const diagnostic = failure('source = Source()\nsink = Sink(source)\nbad = Sink(sink)', 'E_OUTPUT');
  assert.match(diagnostic.message, /no outputs/);
});

test('bare references preserve unknown-node, type, explicit-output and schema diagnostics', () => {
  failure('sink = Sink(missing)', 'E_REFERENCE');
  failure('source = Text("hi")\nsink = Sink(source)', 'E_TYPE');
  failure('source = Source()\nsink = Sink(source.missing)', 'E_OUTPUT');
  failure('source = Source()\nsink = Sink(source[1])', 'E_OUTPUT');
  failure('source = Broken()\nsink = Sink(source)', 'E_SCHEMA', { ...definitions, Broken: {} });
});

test('bare references participate in cycle detection and MatchType inference', () => {
  failure('a = Pass(b)\nb = Pass(a)', 'E_CYCLE');
  failure('a = Pass(a)', 'E_CYCLE');
  success('sink = Sink(selected)\nselected = Switch(true, on_true = source)\nsource = Source()');
  failure('sink = Sink(selected)\nselected = Switch(true, on_true = text)\ntext = "hello"', 'E_TYPE');
});

test('bare primitive references remain connections rather than enum or dynamic-selector literals', () => {
  const catalog = {
    ...definitions,
    Enum: node({ mode: [['on', 'off']] }, []),
    Dynamic: node({ mode: [DYNAMIC, { options: [{ key: 'on', inputs: {} }] }] }, []),
  };
  for (const classType of ['Enum', 'Dynamic']) failure(`mode = "on"\nselected = ${classType}(mode)`, 'E_SCHEMA', catalog);
});

test('parser leaves bare selectors unresolved until a catalog is available', () => {
  const parsed = parse('sink = Sink(source)');
  assert.deepEqual(parsed.diagnostics, []);
  const value = parsed.declarations[0].args[0].value;
  assert.equal(value.kind, 'reference');
  assert.equal(value.node, 'source');
  assert.equal(value.output, undefined);
  assert.equal(value.span.end.offset - value.span.start.offset, 'source'.length);
  for (const source of ['sink = Sink(source extra)', 'sink = Sink(Source())']) {
    assert.equal(parse(source).diagnostics[0].code, 'E_SYNTAX');
  }
});
