import type { Argument, Declaration, Diagnostic, Literal, MapEntry, Position, Span, Value } from "./types.js";

export type TokenKind = "identifier" | "string" | "multiline" | "number" | "newline" | "eof" | "=" | "(" | ")" | "," | "." | "[" | "]" | "{" | "}" | "invalid";
export interface Token { kind: TokenKind; text: string; span: Span }

class SyntaxFailure extends Error {
  constructor(readonly diagnostic: Diagnostic) { super(diagnostic.message); }
}

function fail(code: string, message: string, span: Span): never {
  throw new SyntaxFailure({ severity: "error", code, message, span });
}

function tokenize(source: string, diagnostics?: Diagnostic[]): Token[] {
  const tokens: Token[] = [];
  let offset = 0, line = 1, column = 1;
  const position = (): Position => ({ offset, line, column });
  const advance = () => { const c = source[offset++]; if (c === "\n") { line++; column = 1; } else { column++; } };
  while (offset < source.length) {
    const c = source[offset]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\uFEFF") { advance(); continue; }
    if (source.startsWith("//", offset)) {
      while (offset < source.length && source[offset] !== "\n") advance();
      continue;
    }
    const start = position();
    try {
      let kind: TokenKind;
      if (c === "\n") { kind = "newline"; advance(); }
      else if ("=(),.[]{}".includes(c)) { kind = c as TokenKind; advance(); }
      else if (/[A-Za-z_]/.test(c)) {
        kind = "identifier";
        while (offset < source.length && /[A-Za-z0-9_]/.test(source[offset]!)) advance();
      } else if (source.startsWith('"""', offset)) {
        kind = "multiline";
        for (let i = 0; i < 3; i++) advance();
        while (offset < source.length && !source.startsWith('"""', offset)) advance();
        if (offset === source.length) fail("E_SYNTAX", "Unterminated triple-quoted string.", { start, end: position() });
        for (let i = 0; i < 3; i++) advance();
        // Four or five closing quotes retain one or two quotes in the value.
        for (let i = 0; i < 2 && source[offset] === '"'; i++) advance();
      } else if (c === '"') {
        kind = "string";
        advance();
        let closed = false;
        while (offset < source.length && source[offset] !== "\n" && source[offset] !== "\r") {
          if (source[offset] === '"') { advance(); closed = true; break; }
          if (source[offset] === "\\") {
            advance();
            if (offset >= source.length || source[offset] === "\n" || source[offset] === "\r") break;
          }
          advance();
        }
        const span = { start, end: position() };
        if (!closed) fail("E_SYNTAX", "Unterminated string; use JSON escapes such as \\n inside strings.", span);
        try { JSON.parse(source.slice(start.offset, offset)); }
        catch { fail("E_SYNTAX", "Invalid JSON string escape or control character.", span); }
      } else if (c === "-" || /[0-9]/.test(c)) {
        kind = "number";
        const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(offset));
        if (!match) { advance(); fail("E_SYNTAX", "Expected a number after '-'.", { start, end: position() }); }
        for (let i = 0; i < match[0].length; i++) advance();
        const value = Number(match[0]);
        if (value === 0 && /[1-9]/.test(match[0].split(/[eE]/)[0]!)) {
          fail("E_NUMBER", "Number is too small to represent; emitting it would silently replace it with zero.", { start, end: position() });
        }
        if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
          fail("E_NUMBER", "Number is non-finite or outside the supported safe integer range; it cannot be emitted without risking precision loss.", { start, end: position() });
        }
      } else {
        advance();
        fail("E_SYNTAX", `Unexpected character ${JSON.stringify(c)}.`, { start, end: position() });
      }
      tokens.push({ kind, text: source.slice(start.offset, offset), span: { start, end: position() } });
    } catch (error) {
      if (!(error instanceof SyntaxFailure) || !diagnostics) throw error;
      diagnostics.push(error.diagnostic);
      if (offset === start.offset) advance();
      tokens.push({ kind: "invalid", text: source.slice(start.offset, offset), span: { start, end: position() } });
    }
  }
  const end = position();
  tokens.push({ kind: "eof", text: "", span: { start: end, end } });
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[], private readonly recovery?: Diagnostic[]) {}
  private peek(): Token { return this.tokens[this.index]!; }
  private next(): Token { return this.tokens[this.index++]!; }
  private skipLines(): void { while (this.peek().kind === "newline") this.next(); }
  private expect(kind: TokenKind): Token {
    const token = this.peek();
    if (token.kind !== kind) fail("E_SYNTAX", `Expected ${kind}, found ${token.kind === "eof" ? "end of file" : JSON.stringify(token.text)}.`, token.span);
    return this.next();
  }
  private name(): Token {
    if (this.peek().kind !== "identifier" && this.peek().kind !== "string") fail("E_SYNTAX", "Expected an identifier or quoted name.", this.peek().span);
    return this.next();
  }
  private text(token: Token): string { return token.kind === "string" ? JSON.parse(token.text) as string : token.text; }

  parse(): Declaration[] {
    const declarations: Declaration[] = [];
    this.skipLines();
    while (this.peek().kind !== "eof") {
      const beginning = this.index;
      try {
        const name = this.expect("identifier");
        if (name.text === "true" || name.text === "false") fail("E_SYNTAX", "Boolean literals cannot be node names.", name.span);
        this.expect("=");
        const token = this.peek();
        const followedByCall = this.tokens[this.index + 1]?.kind === "(";
        if (token.kind === "multiline" || (!followedByCall && (token.kind === "string" ||
            (token.kind === "identifier" && ["true", "false"].includes(token.text))))) {
          const value = this.value() as Literal;
          declarations.push({ name: name.text, value, span: { start: name.span.start, end: value.span.end } });
          this.endDeclaration();
          continue;
        }
        if (token.kind === "number") {
          fail("E_SYNTAX", "Top-level literal assignments support booleans and strings; use PrimitiveInt or PrimitiveFloat explicitly for numbers.", token.span);
        }
        if (token.kind === "{") fail("E_SYNTAX", "Maps are supported as node arguments, not top-level assignments.", token.span);
        const classToken = this.name();
        this.expect("(");
        this.skipLines();
        const args: Argument[] = [];
        const declaration: Declaration = { name: name.text, classType: this.text(classToken), classSpan: classToken.span, args, span: { start: name.span.start, end: this.peek().span.start } };
        declarations.push(declaration);
        let hasNamed = false;
        while (this.peek().kind !== ")") {
          if (this.recovery && this.peek().kind === "identifier" && this.tokens[this.index - 1]?.kind === "newline" &&
              this.tokens[this.index + 1]?.kind === "=" && this.tokens[this.index + 3]?.kind === "(") {
            fail("E_SYNTAX", "Expected ')' before the next declaration.", this.peek().span);
          }
          const start = this.peek().span.start;
          let argName: string | undefined;
          if ((this.peek().kind === "identifier" || this.peek().kind === "string") && this.tokens[this.index + 1]?.kind === "=") {
            argName = this.text(this.next()); this.next(); hasNamed = true; this.skipLines();
          } else if (hasNamed) {
            fail("E_ARGUMENT_ORDER", "Positional arguments must come before all named arguments.", this.peek().span);
          }
          const value = this.value();
          const arg: Argument = { value, span: { start, end: value.span.end } };
          if (argName !== undefined) arg.name = argName;
          args.push(arg);
          declaration.span.end = arg.span.end;
          this.skipLines();
          if (this.peek().kind === ")") break;
          this.expect(",");
          this.skipLines();
        }
        const end = this.expect(")").span.end;
        declaration.span.end = end;
        this.endDeclaration();
      } catch (error) {
        if (!(error instanceof SyntaxFailure) || !this.recovery) throw error;
        this.recovery.push(error.diagnostic);
        // Resume at a new top-level assignment, preserving any partial call.
        // Strings/comments are single tokens, so their contents cannot look like declarations.
        if (this.index === beginning) this.index++;
        while (this.peek().kind !== "eof") {
          if (this.peek().kind === "identifier" && this.tokens[this.index + 1]?.kind === "=" &&
              this.tokens[this.index - 1]?.kind === "newline") break;
          this.index++;
        }
      }
    }
    return declarations;
  }

  private endDeclaration(): void {
    if (this.peek().kind !== "newline" && this.peek().kind !== "eof") fail("E_SYNTAX", "Expected a newline between node assignments.", this.peek().span);
    this.skipLines();
  }

  private value(depth = 0): Value {
    const token = this.peek();
    if (token.kind === "{") {
      if (depth >= 32) fail("E_SYNTAX", "Map nesting exceeds the supported depth of 32.", token.span);
      this.next();
      this.skipLines();
      const entries: MapEntry[] = [];
      const names = new Set<string>();
      try {
        while (this.peek().kind !== "}") {
          const key = this.name();
          const name = this.text(key);
          if (names.has(name)) fail("E_DUPLICATE_KEY", `Map key ${JSON.stringify(name)} is supplied more than once.`, key.span);
          names.add(name);
          this.expect("=");
          this.skipLines();
          const value = this.value(depth + 1);
          entries.push({ name, value, span: { start: key.span.start, end: value.span.end } });
          this.skipLines();
          if (this.peek().kind === "}") break;
          this.expect(",");
          this.skipLines();
        }
        const end = this.expect("}").span.end;
        return { kind: "map", entries, span: { start: token.span.start, end } };
      } catch (error) {
        if (!(error instanceof SyntaxFailure) || !this.recovery) throw error;
        this.recovery.push(error.diagnostic);
        return { kind: "map", entries, span: { start: token.span.start, end: this.peek().span.start } };
      }
    }
    if (token.kind === "multiline") {
      this.next();
      return { kind: "literal", value: token.text.slice(3, -3), raw: token.text, span: token.span };
    }
    if (token.kind === "string" || token.kind === "number" || (token.kind === "identifier" && ["true", "false"].includes(token.text))) {
      this.next();
      return { kind: "literal", value: JSON.parse(token.text) as string | number | boolean, raw: token.text, span: token.span };
    }
    const node = this.expect("identifier");
    let output: string | number;
    let end: Position;
    if (this.peek().kind === ".") {
      this.next(); const name = this.expect("identifier"); output = name.text; end = name.span.end;
    } else if (this.peek().kind === "[") {
      this.next();
      const selector = this.peek();
      if (selector.kind === "string") { output = this.text(this.next()); }
      else {
        this.expect("number");
        if (!/^(0|[1-9][0-9]*)$/.test(selector.text)) fail("E_OUTPUT", "Output indices must be nonnegative integer literals.", selector.span);
        output = Number(selector.text);
      }
      end = this.expect("]").span.end;
    } else { return { kind: "reference", node: node.text, span: node.span }; }
    return { kind: "reference", node: node.text, output, span: { start: node.span.start, end } };
  }
}

export function parse(source: string): { declarations: Declaration[]; diagnostics: Diagnostic[] } {
  try { return { declarations: new Parser(tokenize(source)).parse(), diagnostics: [] }; }
  catch (error) {
    if (error instanceof SyntaxFailure) return { declarations: [], diagnostics: [error.diagnostic] };
    throw error;
  }
}

/** Recover declarations and tokens for editor features; compile() retains strict parsing. */
export function parseForEditor(source: string): { declarations: Declaration[]; diagnostics: Diagnostic[]; tokens: Token[] } {
  const diagnostics: Diagnostic[] = [];
  const tokens = tokenize(source, diagnostics);
  const declarations = new Parser(tokens, diagnostics).parse();
  return { declarations, diagnostics, tokens };
}
