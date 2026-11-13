const vscode = require('vscode');
const { tokenize, scanFile, findReferenceTokens } = require('./parser');

const JS_FILES = '**/*.{js,jsx,mjs,cjs}';
const classes = new Map();
const aliases = new Map();
const indexedFiles = new Map();
let tree;
let watcher;
let rebuildVersion = 0;

async function rebuild() {
  const version = ++rebuildVersion;
  if (!vscode.workspace.workspaceFolders) {
    classes.clear(); aliases.clear(); indexedFiles.clear(); tree?.refresh();
    return;
  }
  const excluded = vscode.workspace.getConfiguration('extjsNavigator').get('exclude', []);
  const exclude = excluded.length ? `{${excluded.join(',')}}` : undefined;
  const files = await vscode.workspace.findFiles(JS_FILES, exclude);
  const nextClasses = new Map(), nextAliases = new Map(), nextFiles = new Map();
  await Promise.all(files.map(async uri => {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      const parsed = scanFile(text, uri);
      nextFiles.set(uri.toString(), { uri, text, tokens: parsed.tokens, declarations: parsed.declarations });
      for (const item of parsed.declarations) {
        if (!nextClasses.has(item.name)) nextClasses.set(item.name, item);
        for (const alias of item.aliases) if (!nextAliases.has(alias)) nextAliases.set(alias, item);
      }
    } catch (_) { /* A file may have disappeared during indexing. */ }
  }));
  if (version !== rebuildVersion) return;
  classes.clear(); aliases.clear(); indexedFiles.clear();
  for (const [key, value] of nextClasses) classes.set(key, value);
  for (const [key, value] of nextAliases) aliases.set(key, value);
  for (const [key, value] of nextFiles) indexedFiles.set(key, value);
  tree?.refresh();
}

function resolve(name) { return classes.get(name) || aliases.get(name) || aliases.get(`widget.${name}`); }
function wordAt(document, position) {
  const range = document.getWordRangeAtPosition(position, /[\w.$-]+/);
  return range ? { value: document.getText(range), range } : undefined;
}

function findReferences(target, document, includeDeclaration) {
  const sourceFiles = new Map(indexedFiles);
  if (document) {
    const text = document.getText();
    sourceFiles.set(document.uri.toString(), { uri: document.uri, text, tokens: tokenize(text), declarations: [] });
  }
  const results = new Map();

  for (const file of sourceFiles.values()) {
    const tokens = file.tokens;
    const lineStarts = lineStartsFor(file.text);
    for (const token of findReferenceTokens(target, tokens, file.uri.toString(), includeDeclaration)) {
      const key = `${file.uri.toString()}:${token.valueStart}`;
      const start = positionAt(lineStarts, token.valueStart);
      const end = positionAt(lineStarts, token.valueEnd);
      results.set(key, new vscode.Location(file.uri, new vscode.Range(start, end)));
    }
  }
  return [...results.values()];
}

function lineStartsFor(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function positionAt(lineStarts, offset) {
  let low = 0, high = lineStarts.length;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle;
  }
  return new vscode.Position(low, offset - lineStarts[low]);
}

class ClassTreeProvider {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; }
  refresh() { this.emitter.fire(); }
  getTreeItem(item) { return item; }
  getChildren(item) {
    if (item?.children) return item.children.map(entry => {
      const leaf = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
      leaf.description = entry.aliases.join(', ');
      leaf.command = { command: 'extjsNavigator.revealEntry', title: 'Open ExtJS class', arguments: [entry] };
      return leaf;
    });
    if (item) return [];
    const groups = new Map();
    for (const entry of classes.values()) {
      const root = entry.name.split('.')[0];
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(entry);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, entries]) => {
      const node = new vscode.TreeItem(`${name} (${entries.length})`, vscode.TreeItemCollapsibleState.Collapsed);
      node.children = entries.sort((a, b) => a.name.localeCompare(b.name));
      return node;
    });
  }
}

function activate(context) {
  tree = new ClassTreeProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider('extjsExplorer', tree));
  context.subscriptions.push(vscode.commands.registerCommand('extjsNavigator.refreshIndex', rebuild));
  context.subscriptions.push(vscode.commands.registerCommand('extjsNavigator.revealEntry', openEntry));
  context.subscriptions.push(vscode.commands.registerCommand('extjsNavigator.openClass', async () => {
    const picks = [...classes.values()].sort((a, b) => a.name.localeCompare(b.name)).map(item => ({
      label: item.name, description: item.aliases.join(', '), item
    }));
    const picked = await vscode.window.showQuickPick(picks, { placeHolder: 'Search ExtJS class, alias, or xtype' });
    if (picked) openEntry(picked.item);
  }));
  context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: 'javascript' }, {
    async provideDefinition(document, position) {
      const word = wordAt(document, position);
      const target = word && resolve(word.value);
      if (!target) return undefined;
      const targetDoc = await vscode.workspace.openTextDocument(target.uri);
      return new vscode.Location(target.uri, targetDoc.positionAt(target.offset));
    }
  }));
  context.subscriptions.push(vscode.languages.registerReferenceProvider({ language: 'javascript' }, {
    provideReferences(document, position, referenceContext) {
      const word = wordAt(document, position);
      const target = word && resolve(word.value);
      return target ? findReferences(target, document, referenceContext.includeDeclaration) : [];
    }
  }));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: 'javascript' }, {
    provideCompletionItems(document, position) {
      const line = document.lineAt(position.line).text.slice(0, position.character);
      if (!/(?:xtype|alias|requires|uses|extend|mixin|controller|viewModel)\s*:\s*(?:\[[^\]]*)?['"][^'"]*$/.test(line)) return;
      return [...classes.values()].map(item => {
        const completion = new vscode.CompletionItem(item.name, vscode.CompletionItemKind.Reference);
        completion.detail = item.aliases.join(', ');
        completion.insertText = item.name;
        return completion;
      });
    }
  }, '.', '"', "'"));
  watcher = vscode.workspace.createFileSystemWatcher(JS_FILES);
  watcher.onDidCreate(rebuild, null, context.subscriptions);
  watcher.onDidDelete(rebuild, null, context.subscriptions);
  watcher.onDidChange(rebuild, null, context.subscriptions);
  context.subscriptions.push(watcher);
  rebuild();
}

async function openEntry(entry) {
  const doc = await vscode.workspace.openTextDocument(entry.uri);
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(doc.positionAt(entry.offset), doc.positionAt(entry.offset));
  editor.revealRange(new vscode.Range(doc.positionAt(entry.offset), doc.positionAt(entry.offset)), vscode.TextEditorRevealType.InCenter);
}

function deactivate() { watcher?.dispose(); }
module.exports = { activate, deactivate };
