const ELEMENTS = [
  { id: 'view', label: 'View / component', description: 'Reusable Ext JS component with xtype' },
  { id: 'grid', label: 'Grid', description: 'Grid view and columns' },
  { id: 'form', label: 'Form', description: 'Form panel with sample fields' },
  { id: 'window', label: 'Window', description: 'Window component' },
  { id: 'controller', label: 'Controller', description: 'View controller with a handler' },
  { id: 'viewModel', label: 'ViewModel', description: 'View model with sample data' },
  { id: 'model', label: 'Model', description: 'Data model with fields' },
  { id: 'store', label: 'Store', description: 'Data store backed by a model' }
];

function pascalCase(value) {
  return value.split(/[^A-Za-z0-9_$]+/).filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1)).join('');
}

function makeClassName(namespace, name) {
  const cleanNamespace = namespace.split('.').filter(Boolean).join('.');
  const cleanName = pascalCase(name);
  return cleanNamespace ? `${cleanNamespace}.${cleanName}` : cleanName;
}

function xtypeFor(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
}

function createElement({ type, className, toolkit = 'classic', version = '7.0.0' }) {
  const modern = toolkit === 'modern';
  const major = Number.parseInt(version, 10) || 7;
  const safeXtype = xtypeFor(className.split('.').pop());
  const component = (extend, body, xtype = safeXtype) => `Ext.define('${className}', {\n    extend: '${extend}',\n    xtype: '${xtype}',\n${body ? `${body}\n` : ''}});\n`;
  switch (type) {
    case 'view':
      return component(modern ? 'Ext.Container' : 'Ext.container.Container', '    items: []');
    case 'grid':
      return component(modern ? 'Ext.grid.Grid' : 'Ext.grid.Panel', `    columns: [\n        { text: 'Name', dataIndex: 'name', flex: 1 }\n    ],\n    store: {\n        fields: ['name'],\n        data: []\n    }`);
    case 'form':
      return component('Ext.form.Panel', `    items: [\n        { xtype: 'textfield', name: 'name', fieldLabel: 'Name' }\n    ],\n    buttons: [{ text: 'Save' }]`);
    case 'window':
      return component(modern ? 'Ext.Dialog' : 'Ext.window.Window', `    title: 'Window',\n    modal: true,\n    width: 500,\n    height: 300,\n    layout: 'fit',\n    items: [{ xtype: 'panel', html: 'Content' }]`);
    case 'controller':
      return `Ext.define('${className}', {\n    extend: 'Ext.app.${major >= 5 ? 'ViewController' : 'Controller'}',\n\n    onSaveClick: function () {\n        // Add save behavior here.\n    }\n});\n`;
    case 'viewModel':
      return `Ext.define('${className}', {\n    extend: 'Ext.app.ViewModel',\n\n    data: {\n        name: ''\n    }\n});\n`;
    case 'model':
      return `Ext.define('${className}', {\n    extend: 'Ext.data.Model',\n\n    fields: ['id', 'name']\n});\n`;
    case 'store':
      return `Ext.define('${className}', {\n    extend: 'Ext.data.Store',\n    alias: 'store.${xtypeFor(className.split('.').pop())}',\n\n    model: '${className.replace(/Store$/, 'Model')}',\n    data: []\n});\n`;
    default:
      throw new Error(`Unsupported Ext JS element type: ${type}`);
  }
}

module.exports = { ELEMENTS, pascalCase, makeClassName, xtypeFor, createElement };
