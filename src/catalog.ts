import type { Primitive } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface InputSchema {
  name: string;
  required: boolean;
  type: string | Primitive[];
  min?: number;
  max?: number;
  match?: string;
  choices?: Map<string, Map<string, InputSchema>>;
  selectorName?: string;
}

export interface NodeSchema {
  inputs: Map<string, InputSchema>;
  // Positions always refer to top-level inputs. Conditional children are named.
  order: string[] | undefined;
  outputs: string[];
  outputNames: string[];
  outputMatches: (string | undefined)[];
  templates: Map<string, string[] | undefined>;
  outputNode: boolean;
}

export class SchemaError extends Error {}
function unsupported(message: string): never { throw new SchemaError(message); }
const matchType = "COMFY_MATCHTYPE_V3";
const dynamicCombo = "COMFY_DYNAMICCOMBO_V3";

function portType(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes(",") || (value.includes("*") && value !== "*") ||
      value === "COMBO" || (value.startsWith("COMFY_") && value.endsWith("_V3") && value !== matchType)) {
    unsupported(`Unsupported port type ${JSON.stringify(value)}; expected a fixed type, wildcard, or MatchType port.`);
  }
  return value;
}

function primitive(value: unknown): value is Primitive {
  return typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
}

/** Normalize only classes used by the source, using ComfyUI's /object_info encoding. */
export function readNodeSchema(raw: unknown): NodeSchema {
  if (!isRecord(raw) || !isRecord(raw.input) || !Array.isArray(raw.output)) unsupported("Expected node metadata with input groups and an output array.");
  const templates = new Map<string, string[] | undefined>();

  function readTemplate(value: unknown): string {
    if (!isRecord(value) || typeof value.template_id !== "string" || !value.template_id || typeof value.allowed_types !== "string") {
      unsupported("MatchType inputs require template_id and allowed_types metadata.");
    }
    const id = value.template_id;
    const allowed = value.allowed_types === "*" ? undefined : value.allowed_types.split(",").map(portType);
    if (allowed?.some(type => type === "*" || type === matchType)) unsupported(`Invalid allowed types for MatchType template ${JSON.stringify(id)}.`);
    if (templates.has(id)) {
      const previous = templates.get(id);
      if (previous?.length !== allowed?.length || previous?.some(type => !allowed?.includes(type))) {
        unsupported(`Conflicting definitions for MatchType template ${JSON.stringify(id)}.`);
      }
    } else templates.set(id, allowed);
    return id;
  }

  function readInputs(groups: unknown, prefix = "", depth = 0): Map<string, InputSchema> {
    if (depth > 32) unsupported("Dynamic input nesting exceeds the supported depth of 32.");
    if (!isRecord(groups)) unsupported("Expected input groups for dynamic option.");
    for (const group of Object.keys(groups)) {
      if (!["required", "optional", "hidden"].includes(group)) unsupported(`Unsupported input group ${JSON.stringify(group)}.`);
    }
    const inputs = new Map<string, InputSchema>();
    for (const group of ["required", "optional"]) {
      const entries = groups[group] === undefined ? {} : groups[group];
      if (!isRecord(entries)) unsupported(`Expected an object for ${group} inputs.`);
      for (const [localName, spec] of Object.entries(entries)) {
        const name = prefix + localName;
        if (inputs.has(name)) unsupported(`Input ${JSON.stringify(name)} occurs in more than one group.`);
        if (!Array.isArray(spec) || spec.length < 1 || spec.length > 2) unsupported(`Input ${JSON.stringify(name)} has an unsupported schema.`);
        const options = spec.length === 1 ? {} : spec[1];
        if (!isRecord(options)) unsupported(`Input ${JSON.stringify(name)} options must be an object.`);
        let type: string | Primitive[];
        let choices: InputSchema["choices"];
        if (spec[0] === dynamicCombo) {
          if (!Array.isArray(options.options)) unsupported(`Dynamic input ${JSON.stringify(name)} requires an options array.`);
          choices = new Map();
          for (const option of options.options) {
            if (!isRecord(option) || typeof option.key !== "string" || choices.has(option.key)) unsupported(`Dynamic input ${JSON.stringify(name)} has invalid or duplicate option keys.`);
            choices.set(option.key, readInputs(option.inputs, `${name}.`, depth + 1));
          }
          type = [...choices.keys()];
        } else {
          const values: unknown = spec[0] === "COMBO" ? options.options : spec[0];
          if (Array.isArray(values)) {
            if (!values.every(primitive)) unsupported(`Input ${JSON.stringify(name)} has unsupported enum choices.`);
            type = values;
          } else type = portType(spec[0]);
        }
        const input: InputSchema = { name, required: group === "required", type };
        if (choices) { input.choices = choices; input.selectorName = localName; }
        if (type === matchType) input.match = readTemplate(options.template);
        for (const bound of ["min", "max"] as const) {
          if (options[bound] !== undefined) {
            if (typeof options[bound] !== "number" || !Number.isFinite(options[bound])) unsupported(`Input ${JSON.stringify(name)} has an invalid ${bound} bound.`);
            input[bound] = options[bound];
          }
        }
        if (input.min !== undefined && input.max !== undefined && input.min > input.max) unsupported(`Input ${JSON.stringify(name)} has reversed numeric bounds.`);
        inputs.set(name, input);
      }
    }
    return inputs;
  }

  const inputs = readInputs(raw.input);
  const outputs = raw.output.map(portType);
  const names = raw.output_name === undefined ? outputs : raw.output_name;
  if (!Array.isArray(names) || names.length !== outputs.length || !names.every(n => typeof n === "string")) unsupported("Output names must match the output array in length and contain strings.");
  if (raw.output_node !== undefined && typeof raw.output_node !== "boolean") unsupported("output_node must be a boolean.");
  const matches = raw.output_matchtypes;
  if (matches != null && (!Array.isArray(matches) || matches.length !== outputs.length)) unsupported("output_matchtypes must match the output array in length.");
  const outputMatches = outputs.map((type, index): string | undefined => {
    const id: unknown = matches?.[index];
    if (type === matchType) {
      if (typeof id !== "string" || !templates.has(id)) unsupported(`MatchType output ${index} requires an output_matchtypes entry naming an input template.`);
      return id;
    }
    if (id != null) unsupported(`Non-MatchType output ${index} has a MatchType template.`);
    return undefined;
  });

  let order: string[] | undefined = [];
  for (const group of ["required", "optional"]) {
    const keys = Object.keys((raw.input[group] ?? {}) as Record<string, unknown>);
    const advertised = isRecord(raw.input_order) ? raw.input_order[group] : undefined;
    if (keys.length === 0 && advertised === undefined) continue;
    if (!Array.isArray(advertised) || advertised.length !== keys.length ||
        !advertised.every(n => typeof n === "string" && keys.includes(n)) || new Set(advertised).size !== keys.length) {
      order = undefined; break;
    }
    order.push(...advertised as string[]);
  }
  return { inputs, order, outputs, outputNames: names as string[], outputMatches, templates, outputNode: raw.output_node === true };
}

/** Specialize per instance, without mutating the cached class schema or inserting defaults. */
export function selectInputs(schema: NodeSchema, values: Map<string, Primitive>): NodeSchema {
  const inputs = new Map(schema.inputs);
  // Map iteration visits appended children, allowing nested dynamic choices.
  for (const input of inputs.values()) {
    const selected = values.get(input.name);
    const children = typeof selected === "string" ? input.choices?.get(selected) : undefined;
    if (!children) continue;
    for (const [name, child] of children) {
      if (inputs.has(name)) unsupported(`Dynamic input ${JSON.stringify(name)} collides with another input.`);
      inputs.set(name, child);
    }
  }
  return { ...schema, inputs };
}
