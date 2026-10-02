import type { Diagnostic } from "./types.js";

export function formatDiagnostic(diagnostic: Diagnostic, source: string, filename = "<source>"): string {
  const { line, column } = diagnostic.span.start;
  const text = source.split(/\r?\n/)[line - 1] ?? "";
  const width = diagnostic.span.end.line === line ? Math.max(1, diagnostic.span.end.column - column) : 1;
  const marker = text.slice(0, column - 1).replace(/[^\t]/g, " ") + "^".repeat(Math.min(width, Math.max(1, text.length - column + 1)));
  const notes = (diagnostic.related ?? []).map(note => `  ${filename}:${note.span.start.line}:${note.span.start.column}: note: ${note.message}`);
  return [`${filename}:${line}:${column}: ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`, `  ${text}`, `  ${marker}`, ...notes].join("\n");
}
