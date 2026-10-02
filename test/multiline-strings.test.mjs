import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, parse } from '../dist/index.js';
import { node } from './fixtures/catalog.mjs';

const definitions = { Text: node({ value: ['STRING'] }, ['STRING']) };
test('triple-quoted strings preserve whitespace, quotes, slashes, comments and line endings', () => {
  for (const value of ['', 'hello', '\n  first\n  second\n', '"quoted" and ""two quotes""', String.raw`C:\new\test // literal`, 'first\r\nsecond', 'Unicode: café 🌄\tend']) {
    const result = compile(`x = Text("""${value}""")`, definitions);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.graph.x.inputs.value, value);
  }
});

test('ordinary JSON strings and raw strings remain distinct', () => {
  const result = compile('a = Text("line\\nnext")\nb = Text("""line\\nnext""")', definitions);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.graph.a.inputs.value, 'line\nnext');
  assert.equal(result.graph.b.inputs.value, 'line\\nnext');
  assert.equal(compile('a = Text("\\"\\"\\"")', definitions).graph.a.inputs.value, '"""');
});

test('source spans after multiline strings point to the correct line and column', () => {
  const result = compile('a = Text("""one\ntwo\nthree""")\nb = Text(42)', definitions);
  assert.equal(result.ok, false);
  const diagnostic = result.diagnostics.find(d => d.code === 'E_TYPE');
  assert.equal(diagnostic.span.start.line, 4);
  assert.equal(diagnostic.span.start.column, 10);
});

test('unterminated raw strings and raw strings in name positions are syntax errors', () => {
  const result = parse('x = Text("""open\ntext)');
  assert.equal(result.diagnostics[0].code, 'E_SYNTAX');
  assert.match(result.diagnostics[0].message, /Unterminated triple-quoted/);
  assert.equal(result.diagnostics[0].span.start.line, 1);
  assert.equal(result.diagnostics[0].span.end.line, 2);
  for (const source of ['x = """Text"""()', 'x = Text("""value""" = "x")']) {
    assert.equal(parse(source).diagnostics[0].code, 'E_SYNTAX');
  }
});
