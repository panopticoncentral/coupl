import { bindInputs, compile, parse, parseForEditor, readNodeSchema } from "coupl";
import type { Declaration, Diagnostic as CoreDiagnostic, InputSchema, NodeDeclaration, NodeSchema, Span, Token, Value } from "coupl";
import { CompletionItemKind, DiagnosticSeverity, MarkupKind } from "vscode-languageserver/node";
import type { CompletionItem, Diagnostic, Hover, Location, Position, Range, SignatureHelp } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

export type Catalog = Record<string, unknown>;
const nameText = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name);
const tokenText = (token: Token) => token.kind === "string" ? JSON.parse(token.text) as string : token.text;
const contains = (span: Span, offset: number) => span.start.offset <= offset && offset <= span.end.offset;

function nodeDeclaration(declaration: Declaration): NodeDeclaration {
  if (!("value" in declaration)) return declaration;
  const value = declaration.value;
  return { name: declaration.name, classType: typeof value.value === "boolean" ? "PrimitiveBoolean" : value.raw.startsWith('"""') ? "PrimitiveStringMultiline" : "PrimitiveString",
    classSpan: value.span, args: [{ name: "value", value, span: value.span }], span: declaration.span };
}

function inputLabel(input: InputSchema): string {
  const type = Array.isArray(input.type) ? input.type.map(value => JSON.stringify(value)).join(" | ") : input.type;
  const bounds = [input.min === undefined ? "" : `min ${input.min}`, input.max === undefined ? "" : `max ${input.max}`].filter(Boolean).join(", ");
  return `${nameText(input.name)}${input.required ? "" : "?"}: ${type}${bounds ? ` (${bounds})` : ""}`;
}

interface Frame {
  kind: "call" | "map" | "bracket";
  segment: Token[];
  argument: number;
  used: Set<string>;
  input?: InputSchema;
}

/** Analysis is local to one document version. All schema semantics come from the core. */
export class LanguageDocument {
  readonly source: string;
  readonly parsed: ReturnType<typeof parseForEditor>;
  constructor(readonly document: TextDocument, readonly catalog?: Catalog) {
    this.source = document.getText();
    this.parsed = parseForEditor(this.source);
  }

  range(span: Span): Range {
    // Offsets are UTF-16, like TextDocument and the default LSP position encoding.
    return { start: this.document.positionAt(span.start.offset), end: this.document.positionAt(span.end.offset) };
  }

  diagnostics(): Diagnostic[] {
    const result = this.catalog ? compile(this.source, this.catalog) : parse(this.source);
    return result.diagnostics.map((diagnostic: CoreDiagnostic) => ({
      range: this.range(diagnostic.span), message: diagnostic.message, source: "coupl", code: diagnostic.code,
      severity: diagnostic.severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
      ...(diagnostic.related ? { relatedInformation: diagnostic.related.map(note => ({
        location: { uri: this.document.uri, range: this.range(note.span) }, message: note.message,
      })) } : {}),
    }));
  }

  private schema(declaration: Declaration, selected = true): NodeSchema | undefined {
    const node = nodeDeclaration(declaration);
    try {
      if (!this.catalog || !Object.hasOwn(this.catalog, node.classType)) return;
      const schema = readNodeSchema(this.catalog[node.classType]);
      return selected ? bindInputs(node, schema, () => {}).schema : schema;
    } catch { return; } // Unsupported catalog classes still receive compiler diagnostics.
  }

  private currentToken(offset: number): Token | undefined {
    const editable = (token: Token) => ["identifier", "string", "invalid", "multiline"].includes(token.kind);
    return this.parsed.tokens.find(token => editable(token) && token.span.start.offset <= offset && offset < token.span.end.offset)
      ?? this.parsed.tokens.find(token => editable(token) && token.span.end.offset === offset)
      ?? this.parsed.tokens.find(token => token.kind !== "eof" && contains(token.span, offset));
  }

  private inComment(offset: number): boolean {
    const token = this.currentToken(offset);
    if (token && ["string", "multiline", "invalid"].includes(token.kind)) return false;
    const lastEnd = this.parsed.tokens.filter(t => t.span.end.offset <= offset && t.kind !== "eof").at(-1)?.span.end.offset ?? 0;
    return this.source.slice(lastEnd, offset).split("\n").at(-1)!.includes("//");
  }

  private context(offset: number) {
    const declaration = this.parsed.declarations.filter(d => d.span.start.offset <= offset).at(-1);
    if (!declaration || "value" in declaration) return;
    const tokens = this.parsed.tokens.filter(t => t.span.start.offset >= declaration.classSpan.end.offset && t.span.start.offset < offset);
    if (tokens[0]?.kind !== "(") return;
    const schema = this.schema(declaration);
    const stack: Frame[] = [{ kind: "call", segment: [], argument: 0, used: new Set() }];
    const inputFor = (frame: Frame): InputSchema | undefined => {
      const equal = frame.segment.findIndex(t => t.kind === "=");
      const key = equal > 0 ? tokenText(frame.segment[equal - 1]!) : undefined;
      if (frame.kind === "call") return schema?.inputs.get(key ?? schema.order?.[frame.argument] ?? "");
      if (frame.kind === "map" && frame.input) {
        if (key === frame.input.selectorName) return frame.input;
        return schema?.inputs.get(`${frame.input.name}.${key ?? ""}`);
      }
      return;
    };
    for (const token of tokens.slice(1)) {
      const frame = stack.at(-1);
      if (!frame) return;
      if (token.kind === "newline") continue;
      if (token.kind === "{" || token.kind === "[") {
        const input = inputFor(frame);
        frame.segment.push(token);
        stack.push({ kind: token.kind === "{" ? "map" : "bracket", segment: [], argument: 0, used: new Set(), ...(input ? { input } : {}) });
      } else if ([")", "}", "]"].includes(token.kind)) {
        const expected = token.kind === ")" ? "call" : token.kind === "}" ? "map" : "bracket";
        if (frame.kind !== expected) return;
        stack.pop();
      } else if (token.kind === ",") {
        const equal = frame.segment.findIndex(t => t.kind === "=");
        if (equal > 0) frame.used.add(tokenText(frame.segment[equal - 1]!));
        else if (frame.kind === "call" && schema?.order?.[frame.argument]) frame.used.add(schema.order[frame.argument]!);
        frame.argument++;
        frame.segment = [];
      } else frame.segment.push(token);
    }
    const frame = stack.at(-1);
    if (!frame) return;
    return { declaration, schema, frame, input: inputFor(frame), call: stack[0]! };
  }

  completions(position: Position): CompletionItem[] {
    const offset = this.document.offsetAt(position);
    if (this.inComment(offset)) return [];
    const current = this.currentToken(offset);
    if (current?.kind === "multiline") return [];
    const tokens = this.parsed.tokens.filter(t => t.span.start.offset < offset && t.kind !== "newline" && t.kind !== "eof");
    const editing = current && ["identifier", "string", "invalid"].includes(current.kind) ? current : undefined;
    const replacement = editing ? this.range(editing.span) : { start: position, end: position };
    const edit = (label: string, newText: string, kind: CompletionItemKind, detail?: string): CompletionItem => ({
      label, kind, filterText: newText, textEdit: { range: replacement, newText }, ...(detail ? { detail } : {}),
    });

    // A port selector can be unfinished even when the strict parser rejects it.
    let selectorIndex = -1;
    for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i]!.kind === "." || tokens[i]!.kind === "[") { selectorIndex = i; break; }
    if (selectorIndex >= 1 && tokens.length - selectorIndex <= 2) {
      const selector = tokens[selectorIndex]!;
      const owner = tokens[selectorIndex - 1]!;
      const declaration = owner.kind === "identifier" ? this.parsed.declarations.find(d => d.name === owner.text) : undefined;
      const schema = declaration && this.schema(declaration);
      if (schema) return schema.outputs.map((type, index) => {
        const name = schema.outputNames[index] ?? String(index);
        const unique = schema.outputNames.filter(n => n === name).length === 1;
        const dot = unique && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
        const newText = selector.kind === "." && dot ? `.${name}` : `[${unique ? JSON.stringify(name) : index}]`;
        let end = editing?.span.end.offset ?? offset;
        if (selector.kind === "[" && this.source[end] === "]") end++;
        return { label: name, kind: CompletionItemKind.Field, detail: type, filterText: newText,
          textEdit: { range: { start: this.document.positionAt(selector.span.start.offset), end: this.document.positionAt(end) }, newText } };
      });
    }

    const context = this.context(offset);
    if (!context) {
      // Offer classes only on the right side of an assignment, before a call.
      const lineTokens = this.parsed.tokens.filter(t => t.span.start.offset >= this.source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1 && t.span.start.offset < offset);
      if (lineTokens[0]?.kind !== "identifier" || lineTokens[1]?.kind !== "=" || lineTokens.some(t => t.kind === "(")) return [];
      return Object.keys(this.catalog ?? {}).map(name => edit(name, nameText(name), CompletionItemKind.Constructor));
    }
    const { frame, schema, input } = context;
    if (frame.kind === "bracket") return [];
    const equal = frame.segment.findIndex(t => t.kind === "=");
    const items: CompletionItem[] = [];
    if (equal < 0) {
      const inputs = frame.kind === "call" ? schema?.inputs : frame.input?.choices ? new Map([
        [frame.input.selectorName!, { ...frame.input, name: frame.input.selectorName! }],
        ...[...frame.input.choices.values()].flatMap(children => [...children]
          .filter(([name, value]) => schema?.inputs.get(name) === value)
          .map(([name, value]) => [name.slice(frame.input!.name.length + 1), { ...value, name: name.slice(frame.input!.name.length + 1) }] as const)),
      ]) : undefined;
      for (const [name, field] of inputs ?? []) {
        const suffix = this.source.slice(editing?.span.end.offset ?? offset);
        const assignment = /^\s*=/.test(suffix) ? "" : " = ";
        if (!frame.used.has(name)) items.push(edit(name, `${nameText(name)}${assignment}`, CompletionItemKind.Property, inputLabel(field)));
      }
    }
    if (input && Array.isArray(input.type)) {
      for (const value of input.type) items.push(edit(String(value), JSON.stringify(value), CompletionItemKind.EnumMember));
    } else if (input?.type === "BOOLEAN") {
      for (const value of ["true", "false"]) items.push(edit(value, value, CompletionItemKind.Value));
    }
    // Do not inject node names into a string literal or a map-key position.
    if ((equal >= 0 || frame.kind === "call") && (!editing || !["string", "invalid"].includes(editing.kind))) {
      for (const declaration of this.parsed.declarations) {
        const output = this.schema(declaration);
        if (output?.outputs.length === 0) continue;
        items.push(edit(declaration.name, declaration.name, CompletionItemKind.Variable,
          output ? output.outputs.join(", ") : nodeDeclaration(declaration).classType));
      }
    }
    return items;
  }

  signatureHelp(position: Position): SignatureHelp | null {
    const offset = this.document.offsetAt(position);
    if (this.inComment(offset)) return null;
    const context = this.context(offset);
    if (!context?.schema) return null;
    const { declaration, schema, call } = context;
    const names = schema.order ? [...schema.order, ...[...schema.inputs.keys()].filter(name => !schema.order!.includes(name))] : [...schema.inputs.keys()];
    const parameters = names.map(name => ({ label: inputLabel(schema.inputs.get(name)!) }));
    const equal = call.segment.findIndex(t => t.kind === "=");
    const active = equal > 0 ? names.indexOf(tokenText(call.segment[equal - 1]!)) : schema.order ? call.argument : -1;
    return { signatures: [{ label: `${nameText(declaration.classType)}(${parameters.map(p => p.label).join(", ")})`, parameters }],
      activeSignature: 0, ...(active >= 0 && active < parameters.length ? { activeParameter: active } : {}) };
  }

  private referenceAt(value: Value, offset: number): string | undefined {
    if (value.kind === "reference" && contains(value.span, offset)) return value.node;
    if (value.kind === "map") for (const entry of value.entries) {
      const name = this.referenceAt(entry.value, offset);
      if (name) return name;
    }
    return;
  }

  private symbolAt(offset: number): Declaration | undefined {
    for (const declaration of this.parsed.declarations) {
      if (declaration.span.start.offset <= offset && offset <= declaration.span.start.offset + declaration.name.length) return declaration;
      if (!("value" in declaration)) for (const arg of declaration.args) {
        const name = this.referenceAt(arg.value, offset);
        if (name) return this.parsed.declarations.find(d => d.name === name);
      }
    }
    return;
  }

  definition(position: Position): Location | null {
    const declaration = this.symbolAt(this.document.offsetAt(position));
    if (!declaration) return null;
    const start = declaration.span.start.offset;
    return { uri: this.document.uri, range: { start: this.document.positionAt(start), end: this.document.positionAt(start + declaration.name.length) } };
  }

  hover(position: Position): Hover | null {
    const offset = this.document.offsetAt(position);
    if (this.inComment(offset)) return null;
    let declaration = this.parsed.declarations.find(d => !("value" in d) && contains(d.classSpan, offset));
    declaration ??= this.symbolAt(offset);
    if (declaration) {
      const node = nodeDeclaration(declaration), schema = this.schema(declaration);
      const description = `${declaration.name}: ${nameText(node.classType)}${schema ? `\n${[...schema.inputs.values()].map(inputLabel).join("\n")}\nOutputs: ${schema.outputs.map((type, i) => `${nameText(schema.outputNames[i] ?? String(i))}: ${type}`).join(", ") || "none"}` : ""}`;
      return { contents: { kind: MarkupKind.PlainText, value: description } };
    }
    const context = this.context(offset + 1);
    const token = this.currentToken(offset);
    if (context?.schema && token && ["identifier", "string"].includes(token.kind)) {
      const name = tokenText(token);
      const input = context.schema.inputs.get(name) ?? (context.frame.input && context.schema.inputs.get(`${context.frame.input.name}.${name}`));
      if (input) return { contents: { kind: MarkupKind.PlainText, value: inputLabel(input) }, range: this.range(token.span) };
    }
    return null;
  }
}
