import { selectInputs } from "./catalog.js";
import type { NodeSchema } from "./catalog.js";
import type { Argument, Diagnostic, NodeDeclaration, Primitive, Span } from "./types.js";

type ReportError = (code: string, message: string, span: Span, related?: Diagnostic["related"]) => void;
export interface BoundInputs {
  schema: NodeSchema;
  bound: Map<string, Argument>;
  orderError: boolean;
}

/** Bind top-level positions, then lower dynamic maps to the same flat named inputs. */
export function bindInputs(declaration: NodeDeclaration, schema: NodeSchema, error: ReportError): BoundInputs {
  const bound = new Map<string, Argument>();
  const pending = new Map<string, Argument>();
  const values = new Map<string, Primitive>();
  let position = 0, orderError = false;

  function add(name: string, arg: Argument): void {
    const previous = bound.get(name);
    if (previous) {
      error("E_DUPLICATE_INPUT", `Input ${JSON.stringify(name)} is supplied more than once.`, arg.span, [{ message: "First supplied here.", span: previous.span }]);
      return;
    }
    bound.set(name, arg);
    if (arg.value.kind === "literal") values.set(name, arg.value.value);
    if (arg.value.kind === "map") pending.set(name, arg);
  }

  for (const arg of declaration.args) {
    let name = arg.name;
    if (name === undefined) {
      if (schema.order === undefined) {
        if (!orderError) error("E_INPUT_ORDER", `No usable input_order for ${declaration.classType}; use named arguments.`, arg.span);
        orderError = true;
        continue;
      }
      name = schema.order[position++];
      if (name === undefined) { error("E_ARGUMENT_COUNT", `Too many positional arguments for ${declaration.classType}.`, arg.span); continue; }
    }
    add(name, arg);
  }

  let selected = selectInputs(schema, values);
  while (pending.size) {
    let progress = false;
    for (const [name, arg] of pending) {
      const input = selected.inputs.get(name);
      // A parent map later in the source may activate this input on the next pass.
      if (!input) continue;
      pending.delete(name);
      progress = true;
      if (arg.value.kind !== "map") continue;
      if (!input.choices || input.selectorName === undefined) {
        error("E_MAP", `${name}: maps are supported only for dynamic-choice inputs.`, arg.value.span);
        continue;
      }
      const selector = arg.value.entries.find(entry => entry.name === input.selectorName);
      if (!selector) {
        error("E_REQUIRED", `${name}: map requires selector field ${JSON.stringify(input.selectorName)}.`, arg.value.span);
        continue;
      }
      if (selector.value.kind !== "literal") {
        error("E_SCHEMA", `${name}: dynamic selectors require a literal choice.`, selector.value.span);
        continue;
      }
      // Replace the map with its scalar selector; its children become named inputs.
      bound.set(name, { name, value: selector.value, span: selector.span });
      values.set(name, selector.value.value);
      const children = typeof selector.value.value === "string" ? input.choices.get(selector.value.value) : undefined;
      // Invalid choices are diagnosed by ordinary enum validation below.
      if (!children) continue;
      if (children.has(`${name}.${input.selectorName}`)) {
        error("E_MAP", `${name}: the selected schema has a child named ${JSON.stringify(input.selectorName)}, which conflicts with the map selector; use dotted arguments.`, arg.value.span);
        continue;
      }
      for (const entry of arg.value.entries) {
        if (entry === selector) continue;
        const childName = `${name}.${entry.name}`;
        if (!children.has(childName)) {
          error("E_INPUT", `Unknown or inactive map field ${JSON.stringify(entry.name)} on ${name}.`, entry.span);
          continue;
        }
        add(childName, { name: childName, value: entry.value, span: entry.span });
      }
    }
    if (!progress) break;
    selected = selectInputs(schema, values);
  }
  for (const [name, arg] of bound) {
    if (!selected.inputs.has(name)) error("E_INPUT", `Unknown, hidden, or inactive input ${JSON.stringify(name)} on ${declaration.classType}.`, arg.span);
  }
  return { schema: selected, bound, orderError };
}
