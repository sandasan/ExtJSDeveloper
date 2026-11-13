# ExtJS Navigator

A small Visual Studio Code extension for navigating Ext JS applications. It supports classic `Ext.define` declarations and static `Ext.ClassManager.create`/`set` patterns used by Ext JS 4 and later. It has no runtime dependencies.

## Features

- Go to a class definition by clicking or using **Go to Definition** on class names, `widget.*` aliases, or xtype values.
- Find references with **Shift+F12** or **Peek References** on class names and widget aliases/xtypes.
- Search the workspace index with **ExtJS: Open Class or xtype**.
- Find Ext JS classes in VS Code's **Go to Symbol in Workspace** search (`Ctrl+T`), including matches by alias and xtype.
- Browse indexed classes in the **ExtJS Classes** view in Explorer.
- Browse class dependencies in **ExtJS Dependencies**. Expand a class to see its `extend`, `requires`, `uses`, `mixins`, `controller`, and `viewModel` links, then expand those classes to follow the graph.
- Get class name completions in common class and view configuration values such as `requires`, `extend`, `xtype`, `controller`, and `viewModel`.
- Rebuild the index with **ExtJS: Refresh Workspace Index**. JavaScript file changes are also indexed automatically.
- Unsaved edits in indexed JavaScript files update class names, aliases, and dependencies automatically after a short pause while typing.

The index tokenizes JavaScript before reading `Ext.define('App.view.MyPanel', { ... })` and `Ext.ClassManager.create(...)` declarations, so commented-out declarations and braces inside strings, regular expressions, and nested values do not confuse the class metadata scan. It reads top-level `alias`, `xtype`, and dependency metadata, including alias and xtype values formed by concatenating string literals. Alias references are matched in `alias` properties, and xtype references in `xtype` properties or `Ext.widget(...)` calls, to avoid treating matching display text as a reference.

Source folders are discovered from local `app.json` `classpath` entries. Additional paths can be set in `extjsNavigator.sourceRoots`; if no roots are found, the whole workspace is indexed. This extension does not install or invoke Sencha Cmd, download framework files, or perform license/trial checks. Framework classes appear in the dependency tree only when their source files are already available in the indexed folders.

Set `extjsNavigator.exclude` to add generated or vendor paths to the exclusion list.

## Run locally

Open this folder in VS Code, press **F5**, and select the Extension Development Host launch configuration when prompted. In the new window, open an Ext JS application folder and use the commands above.

To package for distribution, install the VS Code Extension Manager (`vsce`) and run `vsce package` from this folder.

Run the parser and reference-search tests with `npm test` (Node.js 18 or newer; no npm dependencies are required).

## Current scope

This MVP handles classic Ext JS class declarations and JavaScript workspaces. Reference search covers statically written names; it cannot resolve names constructed dynamically at runtime. It does not yet resolve classes from Sencha Cmd package metadata or generated framework SDK sources outside the workspace.
