import { isRecord, readNodeSchema, SchemaError } from "./catalog.js";
import type { InputSchema, NodeSchema } from "./catalog.js";
import { bindInputs } from "./binding.js";
import type { BoundInputs } from "./binding.js";
import { parse } from "./parser.js";
import { connectTypes, constrainTypes, describeType, TypeVariable } from "./type-constraints.js";
import type { PortType } from "./type-constraints.js";
import type { ApiGraph, ApiValue, CompileResult, Declaration, Diagnostic, Literal, NodeDeclaration, Reference, Span } from "./types.js";

const origin: Span = { start: { offset: 0, line: 1, column: 1 }, end: { offset: 0, line: 1, column: 1 } };

/** Literal assignments construct named nodes; literals inside calls stay inline. */
function lowerDeclaration(declaration: Declaration): NodeDeclaration {
  if (!("value" in declaration)) return declaration;
  const { value } = declaration;
  const classType = typeof value.value === "boolean" ? "PrimitiveBoolean"
    : value.raw.startsWith('"""') ? "PrimitiveStringMultiline" : "PrimitiveString";
  return {
    name: declaration.name, classType, classSpan: value.span,
    args: [{ name: "value", value, span: value.span }], span: declaration.span,
  };
}

// Determine integrality from decimal text, before binary floating-point rounding.
function integerLiteral(raw: string): boolean {
  const [mantissa = "", exponent = "0"] = raw.toLowerCase().split("e");
  const [whole = "", fraction = ""] = mantissa.replace(/^-/, "").split(".");
  const digits = whole + fraction;
  if (/^0+$/.test(digits)) return true;
  const decimalPlaces = fraction.length - Number(exponent);
  return decimalPlaces <= 0 || (decimalPlaces <= digits.length && /^0+$/.test(digits.slice(-decimalPlaces)));
}

export function compile(source: string, catalog: unknown): CompileResult {
  const parsed = parse(source);
  const diagnostics = parsed.diagnostics;
  const error = (code: string, message: string, span: Span, related?: Diagnostic["related"]) => {
    const diagnostic: Diagnostic = { severity: "error", code, message, span };
    if (related) diagnostic.related = related;
    diagnostics.push(diagnostic);
  };
  if (diagnostics.length) return { ok: false, diagnostics };
  if (!isRecord(catalog) || Object.keys(catalog).length === 0) {
    error("E_CATALOG", "Expected a nonempty node catalog from ComfyUI /object_info.", origin);
    return { ok: false, diagnostics };
  }
  if (parsed.declarations.length === 0) {
    error("E_EMPTY", "The source contains no node assignments.", origin);
    return { ok: false, diagnostics };
  }

  const nodes = new Map<string, NodeDeclaration>();
  const schemas = new Map<string, NodeSchema>();
  const bindings = new Map<string, BoundInputs>();
  const classSchemas = new Map<string, NodeSchema>();
  for (const declaration of parsed.declarations.map(lowerDeclaration)) {
    const previous = nodes.get(declaration.name);
    if (previous) {
      error("E_DUPLICATE_NODE", `Node ${JSON.stringify(declaration.name)} is already declared.`, declaration.span, [{ message: "First declaration.", span: previous.span }]);
      continue;
    }
    nodes.set(declaration.name, declaration);
    if (!Object.hasOwn(catalog, declaration.classType)) {
      error("E_NODE_CLASS", `Node class ${JSON.stringify(declaration.classType)} is not available on this instance.`, declaration.classSpan);
      continue;
    }
    try {
      let schema = classSchemas.get(declaration.classType);
      if (!schema) { schema = readNodeSchema(catalog[declaration.classType]); classSchemas.set(declaration.classType, schema); }
      const binding = bindInputs(declaration, schema, error);
      bindings.set(declaration.name, binding);
      schemas.set(declaration.name, binding.schema);
    } catch (cause) {
      if (!(cause instanceof SchemaError)) throw cause;
      error("E_SCHEMA", `${declaration.classType}: ${cause.message}`, declaration.classSpan);
    }
  }

  const graph: ApiGraph = Object.create(null) as ApiGraph;
  const edges = new Map<string, Reference[]>();
  const variables = new Map<string, Map<string, TypeVariable>>();
  for (const [name, schema] of schemas) {
    variables.set(name, new Map([...schema.templates].map(([id, allowed]) => [id, new TypeVariable(allowed ? new Set(allowed) : undefined)])));
  }
  const port = (node: string, type: string, match?: string): PortType => match === undefined ? type : variables.get(node)!.get(match)!;

  function literal(value: Literal, input: InputSchema, node: string): ApiValue | undefined {
    if (Array.isArray(input.type)) {
      if (!input.type.includes(value.value)) {
        const preview = input.type.slice(0, 8).map(v => JSON.stringify(v)).join(", ");
        error("E_ENUM", `${input.name}: ${JSON.stringify(value.value)} is not an available choice. Expected ${preview || "an option, but the instance reports none"}${input.type.length > 8 ? ", …" : ""}.`, value.span);
        return;
      }
      return value.value;
    }
    const type = input.type;
    let valid = type === "*" ? true
      : type === "INT" ? typeof value.value === "number" && Number.isSafeInteger(value.value) && integerLiteral(value.raw)
      : type === "FLOAT" ? typeof value.value === "number"
      : type === "STRING" ? typeof value.value === "string"
      : type === "BOOLEAN" ? typeof value.value === "boolean" : false;
    const expected = port(node, type, input.match);
    const expectedDescription = describeType(expected);
    if (expected instanceof TypeVariable) {
      const candidates = typeof value.value === "number"
        ? new Set(integerLiteral(value.raw) ? ["INT", "FLOAT"] : ["FLOAT"])
        : new Set([typeof value.value === "string" ? "STRING" : "BOOLEAN"]);
      valid = constrainTypes(expected, candidates);
    }
    if (!valid) {
      error("E_TYPE", `${input.name}: expected ${expectedDescription}${["INT", "FLOAT", "STRING", "BOOLEAN"].includes(type) || input.match !== undefined ? "" : " from a node output"}, received a ${typeof value.value} literal.`, value.span);
      return;
    }
    if (typeof value.value === "number") {
      if ((input.min !== undefined && value.value < input.min) || (input.max !== undefined && value.value > input.max)) {
        error("E_RANGE", `${input.name}: ${value.raw} is outside the advertised range ${input.min ?? "-∞"} to ${input.max ?? "∞"}.`, value.span);
        return;
      }
    }
    return value.value;
  }

  function reference(value: Reference, input: InputSchema, node: string): ApiValue | undefined {
    const target = nodes.get(value.node);
    if (!target) { error("E_REFERENCE", `Unknown node ${JSON.stringify(value.node)}.`, value.span); return; }
    const targetSchema = schemas.get(value.node);
    if (!targetSchema) return; // The referenced declaration already has a class/schema diagnostic.
    const related = [{ message: `Referenced node ${value.node} (${target.classType}).`, span: target.classSpan }];
    let index: number;
    if (value.output === undefined) {
      if (targetSchema.outputs.length !== 1) {
        const message = targetSchema.outputs.length === 0
          ? `Node ${value.node} has no outputs and cannot be used as an input.`
          : `Node ${value.node} has ${targetSchema.outputs.length} outputs; select one explicitly, for example ${value.node}[0] or a named output.`;
        error("E_OUTPUT", message, value.span, related);
        return;
      }
      index = 0;
    } else if (typeof value.output === "number") { index = value.output; }
    else {
      const matches = targetSchema.outputNames.flatMap((name, i) => name === value.output ? [i] : []);
      if (matches.length > 1) { error("E_OUTPUT", `Output ${JSON.stringify(value.output)} is ambiguous on ${value.node}; use an output index.`, value.span, related); return; }
      index = matches[0] ?? -1;
    }
    const actualType = targetSchema.outputs[index];
    if (actualType === undefined) { error("E_OUTPUT", `Node ${value.node} has no output ${JSON.stringify(value.output)}.`, value.span, related); return; }
    if (Array.isArray(input.type)) {
      error("E_SCHEMA", `${input.name}: ${input.choices ? "dynamic selectors require a literal choice" : "connections into enum inputs are not supported yet; supply a literal choice"}.`, value.span, related);
      return;
    }
    const expected = port(node, input.type, input.match);
    const actual = port(value.node, actualType, targetSchema.outputMatches[index]);
    const expectedDescription = describeType(expected), actualDescription = describeType(actual);
    if (!connectTypes(expected, actual)) { error("E_TYPE", `${input.name}: expected ${expectedDescription}, but ${value.node}[${index}] supplies ${actualDescription}.`, value.span, related); return; }
    return [value.node, index];
  }

  for (const [name, declaration] of nodes) {
    const values = declaration.args.map(arg => arg.value);
    const references: Reference[] = [];
    for (const value of values) {
      if (value.kind === "map") { for (const entry of value.entries) values.push(entry.value); }
      else if (value.kind === "reference" && nodes.has(value.node)) references.push(value);
    }
    edges.set(name, references);
    const schema = schemas.get(name);
    if (!schema) continue;
    const { bound, orderError } = bindings.get(name)!;
    const inputs: Record<string, ApiValue> = Object.create(null) as Record<string, ApiValue>;
    for (const [inputName, input] of schema.inputs) {
      const arg = bound.get(inputName);
      if (!arg) {
        if (input.required && !orderError) error("E_REQUIRED", `Missing required input ${JSON.stringify(inputName)} on ${declaration.classType}.`, declaration.classSpan);
        continue;
      }
      if (arg.value.kind === "map") continue; // Unsupported or invalid map already diagnosed during binding.
      const value = arg.value.kind === "literal" ? literal(arg.value, input, name) : reference(arg.value, input, name);
      if (value !== undefined) inputs[inputName] = value;
    }
    graph[name] = { class_type: declaration.classType, inputs };
  }

  // Iterative DFS avoids a JavaScript call-stack limit for long dependency chains.
  const state = new Map<string, "active" | "done">();
  for (const name of nodes.keys()) {
    if (state.has(name)) continue;
    const stack = [{ name, index: 0 }];
    state.set(name, "active");
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const edge = edges.get(frame.name)?.[frame.index++];
      if (!edge) { state.set(frame.name, "done"); stack.pop(); continue; }
      if (state.get(edge.node) === "active") {
        error("E_CYCLE", `Connection to ${edge.node} creates a dependency cycle.`, edge.span, [{ message: "Cycle returns to this node.", span: nodes.get(edge.node)!.span }]);
      } else if (!state.has(edge.node)) {
        state.set(edge.node, "active"); stack.push({ name: edge.node, index: 0 });
      }
    }
  }
  if (diagnostics.some(d => d.severity === "error")) return { ok: false, diagnostics };
  if (![...schemas.values()].some(s => s.outputNode)) {
    diagnostics.push({ severity: "warning", code: "W_NO_OUTPUT", message: "This graph has no execution output node; ComfyUI will not execute it as a complete prompt.", span: parsed.declarations[0]!.span });
  }
  return { ok: true, graph, diagnostics };
}
