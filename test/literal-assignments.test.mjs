import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, parse } from '../dist/index.js';
import { node } from './fixtures/catalog.mjs';

// Primitive node contracts: ComfyUI/comfy_extras/nodes_primitive.py.
const definitions = {
  PrimitiveBoolean: node({ value: ['BOOLEAN'] }, ['BOOLEAN']),
  PrimitiveString: node({ value: ['STRING'] }, ['STRING']),
  PrimitiveStringMultiline: node({ value: ['STRING'] }, ['STRING']),
  Sink: node({ enabled: ['BOOLEAN'], text: ['STRING'], long_text: ['STRING'] }, [], { outputNode: true }),
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

test('boolean and string assignments lower to the same graph as explicit primitive calls', () => {
  const implicit = 'flag = false\ntext = "hello"\nprompt = """first\nsecond"""\nsink = Sink(flag[0], text.STRING, prompt[0])';
  const explicit = 'flag = PrimitiveBoolean(value = false)\ntext = PrimitiveString(value = "hello")\nprompt = PrimitiveStringMultiline(value = "first\\nsecond")\nsink = Sink(flag[0], text.STRING, prompt[0])';
  assert.deepEqual(plain(success(implicit).graph), plain(success(explicit).graph));
  assert.deepEqual(success(implicit).diagnostics, []);
  assert.equal(success('flag = true').graph.flag.inputs.value, true);
});

test('quote syntax determines the string node class while text is preserved exactly', () => {
  const result = success('empty = ""\nraw_empty = """"""\nescaped = "first\\nsecond"\nraw = """C:\\new\\test // literal\r\n  \\"quoted""""');
  assert.equal(result.graph.empty.class_type, 'PrimitiveString');
  assert.equal(result.graph.raw_empty.class_type, 'PrimitiveStringMultiline');
  assert.equal(result.graph.raw_empty.inputs.value, '');
  assert.equal(result.graph.escaped.class_type, 'PrimitiveString');
  assert.equal(result.graph.escaped.inputs.value, 'first\nsecond');
  assert.equal(result.graph.raw.class_type, 'PrimitiveStringMultiline');
  assert.equal(result.graph.raw.inputs.value, 'C:\\new\\test // literal\r\n  \\"quoted"');
});

test('literal nodes allow forward references and retain normal output/type checks', () => {
  success('sink = Sink(flag.BOOLEAN, text[0], prompt.STRING)\nflag = true\ntext = "hi"\nprompt = """long\ntext"""');
  failure('flag = false\nsink = Sink(flag[0], flag[0], "text")', 'E_TYPE');
  failure('flag = true\nsink = Sink(flag[1], "x", "y")', 'E_OUTPUT');
  success('flag = true\nsink = Sink(flag, "x", "y")');
});

test('inline values remain inline and do not require primitive classes', () => {
  const result = success('sink = Sink(false, "hi", """long\nprompt""")', { Sink: definitions.Sink });
  assert.deepEqual(plain(result.graph), {
    sink: { class_type: 'Sink', inputs: { enabled: false, text: 'hi', long_text: 'long\nprompt' } },
  });
});

test('lowered nodes use the real catalog and report errors at the literal', () => {
  const diagnostic = failure('// control\nflag = true', 'E_NODE_CLASS', { Sink: definitions.Sink });
  assert.match(diagnostic.message, /PrimitiveBoolean/);
  assert.equal(diagnostic.span.start.line, 2);
  assert.equal(diagnostic.span.start.column, 8);
  failure('text = "hi"', 'E_TYPE', { PrimitiveString: node({ value: ['INT'] }, ['STRING']) });
  failure('flag = true', 'E_REQUIRED', { PrimitiveBoolean: node({ value: ['BOOLEAN'], extra: ['INT'] }, ['BOOLEAN']) });
  const unordered = structuredClone(definitions); delete unordered.PrimitiveBoolean.input_order;
  success('flag = true', unordered); // Lowering supplies the named value input.
});

test('literal declarations participate in duplicate-name and newline checks', () => {
  failure('flag = true\nflag = PrimitiveBoolean(false)', 'E_DUPLICATE_NODE');
  failure('flag = PrimitiveBoolean(false)\nflag = true', 'E_DUPLICATE_NODE');
  for (const source of ['flag = true other = false', 'x = "a" y = "b"', 'true = false']) failure(source, 'E_SYNTAX');
  assert.equal(success('flag = false // comment\r\ntext = "hi"\r\n').graph.text.inputs.value, 'hi');
});

test('quoted class calls remain unambiguous and aliases/numeric declarations stay unsupported', () => {
  const defs = { ...definitions, 'Vendor: Node': node({}, ['STRING']) };
  assert.equal(success('n = "Vendor: Node"()', defs).graph.n.class_type, 'Vendor: Node');
  assert.equal(success('n = "Vendor: Node"', defs).graph.n.class_type, 'PrimitiveString');
  for (const source of ['n = 42', 'n = 1.5', 'n = null', 'flag = true\nalias = flag', 'flag = true\nalias = flag[0]']) {
    failure(source, 'E_SYNTAX');
  }
});

test('parser retains literal declarations and source spans before compiler lowering', () => {
  const result = parse('flag = false\ntext = "hello"\nprompt = """one\ntwo"""');
  assert.deepEqual(result.diagnostics, []);
  const [flag, text, prompt] = result.declarations;
  assert.equal(flag.value.value, false);
  assert.equal(text.value.value, 'hello');
  assert.equal(prompt.value.value, 'one\ntwo');
  assert.equal(prompt.value.raw, '"""one\ntwo"""');
  assert.equal('classType' in flag, false);
  assert.equal(prompt.span.start.line, 3);
  assert.equal(prompt.span.end.line, 4);
});
