const vscode = require('vscode');
const path = require('path');

const JS_FILES = '**/*.{js,jsx,mjs,cjs}';
const classes = new Map();
const aliases = new Map();
let tree;
let watcher;

function unquote(value) { return value && value.replace(/^['"]|['"]$/g, ''); }

function scan(text, uri) {
  const found = [];
  // Ext.define's first argument is the canonical class name. Metadata is read from its config block.
  const define = /Ext\.define\s*\(\s*(['"])([^'"\n]+)\1\s*,\s*\{/g;
  let match;
  while ((match = define.exec(text))) {
    const start = match.index;
    const open = text.indexOf('{', define.lastIndex - 1);
    const end = findObjectEnd(text, open);
    const block = text.slice(open + 1, end < 0 ? text.length : end);
    const className = match[2];
    const aliasValues = [];
    const aliasMatch = block.match(/\balias\s*:\s*(\[[\s\S]*?\]|['"][^'"]+['"])/);
    if (aliasMatch) {
      const values = aliasMatch[1].match(/['"]([^'"]+)['"]/g) || [];
      aliasValues.push(...values.map(unquote));
    }
    const xtypeMatch = block.match(/\bxtype\s*:\s*(['"])([^'"]+)\1/);
    if (xtypeMatch) aliasValues.push(`widget.${xtypeMatch[2]}`);
    found.push({ name: className, aliases: [...new Set(aliasValues)], uri, offset: start });
  }
  return found;
}

function findObjectEnd(text, open) {
  if (open < 0) return -1;
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = ''; continue; }
    if (c === '/' && next === '/') { lineComment = true; i++; continue; }
    if (c === '/' && next === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

async function rebuild() {
  classes.clear(); aliases.clear();
  if (!vscode.workspace.workspaceFolders) { tree?.refresh(); return; }
  const excluded = vscode.workspace.getConfiguration('extjsNavigator').get('exclude', []);
  const exclude = excluded.length ? `{${excluded.join(',')}}` : undefined;
  const files = await vscode.workspace.findFiles(JS_FILES, exclude);
  await Promise.all(files.map(async uri => {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      for (const item of scan(Buffer.from(bytes).toString('utf8'), uri)) {
        classes.set(item.name, item);
        for (const alias of item.aliases) aliases.set(alias, item);
      }
    } catch (_) { /* File may have disappeared during indexing. */ }
  }));
  tree?.refresh();
}

function resolve(name) { return classes.get(name) || aliases.get(name) || aliases.get(`widget.${name}`); }
function wordAt(document, position) {
  const range = document.getWordRangeAtPosition(position, /[\w.$-]+/);
  return range ? { value: document.getText(range), range } : undefined;
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
