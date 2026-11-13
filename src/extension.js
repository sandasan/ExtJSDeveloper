const vscode = require('vscode');
const path = require('path');
const { tokenize, scanFile, findReferenceTokens } = require('./parser');
const { resolveClassPath } = require('./project');

const JS_FILES = '**/*.{js,jsx,mjs,cjs}';
const classes = new Map();
const aliases = new Map();
const indexedFiles = new Map();
const reverseDependencies = new Map();
const projectNamespaces = new Set();
const similarityCache = new Map();
let tree;
let dependencyTree;
let watcher;
let appConfigWatcher;
let rebuildVersion = 0;
let documentChangeTimer;
let diagnosticCollection;
const pendingDocuments = new Map();

function replaceClassMaps(files) {
  const nextClasses = new Map(), nextAliases = new Map();
  for (const file of files.values()) {
    for (const item of file.declarations) {
      if (!nextClasses.has(item.name)) nextClasses.set(item.name, item);
      for (const alias of item.aliases) if (!nextAliases.has(alias)) nextAliases.set(alias, item);
    }
  }
  classes.clear(); aliases.clear();
  for (const [key, value] of nextClasses) classes.set(key, value);
  for (const [key, value] of nextAliases) aliases.set(key, value);
  projectNamespaces.clear(); similarityCache.clear();
  for (const entry of classes.values()) projectNamespaces.add(entry.name.split('.')[0]);
  reverseDependencies.clear();
  for (const entry of classes.values()) reverseDependencies.set(entry.name, []);
  for (const candidate of classes.values()) {
    const seen = new Set();
    for (const dependency of candidate.dependencies) {
      const target = resolve(dependency.name);
      if (!target || seen.has(target.name)) continue;
      seen.add(target.name);
      reverseDependencies.get(target.name)?.push(candidate);
    }
  }
  refreshDiagnostics();
}

function reindexDocument(document) {
  const key = document.uri.toString();
  if (!indexedFiles.has(key)) return false;
  const text = document.getText();
  const parsed = scanFile(text, document.uri);
  indexedFiles.set(key, { uri: document.uri, text, tokens: parsed.tokens, declarations: parsed.declarations, references: parsed.references });
  return true;
}

function flushDocumentChanges() {
  documentChangeTimer = undefined;
  let changed = false;
  for (const document of pendingDocuments.values()) {
    if (reindexDocument(document)) changed = true;
  }
  pendingDocuments.clear();
  if (changed) {
    replaceClassMaps(indexedFiles);
    tree?.refresh(); dependencyTree?.refresh();
  }
}

function scheduleDocumentChange(document) {
  if (!/\.(?:[cm]?js|jsx)$/i.test(document.uri.fsPath)) return;
  pendingDocuments.set(document.uri.toString(), document);
  clearTimeout(documentChangeTimer);
  documentChangeTimer = setTimeout(flushDocumentChanges, 200);
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const above = previous[column];
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

function similarClasses(reference) {
  const cacheKey = `${reference.kind}:${reference.name}`;
  if (similarityCache.has(cacheKey)) return similarityCache.get(cacheKey);
  const candidates = new Map();
  if (reference.kind === 'xtype') {
    for (const entry of classes.values()) {
      for (const alias of entry.aliases) {
        if (alias.startsWith('widget.')) candidates.set(alias.slice('widget.'.length), alias.slice('widget.'.length));
      }
    }
  } else {
    for (const entry of classes.values()) candidates.set(entry.name, entry.name);
  }
  const target = reference.name.toLowerCase();
  const limit = Math.max(1, Math.min(3, Math.floor(target.length * 0.2)));
  const candidateValues = [...candidates.values()];
  const namespace = reference.name.split('.')[0];
  const scopedCandidates = reference.kind !== 'xtype' && reference.name.includes('.')
    ? candidateValues.filter(value => value.split('.')[0] === namespace)
    : candidateValues;
  const suggestions = scopedCandidates.map(value => ({ value, distance: editDistance(target, value.toLowerCase()) }))
    .filter(candidate => candidate.distance > 0 && candidate.distance <= limit)
    .sort((a, b) => a.distance - b.distance || a.value.localeCompare(b.value))
    .slice(0, 3);
  similarityCache.set(cacheKey, suggestions);
  return suggestions;
}

function refreshDiagnostics() {
  if (!diagnosticCollection) return;
  diagnosticCollection.clear();
  for (const file of indexedFiles.values()) {
    const starts = lineStartsFor(file.text);
    const fileDiagnostics = [];
    const seenRanges = new Set();
    for (const reference of file.references || []) {
      const target = reference.kind === 'xtype' ? resolve(`widget.${reference.name}`) : resolve(reference.name);
      if (target) continue;
      const suggestions = similarClasses(reference);
      const namespace = reference.name.split('.')[0];
      const knownNamespace = reference.kind !== 'xtype' && projectNamespaces.has(namespace);
      if (!knownNamespace && !suggestions.length) continue;
      const rangeKey = `${reference.start}:${reference.end}`;
      if (seenRanges.has(rangeKey)) continue;
      seenRanges.add(rangeKey);
      const range = new vscode.Range(positionAt(starts, reference.start), positionAt(starts, reference.end));
      const diagnostic = new vscode.Diagnostic(
        range,
        `Cannot resolve ExtJS ${reference.kind} "${reference.name}" in the current workspace index.`,
        vscode.DiagnosticSeverity.Information
      );
      diagnostic.source = 'ExtJS Navigator';
      diagnostic.code = 'extjsNavigator.unresolved';
      fileDiagnostics.push(diagnostic);
    }
    diagnosticCollection.set(file.uri, fileDiagnostics);
  }
}

async function rebuild() {
  const version = ++rebuildVersion;
  if (!vscode.workspace.workspaceFolders) {
    classes.clear(); aliases.clear(); indexedFiles.clear(); reverseDependencies.clear(); projectNamespaces.clear(); similarityCache.clear();
    tree?.refresh(); dependencyTree?.refresh();
    diagnosticCollection?.clear();
    return;
  }
  const excluded = vscode.workspace.getConfiguration('extjsNavigator').get('exclude', []);
  const exclude = excluded.length ? `{${excluded.join(',')}}` : undefined;
  const sourceRoots = await discoverSourceRoots(exclude);
  const fileGroups = sourceRoots.length
    ? await Promise.all(sourceRoots.map(root => vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(root.fsPath), JS_FILES), exclude)))
    : [await vscode.workspace.findFiles(JS_FILES, exclude)];
  const sourceFiles = [...new Map(fileGroups.flat().map(uri => [uri.toString(), uri])).values()];
  const nextFiles = new Map();
  await Promise.all(sourceFiles.map(async uri => {
    try {
      const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
      const bytes = openDocument ? undefined : await vscode.workspace.fs.readFile(uri);
      const text = openDocument ? openDocument.getText() : Buffer.from(bytes).toString('utf8');
      const parsed = scanFile(text, uri);
      nextFiles.set(uri.toString(), { uri, text, tokens: parsed.tokens, declarations: parsed.declarations, references: parsed.references });
    } catch (_) { /* A file may have disappeared during indexing. */ }
  }));
  if (version !== rebuildVersion) return;
  // Refresh open documents again at commit time in case they changed while the
  // asynchronous disk scan was in progress.
  for (const document of vscode.workspace.textDocuments) {
    const key = document.uri.toString();
    if (!nextFiles.has(key)) continue;
    const current = nextFiles.get(key);
    if (current.text === document.getText()) continue;
    const text = document.getText();
    const parsed = scanFile(text, document.uri);
    nextFiles.set(key, { uri: document.uri, text, tokens: parsed.tokens, declarations: parsed.declarations, references: parsed.references });
  }
  indexedFiles.clear();
  for (const [key, value] of nextFiles) indexedFiles.set(key, value);
  replaceClassMaps(indexedFiles);
  tree?.refresh(); dependencyTree?.refresh();
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function addSourceRoot(roots, rootPath, label) {
  const resolved = path.resolve(rootPath);
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(resolved));
    if (stat.type & vscode.FileType.Directory && !roots.has(resolved)) roots.set(resolved, { fsPath: resolved, label });
  } catch (_) { /* Ignore source paths that are not present on disk. */ }
}

async function discoverSourceRoots(exclude) {
  const roots = new Map();
  const workspaces = vscode.workspace.workspaceFolders || [];
  const configuredRoots = vscode.workspace.getConfiguration('extjsNavigator').get('sourceRoots', []);
  for (const folder of workspaces) {
    for (const configured of configuredRoots) {
      await addSourceRoot(roots, path.isAbsolute(configured) ? configured : path.join(folder.uri.fsPath, configured), `Configured: ${configured}`);
    }
  }

  const appConfigs = await vscode.workspace.findFiles('**/app.json', exclude);
  for (const configUri of appConfigs) {
    try {
      const configText = Buffer.from(await vscode.workspace.fs.readFile(configUri)).toString('utf8');
      const app = JSON.parse(configText);
      const classpath = Array.isArray(app.classpath) ? app.classpath : [];
      const appDir = path.dirname(configUri.fsPath);
      const workspace = workspaces.filter(folder => isWithin(folder.uri.fsPath, configUri.fsPath))
        .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
      const toolkit = typeof app.toolkit === 'string' ? app.toolkit : app.toolkit?.name;
      for (const classpathEntry of classpath) {
        if (typeof classpathEntry !== 'string') continue;
        const resolvedEntry = resolveClassPath(classpathEntry, appDir, workspace?.uri.fsPath, toolkit);
        if (resolvedEntry) await addSourceRoot(roots, resolvedEntry, `app.json: ${classpathEntry}`);
      }
    } catch (_) { /* Ignore invalid app.json files. */ }
  }
  return [...roots.values()];
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

function dependentsOf(entry) {
  return reverseDependencies.get(entry.name) || [];
}

function classTreeItem(entry, ancestry = new Set([entry.name])) {
  const dependentCount = dependentsOf(entry).length;
  const item = new vscode.TreeItem(entry.name, entry.dependencies.length || dependentCount
    ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  item.entry = entry;
  item.ancestry = ancestry;
  item.command = { command: 'extjsNavigator.revealEntry', title: 'Open ExtJS class', arguments: [entry] };
  return item;
}

function commandLink(label, entry) {
  const file = indexedFiles.get(entry.uri.toString());
  if (!file) return label.replace(/[\\[\]]/g, '\\$&');
  const args = encodeURIComponent(JSON.stringify([entry.uri.toString(), entry.offset]));
  const safeLabel = label.replace(/[\\[\]]/g, '\\$&');
  return `[${safeLabel}](command:extjsNavigator.openAtLocation?${args})`;
}

function inlineCode(value) {
  return `\`${value.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``;
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

class DependencyTreeProvider {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; }
  refresh() { this.emitter.fire(); }
  getTreeItem(item) { return item; }
  getChildren(item) {
    if (item?.children) return item.children;
    if (item?.entry) {
      const ancestry = item.ancestry || new Set();
      const dependencies = item.entry.dependencies.map(dependency => {
        const resolved = resolve(dependency.name);
        const circular = resolved && ancestry.has(resolved.name);
        const label = resolved ? resolved.name : dependency.name;
        const child = new vscode.TreeItem(label, resolved && !circular && (resolved.dependencies.length || dependentsOf(resolved).length)
          ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        child.description = `${dependency.kind}${resolved ? '' : ' · outside index'}${circular ? ' · cycle' : ''}`;
        child.entry = circular ? undefined : resolved;
        child.ancestry = resolved ? new Set([...ancestry, resolved.name]) : ancestry;
        if (resolved) child.command = { command: 'extjsNavigator.revealEntry', title: 'Open ExtJS class', arguments: [resolved] };
        return child;
      });
      const dependents = dependentsOf(item.entry);
      if (!dependents.length) return dependencies;
      const circularDependents = dependents.filter(entry => ancestry.has(entry.name));
      const usedBy = new vscode.TreeItem(`Used by (${dependents.length})`, vscode.TreeItemCollapsibleState.Collapsed);
      usedBy.children = dependents.map(entry => {
        const circular = ancestry.has(entry.name);
        const child = classTreeItem(entry, new Set([...ancestry, entry.name]));
        const kinds = [...new Set(entry.dependencies.filter(dependency => resolve(dependency.name) === item.entry).map(dependency => dependency.kind))];
        child.description = `${kinds.join(', ')}${circular ? ' · cycle' : ''}`;
        if (circular) {
          child.collapsibleState = vscode.TreeItemCollapsibleState.None;
          child.entry = undefined;
          child.command = undefined;
        }
        return child;
      });
      usedBy.description = circularDependents.length ? `${circularDependents.length} cycle${circularDependents.length === 1 ? '' : 's'}` : undefined;
      return [...dependencies, usedBy];
    }
    if (item) return [];

    const groups = new Map();
    for (const entry of classes.values()) {
      const namespace = entry.name.split('.')[0];
      if (!groups.has(namespace)) groups.set(namespace, []);
      groups.get(namespace).push(entry);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([namespace, entries]) => {
      const group = new vscode.TreeItem(`${namespace} (${entries.length})`, vscode.TreeItemCollapsibleState.Collapsed);
      group.children = entries.sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
        return classTreeItem(entry);
      });
      return group;
    });
  }
}

function activate(context) {
  tree = new ClassTreeProvider();
  dependencyTree = new DependencyTreeProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider('extjsExplorer', tree));
  context.subscriptions.push(vscode.window.registerTreeDataProvider('extjsDependencies', dependencyTree));
  context.subscriptions.push(vscode.commands.registerCommand('extjsNavigator.refreshIndex', rebuild));
  context.subscriptions.push(vscode.commands.registerCommand('extjsNavigator.revealEntry', openEntry));
  context.subscriptions.push(vscode.commands.registerCommand('extjsNavigator.openAtLocation', async (uriString, offset) => {
    const uri = vscode.Uri.parse(uriString);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    const position = document.positionAt(Math.max(0, Math.min(offset, document.getText().length)));
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }));
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
  context.subscriptions.push(vscode.languages.registerHoverProvider({ language: 'javascript' }, {
    provideHover(document, position) {
      const word = wordAt(document, position);
      const entry = word && resolve(word.value);
      if (!entry) return undefined;

      const markdown = new vscode.MarkdownString();
      markdown.isTrusted = { enabledCommands: ['extjsNavigator.openAtLocation'] };
      markdown.appendMarkdown(`**Ext JS class**\n\n${commandLink(entry.name, entry)}\n\n`);
      if (entry.aliases.length) {
        markdown.appendMarkdown('**Aliases and xtypes**\n\n');
        markdown.appendCodeblock(entry.aliases.join('\n'), 'text');
      }
      if (entry.dependencies.length) {
        markdown.appendMarkdown('**Dependencies**\n\n');
        for (const dependency of entry.dependencies) {
          const target = resolve(dependency.name);
          const label = target ? commandLink(dependency.name, target) : inlineCode(dependency.name);
          markdown.appendMarkdown(`- ${dependency.kind}: ${label}\n`);
        }
        markdown.appendMarkdown('\n');
      }
      const file = indexedFiles.get(entry.uri.toString());
      if (file) {
        const line = positionAt(lineStartsFor(file.text), entry.offset).line + 1;
        const folder = vscode.workspace.getWorkspaceFolder(entry.uri);
        const filePath = folder ? path.relative(folder.uri.fsPath, entry.uri.fsPath) : entry.uri.fsPath;
        markdown.appendMarkdown('**Defined in**\n\n');
        markdown.appendMarkdown(`${commandLink(`${filePath}:${line}`, entry)}\n\n`);
      }
      const dependentCount = dependentsOf(entry).length;
      if (dependentCount) markdown.appendMarkdown(`Used by **${dependentCount}** indexed class${dependentCount === 1 ? '' : 'es'}.`);
      return new vscode.Hover(markdown, word.range);
    }
  }));
  context.subscriptions.push(vscode.languages.registerReferenceProvider({ language: 'javascript' }, {
    provideReferences(document, position, referenceContext) {
      const word = wordAt(document, position);
      const target = word && resolve(word.value);
      return target ? findReferences(target, document, referenceContext.includeDeclaration) : [];
    }
  }));
  diagnosticCollection = vscode.languages.createDiagnosticCollection('extjsNavigator');
  context.subscriptions.push(diagnosticCollection);
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ language: 'javascript' }, {
    provideCodeActions(document, range, actionContext) {
      const file = indexedFiles.get(document.uri.toString());
      if (!file) return [];
      const actions = [];
      for (const diagnostic of actionContext.diagnostics) {
        if (diagnostic.code !== 'extjsNavigator.unresolved') continue;
        const start = document.offsetAt(diagnostic.range.start);
        const end = document.offsetAt(diagnostic.range.end);
        const reference = (file.references || []).find(item => item.start === start && item.end === end);
        if (!reference) continue;

        const configure = new vscode.CodeAction('Configure ExtJS source roots…', vscode.CodeActionKind.QuickFix);
        configure.diagnostics = [diagnostic];
        configure.command = {
          command: 'workbench.action.openSettings',
          title: 'Open ExtJS source root settings',
          arguments: ['@extjsNavigator.sourceRoots']
        };
        actions.push(configure);

        for (const suggestion of similarClasses(reference)) {
          const replace = new vscode.CodeAction(`Replace with "${suggestion.value}"`, vscode.CodeActionKind.QuickFix);
          replace.diagnostics = [diagnostic];
          replace.edit = new vscode.WorkspaceEdit();
          replace.edit.replace(document.uri, diagnostic.range, JSON.stringify(suggestion.value));
          actions.push(replace);
        }
      }
      return actions;
    }
  }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
  context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider({
    provideWorkspaceSymbols(query) {
      const normalizedQuery = query.trim().toLowerCase();
      const symbols = [];
      for (const entry of classes.values()) {
        const searchableText = [entry.name, ...entry.aliases].join(' ').toLowerCase();
        if (normalizedQuery && !searchableText.includes(normalizedQuery)) continue;
        const file = indexedFiles.get(entry.uri.toString());
        const starts = file ? lineStartsFor(file.text) : [0];
        const start = positionAt(starts, entry.offset);
        const end = positionAt(starts, entry.nameEnd);
        const namespace = entry.name.split('.').slice(0, -1).join('.');
        symbols.push(new vscode.SymbolInformation(
          entry.name,
          vscode.SymbolKind.Class,
          namespace,
          new vscode.Location(entry.uri, new vscode.Range(start, end))
        ));
      }
      return symbols;
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
  // app.json classpath entries determine which folders are indexed. Keep the
  // index in sync when projects add or change source roots.
  appConfigWatcher = vscode.workspace.createFileSystemWatcher('**/app.json');
  appConfigWatcher.onDidCreate(rebuild, null, context.subscriptions);
  appConfigWatcher.onDidDelete(rebuild, null, context.subscriptions);
  appConfigWatcher.onDidChange(rebuild, null, context.subscriptions);
  context.subscriptions.push(appConfigWatcher);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('extjsNavigator.exclude') || event.affectsConfiguration('extjsNavigator.sourceRoots')) rebuild();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => scheduleDocumentChange(event.document)));
  rebuild();
}

async function openEntry(entry) {
  const doc = await vscode.workspace.openTextDocument(entry.uri);
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(doc.positionAt(entry.offset), doc.positionAt(entry.offset));
  editor.revealRange(new vscode.Range(doc.positionAt(entry.offset), doc.positionAt(entry.offset)), vscode.TextEditorRevealType.InCenter);
}

function deactivate() {
  clearTimeout(documentChangeTimer);
  watcher?.dispose(); appConfigWatcher?.dispose();
}
module.exports = { activate, deactivate };
