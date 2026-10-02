import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compile, formatDiagnostic, parse } from "../dist/index.js";
import { catalog, node } from "./fixtures/catalog.mjs";

const example = await readFile(new URL("../examples/text-to-image.coupl", import.meta.url), "utf8");
const expected = JSON.parse(await readFile(new URL("../examples/text-to-image.api.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const checkpoint = 'checkpoint = CheckpointLoaderSimple("example.safetensors")\n';

function success(source, definitions = catalog()) {
  const result = compile(source, definitions);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result;
}

function failure(source, code, definitions = catalog()) {
  const result = compile(source, definitions);
  assert.equal(result.ok, false);
  assert.equal("graph" in result, false, "Failed compilation must not expose partial JSON");
  const diagnostic = result.diagnostics.find(d => d.code === code);
  assert.ok(diagnostic, JSON.stringify(result.diagnostics));
  assert.ok(diagnostic.span.start.line >= 1);
  assert.ok(diagnostic.span.start.column >= 1);
  return diagnostic;
}

test("worked graph matches independently authored API JSON", () => {
  const result = success(example);
  assert.deepEqual(plain(result.graph), expected);
  assert.deepEqual(result.diagnostics, []);
});

test("positional, named, reordered named, and mixed calls are equivalent", () => {
  const sources = [
    'positive = CLIPTextEncode("A landscape", checkpoint.CLIP)',
    'positive = CLIPTextEncode(text = "A landscape", clip = checkpoint.CLIP)',
    'positive = CLIPTextEncode(clip = checkpoint.CLIP, text = "A landscape")',
    'positive = CLIPTextEncode("A landscape", clip = checkpoint.CLIP)',
  ];
  const graphs = sources.map(source => plain(success(checkpoint + source).graph));
  for (const graph of graphs) assert.deepEqual(graph, graphs[0]);
});

test("positional binding follows metadata, not object key order", () => {
  const definitions = catalog();
  definitions.CLIPTextEncode.input_order.required = ["clip", "text"];
  const result = success(checkpoint + 'positive = CLIPTextEncode(checkpoint.CLIP, "A landscape")', definitions);
  assert.equal(result.graph.positive.inputs.text, "A landscape");
  assert.deepEqual(result.graph.positive.inputs.clip, ["checkpoint", 1]);
});

test("required then optional positions exclude hidden inputs", () => {
  const definitions = { Custom: node({ first: ["INT"] }, [], { optional: { second: ["BOOLEAN"] }, hidden: { id: "UNIQUE_ID" }, outputNode: true }) };
  assert.deepEqual(plain(success("x = Custom(1, true)", definitions).graph.x.inputs), { first: 1, second: true });
  assert.deepEqual(plain(success("x = Custom(1)", definitions).graph.x.inputs), { first: 1 });
  failure("x = Custom(1, true, 3)", "E_ARGUMENT_COUNT", definitions);
  failure('x = Custom(1, id = "x")', "E_INPUT", definitions);
});

test("missing or malformed input_order permits named calls only", () => {
  for (const order of [undefined, { required: ["text", "text"] }, { required: ["clip"] }]) {
    const definitions = catalog();
    definitions.CLIPTextEncode.input_order = order;
    failure(checkpoint + 'p = CLIPTextEncode("hi", checkpoint.CLIP)', "E_INPUT_ORDER", definitions);
    success(checkpoint + 'p = CLIPTextEncode(text = "hi", clip = checkpoint.CLIP)', definitions);
  }
});

test("forward references resolve and declarations retain their API IDs", () => {
  const result = success('positive = CLIPTextEncode("hi", checkpoint.CLIP)\n' + checkpoint);
  assert.deepEqual(result.graph.positive.inputs.clip, ["checkpoint", 1]);
});

test("output names and indices resolve the same port", () => {
  for (const selector of [".CLIP", "[1]", '["CLIP"]']) {
    assert.deepEqual(success(checkpoint + `p = CLIPTextEncode("hi", checkpoint${selector})`).graph.p.inputs.clip, ["checkpoint", 1]);
  }
});

test("quoted classes/inputs/outputs and duplicate output names", () => {
  const definitions = {
    "Vendor: Source": node({}, ["CUSTOM", "CUSTOM"], { names: ["output name", "output name"] }),
    "Vendor: Sink": node({ "input value": ["CUSTOM"] }, [], { outputNode: true }),
  };
  const source = 'a = "Vendor: Source"()\nb = "Vendor: Sink"("input value" = a[1])';
  assert.deepEqual(success(source, definitions).graph.b.inputs["input value"], ["a", 1]);
  failure(source.replace("a[1]", 'a["output name"]'), "E_OUTPUT", definitions);
  definitions["Vendor: Source"].output_name = ["first", "output name"];
  success(source.replace("a[1]", 'a["output name"]'), definitions);
});

test("prototype-like names are ordinary node and input names", () => {
  const definitions = JSON.parse('{"__proto__":{"input":{"required":{"__proto__":["STRING"]}},"output":[],"output_node":true}}');
  const result = success('__proto__ = __proto__(__proto__ = "safe")', definitions);
  assert.equal(plain(result.graph).__proto__.inputs.__proto__, "safe");
});

test("multiline calls, trailing commas, comments, escaped strings and CRLF", () => {
  const source = '// hello\r\nx = Text(\r\n "https://example.test/\\n\\"quoted\\"", // comment\r\n)\r\n';
  const result = success(source, { Text: node({ text: ["STRING"] }, [], { outputNode: true }) });
  assert.equal(result.graph.x.inputs.text, 'https://example.test/\n"quoted"');
});

test("numeric and boolean literals retain intended values", () => {
  const definitions = { Values: node({ i: ["INT"], f: ["FLOAT"], b: ["BOOLEAN"] }, [], { outputNode: true }) };
  assert.deepEqual(plain(success("x = Values(-2e2, 1.25e-2, false)", definitions).graph.x.inputs), { i: -200, f: 0.0125, b: false });
  failure("x = Values(1.00000000000000001, 1, true)", "E_TYPE", definitions);
  failure("x = Values(1e-999, 1, true)", "E_NUMBER", definitions);
});

test("unsafe integers and nonfinite values fail before rounding can reach JSON", () => {
  for (const literal of ["9007199254740992", "9007199254740993", "18446744073709551615", "1e309", "-9007199254740993"]) {
    failure(`x = Anything(${literal})`, "E_NUMBER");
  }
});

test("cycles, including disconnected cycles and self-links, fail", () => {
  const definitions = { Pass: node({ value: ["CUSTOM"] }, ["CUSTOM"]), Done: node({}, [], { outputNode: true }) };
  failure("a = Pass(a.CUSTOM)", "E_CYCLE", definitions);
  failure("a = Pass(b.CUSTOM)\nb = Pass(a.CUSTOM)\nc = Done()", "E_CYCLE", definitions);
});

test("long acyclic graphs do not depend on the JS recursion limit", () => {
  const definitions = { Source: node({}, ["CUSTOM"]), Pass: node({ value: ["CUSTOM"] }, ["CUSTOM"]) };
  const source = Array.from({ length: 3000 }, (_, i) => `n${i} = Pass(n${i + 1}.CUSTOM)`).join("\n") + "\nn3000 = Source()";
  assert.equal(Object.keys(success(source, definitions).graph).length, 3001);
});

test("empty source fails and a fragment produces an output warning", () => {
  failure("// empty", "E_EMPTY");
  assert.deepEqual(success(checkpoint).diagnostics.map(d => d.code), ["W_NO_OUTPUT"]);
});

test("diagnostics identify the source and referenced declaration", () => {
  const source = checkpoint + 'p = CLIPTextEncode("hi", checkpoint.VAE)';
  const diagnostic = failure(source, "E_TYPE");
  assert.equal(diagnostic.span.start.line, 2);
  assert.equal(diagnostic.span.start.column, 26);
  assert.equal(diagnostic.related[0].span.start.line, 1);
  const rendered = formatDiagnostic(diagnostic, source, "graph.coupl");
  assert.match(rendered, /graph\.coupl:2:26: error E_TYPE/);
  assert.match(rendered, /expected CLIP.*supplies VAE/);
  assert.match(rendered, /\^/);
});

for (const [name, source, code] of [
  ["positional after named", 'p = CLIPTextEncode(text = "hi", checkpoint.CLIP)', "E_ARGUMENT_ORDER"],
  ["duplicate positional/named", 'p = CLIPTextEncode("hi", text = "again", clip = checkpoint.CLIP)', "E_DUPLICATE_INPUT"],
  ["duplicate named", 'p = CLIPTextEncode(text = "hi", text = "again", clip = checkpoint.CLIP)', "E_DUPLICATE_INPUT"],
  ["excess positional", 'p = CLIPTextEncode("hi", checkpoint.CLIP, 1)', "E_ARGUMENT_COUNT"],
  ["missing required", 'p = CLIPTextEncode("hi")', "E_REQUIRED"],
  ["unknown input", 'p = CLIPTextEncode(text = "hi", clip = checkpoint.CLIP, typo = 1)', "E_INPUT"],
  ["unknown class", 'p = Missing()', "E_NODE_CLASS"],
  ["unknown reference", 'p = CLIPTextEncode("hi", absent.CLIP)', "E_REFERENCE"],
  ["unknown output name", 'p = CLIPTextEncode("hi", checkpoint.clip)', "E_OUTPUT"],
  ["out of range output", 'p = CLIPTextEncode("hi", checkpoint[3])', "E_OUTPUT"],
  ["invalid output index", 'p = CLIPTextEncode("hi", checkpoint[-1])', "E_OUTPUT"],
  ["wrong literal type", 'p = CLIPTextEncode(42, checkpoint.CLIP)', "E_TYPE"],
  ["literal for opaque type", 'p = CLIPTextEncode("hi", "CLIP")', "E_TYPE"],
  ["unavailable model", 'p = CheckpointLoaderSimple("missing.safetensors")', "E_ENUM"],
  ["bounds", 'p = EmptyLatentImage(1, 512, 1)', "E_RANGE"],
  ["fractional integer", 'p = EmptyLatentImage(512.5, 512, 1)', "E_TYPE"],
  ["duplicate node", 'checkpoint = CheckpointLoaderSimple("example.safetensors")', "E_DUPLICATE_NODE"],
  ["missing comma", 'p = CLIPTextEncode("hi" checkpoint.CLIP)', "E_SYNTAX"],
  ["bare multi-output node", 'p = CLIPTextEncode("hi", checkpoint)', "E_OUTPUT"],
  ["unclosed call", 'p = CLIPTextEncode(', "E_SYNTAX"],
  ["unclosed string", 'p = CLIPTextEncode("hi)', "E_SYNTAX"],
  ["invalid escape", 'p = CLIPTextEncode("\\x")', "E_SYNTAX"],
  ["assignments need newline", 'p = CheckpointLoaderSimple("example.safetensors") q = Missing()', "E_SYNTAX"],
]) {
  test(`rejects ${name}`, () => { failure(checkpoint + source, code); });
}

test("malformed catalogs and unsupported schemas are diagnosed", () => {
  for (const definitions of [null, [], {}, "bad"]) failure(checkpoint, "E_CATALOG", definitions);
  for (const schema of [null, {}, { input: { required: null }, output: [] }, node({ value: ["STRING", null] }, []), { ...node({}, []), output_name: null }, node({ value: ["INT,FLOAT"] }, []), node({ value: [{ dynamic: true }] }, [])]) {
    failure("x = Custom()", "E_SCHEMA", { Custom: schema });
  }
  const definitions = catalog(); definitions.Unused = { strange: true };
  success(example, definitions);
});

test("combo option forms and unavailable enum connections are explicit", () => {
  const definitions = { Select: node({ choice: ["COMBO", { options: ["a", "b"] }] }, []), Source: node({}, ["STRING"]) };
  success('x = Select("b")', definitions);
  failure('s = Source()\nx = Select(s.STRING)', "E_SCHEMA", definitions);
});

test("parser is independently usable for editor diagnostics", () => {
  const result = parse(example);
  assert.equal(result.declarations.length, 7);
  assert.deepEqual(result.diagnostics, []);
});
