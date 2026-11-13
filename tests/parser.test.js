const test = require('node:test');
const assert = require('node:assert/strict');
const { scanFile, tokenize, findReferenceTokens } = require('../src/parser');
const { resolveClassPath } = require('../src/project');

test('indexes top-level Ext.define metadata and ignores nested configuration', () => {
  const source = `
    /* Ext.define('Fake.Comment', { xtype: 'fake' }); */
    const text = "Ext.define('Fake.String', { xtype: 'fake' })";
    const pattern = /Ext\\.define\\('Fake.Regex', \\{ xtype: 'fake' \\}\\)/;
    Ext.define('Demo.view.Panel', {
      alias: ['widget.demo-panel', 'widget.demoPanel'],
      items: [{ xtype: 'nested-item', alias: 'widget.nested-item' }],
      config: { xtype: 'nested-config' },
      xtype: 'demo-panel',
      handler: function () { return /[{}]/.test(text); }
    });
    Ext.define('Demo.view.Other', {});
  `;

  const { declarations } = scanFile(source, 'file:///app/views.js');
  assert.equal(declarations.length, 2);
  assert.deepEqual(declarations[0].aliases, ['widget.demo-panel', 'widget.demoPanel']);
  assert.equal(declarations[0].name, 'Demo.view.Panel');
  assert.equal(declarations[1].name, 'Demo.view.Other');
  assert.equal(source.slice(declarations[0].offset, declarations[0].nameEnd), declarations[0].name);
});

test('extracts static class dependencies without taking values from nested configs', () => {
  const source = `Ext.define('Demo.view.Panel', {
    extend: 'Ext.panel.Panel',
    requires: ['Demo.data.Store', 'Demo.util.Formatter'],
    uses: ['Demo.view.Help'],
    mixins: { observable: 'Ext.mixin.Observable' },
    controller: 'Demo.view.PanelController',
    viewModel: { type: 'Demo.view.PanelModel' },
    config: { requires: ['Demo.fake.Dependency'] }
  });`;
  const { declarations } = scanFile(source, 'file:///app/Panel.js');
  assert.deepEqual(declarations[0].dependencies, [
    { name: 'Ext.panel.Panel', kind: 'extends' },
    { name: 'Demo.data.Store', kind: 'requires' },
    { name: 'Demo.util.Formatter', kind: 'requires' },
    { name: 'Demo.view.Help', kind: 'uses' },
    { name: 'Ext.mixin.Observable', kind: 'mixins' },
    { name: 'Demo.view.PanelController', kind: 'controller' },
    { name: 'Demo.view.PanelModel', kind: 'viewModel' }
  ]);
});

test('resolves app.json classpath entries without invoking external tooling', () => {
  assert.equal(resolveClassPath('app', '/project', '/workspace', 'classic'), '/project/app');
  assert.equal(resolveClassPath('${toolkit.name}/src', '/project', '/workspace', 'modern'), '/project/modern/src');
  assert.equal(resolveClassPath('${workspace.dir}/shared', '/project', '/workspace', 'classic'), '/workspace/shared');
  assert.equal(resolveClassPath('${toolkit.name}/src', '/project', '/workspace'), undefined);
  assert.equal(resolveClassPath('${framework.dir}/src', '/project', '/workspace', 'classic'), undefined);
});

test('decodes escaped class names and ignores dynamic template contents', () => {
  const source = [
    "const template = `before ${Ext.define('Fake.Template', {})} after`;",
    "Ext.define('Demo\\u002eEscaped', { xtype: 'escaped' });"
  ].join('\n');

  const { declarations } = scanFile(source, 'file:///app/escaped.js');
  assert.deepEqual(declarations.map(item => item.name), ['Demo.Escaped']);
});

test('finds class and xtype references without treating ordinary text as an xtype', () => {
  const source = `
    Ext.define('Demo.view.Panel', { alias: 'widget.demo-panel', xtype: 'demo-panel' });
    Ext.create('Demo.view.Panel');
    const view = { xtype: 'demo-panel' };
    const views = { xtype: ['demo-panel', 'other'] };
    Ext.widget('demo-panel');
    const text = { text: 'demo-panel' };
    const aliasText = 'widget.demo-panel';
    const dotted = Demo.view.Panel;
    // Ext.create('Demo.view.Panel');
  `;
  const uri = 'file:///app/Panel.js';
  const { declarations, tokens } = scanFile(source, uri);
  const target = declarations[0];

  const references = findReferenceTokens(target, tokens, uri, false);
  const values = references.map(token => token.value);
  assert.equal(values.includes('Demo.view.Panel'), true);
  assert.equal(values.filter(value => value === 'demo-panel').length, 4);
  assert.equal(values.includes('widget.demo-panel'), true);
  assert.equal(values.includes('text'), false);
  assert.equal(references.some(token => source.slice(token.start, token.end).startsWith('//')), false);

  const withDeclaration = findReferenceTokens(target, tokens, uri, true);
  assert.equal(withDeclaration.length, references.length + 1);
});

test('tokenizes quoted delimiters as values instead of structural braces', () => {
  const tokens = tokenize(`const value = "}, ] )"; /* { ignored } */ const regex = /[{}]/;`);
  assert.equal(tokens.some(token => token.type === 'string' && token.value === '}, ] )'), true);
  assert.equal(tokens.some(token => token.value === 'ignored'), false);
  assert.equal(tokens.some(token => token.value === '{' || token.value === '}'), false);
});
