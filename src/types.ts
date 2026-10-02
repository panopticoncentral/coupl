export interface Position {
  offset: number;
  line: number;
  column: number;
}

export interface Span {
  start: Position;
  end: Position;
}

export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  span: Span;
  related?: { message: string; span: Span }[];
}

export type Primitive = string | number | boolean;
export type ApiValue = Primitive | [string, number];
export type ApiGraph = Record<string, { class_type: string; inputs: Record<string, ApiValue> }>;

export type CompileResult =
  | { ok: true; graph: ApiGraph; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

export interface Literal {
  kind: "literal";
  value: Primitive;
  raw: string;
  span: Span;
}

export interface Reference {
  kind: "reference";
  node: string;
  output?: string | number;
  span: Span;
}

export interface MapEntry {
  name: string;
  value: Value;
  span: Span;
}

export interface MapValue {
  kind: "map";
  entries: MapEntry[];
  span: Span;
}

export type Value = Literal | Reference | MapValue;
export interface Argument {
  name?: string;
  value: Value;
  span: Span;
}

export interface NodeDeclaration {
  name: string;
  classType: string;
  classSpan: Span;
  args: Argument[];
  span: Span;
}

export interface LiteralDeclaration {
  name: string;
  value: Literal;
  span: Span;
}

export type Declaration = NodeDeclaration | LiteralDeclaration;
