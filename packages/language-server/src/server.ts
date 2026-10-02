#!/usr/bin/env node
import { isAbsolute, resolve } from "node:path";
import { createConnection, DiagnosticSeverity, ProposedFeatures, TextDocuments, TextDocumentSyncKind } from "vscode-languageserver/node";
import type { Diagnostic, InitializeParams, WorkspaceFolder } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { CatalogStore } from "./catalog-store.js";
import { LanguageDocument } from "./language.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const catalogs = new CatalogStore();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let folders: WorkspaceFolder[] = [];
let supportsConfiguration = false;
let supportsSecrets = false;
let supportsFolders = false;
let trusted = true;
let generation = 0;
let fallbackSettings: Record<string, unknown> = {};

connection.onInitialize((params: InitializeParams) => {
  folders = params.workspaceFolders ?? (params.rootUri ? [{ uri: params.rootUri, name: "workspace" }] : []);
  supportsFolders = !!params.capabilities.workspace?.workspaceFolders;
  supportsConfiguration = !!params.capabilities.workspace?.configuration;
  supportsSecrets = params.initializationOptions?.secretStorage === true;
  trusted = params.initializationOptions?.trusted !== false;
  return { capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: { triggerCharacters: [".", "[", '"', "=", ","] },
    hoverProvider: true, definitionProvider: true,
    signatureHelpProvider: { triggerCharacters: ["(", ",", "="], retriggerCharacters: [")"] },
    workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
  }, serverInfo: { name: "Coupl", version: "0.1.0" } };
});

connection.onInitialized(() => {
  if (supportsFolders) connection.workspace.onDidChangeWorkspaceFolders(event => {
    folders = folders.filter(folder => !event.removed.some(removed => removed.uri === folder.uri)).concat(event.added);
    revalidate(true);
  });
});

function workspaceFolder(uri: string): string | undefined {
  const folder = folders.filter(folder => uri.startsWith(folder.uri.replace(/\/$/, "") + "/"))
    .sort((a, b) => b.uri.length - a.uri.length)[0];
  return folder && URI.parse(folder.uri).scheme === "file" ? URI.parse(folder.uri).fsPath : undefined;
}

async function analyze(document: TextDocument) {
  // TextDocuments updates objects in place; retain the requested source/version across awaits.
  document = TextDocument.create(document.uri, document.languageId, document.version, document.getText());
  if (!trusted) return { language: new LanguageDocument(document), message: "Trust this workspace to load ComfyUI or saved catalogs. Syntax checking remains available." };
  const config = (supportsConfiguration ? await connection.workspace.getConfiguration({ scopeUri: document.uri, section: "coupl" }) : fallbackSettings) ?? {};
  const serverUrl = typeof config.serverUrl === "string" ? config.serverUrl.trim() : "";
  let catalogPath = typeof config.catalogPath === "string" ? config.catalogPath.trim() : "";
  if (catalogPath && !isAbsolute(catalogPath)) {
    const folder = workspaceFolder(document.uri);
    if (!folder) return { language: new LanguageDocument(document), message: "Use an absolute coupl.catalogPath for documents outside a workspace folder." };
    catalogPath = resolve(folder, catalogPath);
  }
  const token = serverUrl && supportsSecrets ? await connection.sendRequest<string | null>("coupl/token", { serverUrl }) : process.env.COUPL_BEARER_TOKEN;
  const result = await catalogs.get({ serverUrl, catalogPath, ...(token ? { token } : {}) });
  return { language: new LanguageDocument(document, result.catalog), message: result.message };
}

async function validate(document: TextDocument): Promise<void> {
  const epoch = generation;
  const version = document.version;
  try {
    const { language, message } = await analyze(document);
    if (epoch !== generation || documents.get(document.uri) !== document || document.version !== version) return;
    const diagnostics = language.diagnostics();
    if (message) diagnostics.push({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      severity: DiagnosticSeverity.Information, code: "CATALOG_STATUS", source: "coupl", message });
    await connection.sendDiagnostics({ uri: document.uri, version, diagnostics });
  } catch {
    if (epoch !== generation || documents.get(document.uri) !== document || document.version !== version) return;
    const diagnostic: Diagnostic = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      severity: DiagnosticSeverity.Warning, source: "coupl", message: "Could not analyze this document. Check the Coupl language server connection and refresh the catalog." };
    await connection.sendDiagnostics({ uri: document.uri, version, diagnostics: [diagnostic] });
  }
}

function schedule(document: TextDocument): void {
  clearTimeout(timers.get(document.uri));
  timers.set(document.uri, setTimeout(() => { timers.delete(document.uri); void validate(document); }, 150));
}

function revalidate(clear: boolean): void {
  generation++;
  if (clear) catalogs.clear(); else catalogs.refresh();
  for (const document of documents.all()) schedule(document);
}

connection.onDidChangeConfiguration(change => { fallbackSettings = change.settings?.coupl ?? {}; revalidate(true); });
connection.onNotification("coupl/refreshCatalog", () => revalidate(false));
documents.onDidChangeContent(event => schedule(event.document));
documents.onDidClose(event => {
  clearTimeout(timers.get(event.document.uri));
  timers.delete(event.document.uri);
  void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onCompletion(async params => {
  const document = documents.get(params.textDocument.uri);
  return document ? (await analyze(document)).language.completions(params.position) : [];
});
connection.onHover(async params => {
  const document = documents.get(params.textDocument.uri);
  return document ? (await analyze(document)).language.hover(params.position) : null;
});
connection.onDefinition(params => {
  const document = documents.get(params.textDocument.uri);
  return document ? new LanguageDocument(document).definition(params.position) : null;
});
connection.onSignatureHelp(async params => {
  const document = documents.get(params.textDocument.uri);
  return document ? (await analyze(document)).language.signatureHelp(params.position) : null;
});
documents.listen(connection);
connection.listen();
