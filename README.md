# ExtJS Navigator

A small Visual Studio Code extension for navigating Ext JS applications. The first release targets the classic `Ext.define` class system used by Ext JS 5.1 and later. It has no runtime dependencies.

## Features

- Go to a class definition by clicking or using **Go to Definition** on class names, `widget.*` aliases, or xtype values.
- Search the workspace index with **ExtJS: Open Class or xtype**.
- Browse indexed classes in the **ExtJS Classes** view in Explorer.
- Get class name completions in common class and view configuration values such as `requires`, `extend`, `xtype`, `controller`, and `viewModel`.
- Rebuild the index with **ExtJS: Refresh Workspace Index**. JavaScript file changes are also indexed automatically.

The index reads `Ext.define('App.view.MyPanel', { ... })` declarations and their `alias` and `xtype` metadata. It scans JavaScript files in the open workspace. Set `extjsNavigator.exclude` to add generated or vendor paths to the exclusion list.

## Run locally

Open this folder in VS Code, press **F5**, and select the Extension Development Host launch configuration when prompted. In the new window, open an Ext JS application folder and use the commands above.

To package for distribution, install the VS Code Extension Manager (`vsce`) and run `vsce package` from this folder.

## Current scope

This MVP handles the Ext JS class system and JavaScript workspaces. It does not yet resolve classes from Sencha Cmd package metadata, generated framework SDK sources outside the workspace, dynamic class names, or Ext JS 4 `Ext.ClassManager` patterns.
