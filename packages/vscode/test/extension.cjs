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
  // Exercise the actual Run command against a local protocol fixture.
  const { createServer } = require('node:http');
  let submissions = 0, downloads = 0, fail = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/object_info') {
      res.end(JSON.stringify({ SmokeOutput: { input: { required: { text: ['STRING'] } }, input_order: { required: ['text'] }, output: [], output_name: [], output_node: true } }));
    } else if (req.url === '/prompt') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw);
      assert.equal(payload.prompt.output.inputs.text, 'unsaved');
      submissions++;
      res.end(JSON.stringify({ prompt_id: 'smoke' }));
    } else if (req.url === '/history/smoke') {
      if (fail) {
        const changed = new vscode.WorkspaceEdit();
        changed.insert(document.uri, new vscode.Position(0, 0), '// edited after queueing\n');
        await vscode.workspace.applyEdit(changed);
        res.end(JSON.stringify({ smoke: { outputs: {}, status: { completed: false, status_str: 'error', messages: [['execution_error', { node_id: 'output', exception_message: 'Synthetic runtime failure' }]] } } }));
      } else res.end(JSON.stringify({ smoke: { outputs: { output: { images: [{ filename: 'smoke.png', subfolder: '', type: 'output' }], text: ['<script>untrusted output</script>'] } }, status: { completed: true, status_str: 'success', messages: [] } } }));
    } else if (req.url.startsWith('/view?')) {
      downloads++; res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII=', 'base64'));
    } else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await vscode.workspace.getConfiguration('coupl', document.uri).update('serverUrl', `http://127.0.0.1:${server.address().port}`, vscode.ConfigurationTarget.Workspace);
    const sourceEdit = new vscode.WorkspaceEdit();
    sourceEdit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), 'output = SmokeOutput(text = "unsaved")');
    await vscode.workspace.applyEdit(sourceEdit);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('coupl.run');
    assert.equal(submissions, 1, 'run submits the unsaved buffer');
    assert.equal(downloads, 1, 'run downloads the completed output');
    fail = true;
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('coupl.run');
    assert.equal(submissions, 2);
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.scheme === 'coupl-run', 'runtime error did not open the submitted source snapshot');
    const snapshot = vscode.window.activeTextEditor.document;
    assert.equal(snapshot.getText(), 'output = SmokeOutput(text = "unsaved")');
    assert.ok(vscode.languages.getDiagnostics(snapshot.uri).some(item => item.message.includes('Synthetic runtime failure') && item.range.start.line === 0));
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  const result = 'Coupl VS Code smoke test passed: language features, unsaved workflow execution, output download, runtime diagnostics, and submitted-source snapshots.';
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'smoke-result.txt'), Buffer.from(result));
  console.log(result);
};
