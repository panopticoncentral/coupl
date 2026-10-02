const assert = require('node:assert/strict');
const vscode = require('vscode');

async function waitFor(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

exports.run = async function () {
  const extension = vscode.extensions.getExtension('panopticoncentral.coupl-vscode');
  assert.ok(extension, 'extension discovered');
  await extension.activate();
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'test.coupl'));
  assert.equal(document.languageId, 'coupl');
  await vscode.window.showTextDocument(document);
  const position = document.positionAt(document.getText().length);
  const completion = await waitFor(async () => {
    const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position);
    return result?.items.some(item => item.label === 'CLIP') ? result : undefined;
  }, 'catalog-aware completion did not appear');
  assert.ok(completion.items.some(item => item.label === 'MODEL'));
  await waitFor(() => vscode.languages.getDiagnostics(document.uri).some(item => item.code === 'E_SYNTAX'), 'live syntax diagnostics did not appear');
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, position, 'CLIP)');
  await vscode.workspace.applyEdit(edit);
  await waitFor(() => !vscode.languages.getDiagnostics(document.uri).some(item => item.severity === vscode.DiagnosticSeverity.Error), 'diagnostics did not update after unsaved edit');
  const reference = document.positionAt(document.getText().lastIndexOf('checkpoint') + 2);
  const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, reference);
  assert.equal(definitions[0].range.start.line, 0);
  const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(0, 20));
  assert.ok(hover.length);
  const signaturePosition = document.positionAt(document.getText().indexOf('"hello"') + 2);
  const signature = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', document.uri, signaturePosition);
  assert.ok(signature.signatures[0].label.startsWith('CLIPTextEncode('));
  await vscode.commands.executeCommand('coupl.refreshCatalog');
  const result = 'Coupl VS Code smoke test passed: activation, language association, completion, diagnostics, unsaved edits, definitions, hover, signature help, refresh.';
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'smoke-result.txt'), Buffer.from(result));
  console.log(result);
};
