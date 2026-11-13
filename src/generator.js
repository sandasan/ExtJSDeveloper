const ELEMENTS = [
  { id: 'view', label: 'View / component', description: 'Reusable container with xtype' },
  { id: 'panel', label: 'Panel', description: 'Basic panel with a toolbar and content' },
  { id: 'button', label: 'Button', description: 'Button with a click handler' },
  { id: 'tabPanel', label: 'Tab panel', description: 'Tabbed container with two example tabs' },
  { id: 'toolbar', label: 'Toolbar', description: 'Toolbar with common actions' },
  { id: 'menu', label: 'Menu', description: 'Menu with selectable actions' },
  { id: 'grid', label: 'Grid', description: 'Grid with columns and a local store' },
  { id: 'form', label: 'Form', description: 'Form with common fields and validation' },
  { id: 'window', label: 'Window / dialog', description: 'Floating window or dialog' },
  { id: 'controller', label: 'Controller', description: 'Controller with a sample handler' },
  { id: 'viewModel', label: 'ViewModel', description: 'View model with data and a formula' },
  { id: 'model', label: 'Model', description: 'Data model with typed fields' },
  { id: 'store', label: 'Local store', description: 'Store with in-memory sample records' },
  { id: 'ajaxStore', label: 'Ajax store', description: 'Store with an Ajax proxy and JSON reader' },
  { id: 'application', label: 'Application class', description: 'Ext.app.Application subclass' }
];

const FUNCTIONS = [
  { id: 'handler', label: 'Event handler', description: 'Click handler for a view/controller', defaultName: 'onSaveClick' },
  { id: 'storeLoad', label: 'Store load callback', description: 'Receives store, records, successful, operation', defaultName: 'onStoreLoad' },
  { id: 'validator', label: 'Field validator', description: 'Returns true or a validation message', defaultName: 'validateValue' },
  { id: 'ajaxRequest', label: 'Ajax request method', description: 'Request with success and failure callbacks', defaultName: 'loadData' },
  { id: 'lifecycle', label: 'Component lifecycle method', description: 'initComponent (Classic) or initialize (Modern)', defaultName: '' }
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
  const shortName = className.split('.').pop();
  const xtype = xtypeFor(shortName);
  const component = (extend, body, alias = xtype) => `Ext.define('${className}', {\n    extend: '${extend}',\n    xtype: '${alias}',\n${body ? `${body}\n` : ''}});\n`;
  switch (type) {
    case 'view':
      return component(modern ? 'Ext.Container' : 'Ext.container.Container', `    items: []`);
    case 'panel':
      return component(modern ? 'Ext.Panel' : 'Ext.panel.Panel', modern
        ? `    title: 'Panel',\n    padding: 12,\n    items: [{ xtype: 'button', text: 'Refresh', handler: function () {\n        // Refresh the panel content.\n    } }, { xtype: 'component', html: 'Panel content' }]`
        : `    title: 'Panel',\n    bodyPadding: 12,\n    tbar: [{\n        text: 'Refresh',\n        handler: function () {\n            // Refresh the panel content.\n        }\n    }],\n    items: [{ xtype: 'component', html: 'Panel content' }]`);
    case 'button':
      return component(modern ? 'Ext.Button' : 'Ext.button.Button', `    text: 'Save',\n    handler: function (button) {\n        Ext.Msg.alert('Action', 'Button clicked');\n    }`);
    case 'tabPanel':
      return component('Ext.tab.Panel', `    items: [{\n        title: 'First tab',\n        html: 'First tab content'\n    }, {\n        title: 'Second tab',\n        html: 'Second tab content'\n    }]`);
    case 'toolbar':
      return component(modern ? 'Ext.Toolbar' : 'Ext.toolbar.Toolbar', `    items: [{\n        text: 'Add',\n        handler: function () {\n            // Add an item.\n        }\n    }, ${modern ? "{ xtype: 'spacer' }" : "'->'"}, {\n        text: 'Refresh',\n        handler: function () {\n            // Refresh the view.\n        }\n    }]`);
    case 'menu':
      return component(modern ? 'Ext.Menu' : 'Ext.menu.Menu', `    items: [{\n        text: 'Edit',\n        handler: function () {\n            // Handle edit.\n        }\n    }, {\n        text: 'Delete',\n        handler: function () {\n            // Handle delete.\n        }\n    }]`);
    case 'grid':
      return component(modern ? 'Ext.grid.Grid' : 'Ext.grid.Panel', `    columns: [\n        { text: 'Name', dataIndex: 'name', flex: 1 },\n        { text: 'Email', dataIndex: 'email', flex: 1 }\n    ],\n    store: {\n        fields: ['name', 'email'],\n        data: [{ name: 'Alex Morgan', email: 'alex@example.com' }]\n    }`);
    case 'form':
      return component('Ext.form.Panel', modern
        ? `    padding: 12,\n    items: [{ xtype: 'textfield', name: 'name', label: 'Name', required: true },\n        { xtype: 'emailfield', name: 'email', label: 'Email', required: true },\n        {\n            xtype: 'button',\n            text: 'Save',\n            handler: function (button) {\n                var form = button.up('formpanel');\n                if (form && form.isValid()) {\n                    // Submit or process form.getValues().\n                }\n            }\n        }\n    ]`
        : `    layout: 'anchor',\n    bodyPadding: 12,\n    defaults: {\n        anchor: '100%',\n        allowBlank: false\n    },\n    items: [{ xtype: 'textfield', name: 'name', fieldLabel: 'Name' },\n        { xtype: 'textfield', name: 'email', fieldLabel: 'Email', vtype: 'email' }\n    ],\n    buttons: [{\n        text: 'Save',\n        formBind: true,\n        handler: function (button) {\n            var form = button.up('form').getForm();\n            if (form.isValid()) {\n                // Submit or process form.getValues().\n            }\n        }\n    }]`);
    case 'window':
      return component(modern ? 'Ext.Dialog' : 'Ext.window.Window', `    title: 'Details',\n    modal: true,\n    width: 500,\n    height: 300,\n    ${modern ? 'padding: 12' : "layout: 'fit'"},\n    items: [{ xtype: 'panel', html: 'Dialog content' }, {\n        xtype: 'button',\n        text: 'Close',\n        handler: function (button) { button.up('${modern ? 'dialog' : 'window'}').close(); }\n    }]`);
    case 'controller':
      return `Ext.define('${className}', {\n    extend: 'Ext.app.${major >= 5 ? 'ViewController' : 'Controller'}',\n${major >= 5 ? `    alias: 'controller.${xtype}',\n\n` : '\n'}    onSaveClick: function (button) {\n        Ext.Msg.alert('Action', 'Save clicked');\n    }\n});\n`;
    case 'viewModel':
      return `Ext.define('${className}', {\n    extend: 'Ext.app.ViewModel',\n    alias: 'viewmodel.${xtype}',\n\n    data: {\n        name: ''\n    },\n\n    formulas: {\n        greeting: function (get) {\n            return 'Hello, ' + (get('name') || 'user');\n        }\n    }\n});\n`;
    case 'model':
      return `Ext.define('${className}', {\n    extend: 'Ext.data.Model',\n\n    idProperty: 'id',\n    fields: [\n        { name: 'id', type: 'int' },\n        { name: 'name', type: 'string' },\n        { name: 'email', type: 'string' },\n        { name: 'active', type: 'boolean', defaultValue: true }\n    ]\n});\n`;
    case 'store':
      {
        const modelName = shortName.endsWith('Store') ? `${className.slice(0, -5)}Model` : `${className}Model`;
        return `Ext.define('${className}', {\n    extend: 'Ext.data.Store',\n    alias: 'store.${xtype}',\n\n    model: '${modelName}',\n    data: []\n});\n`;
      }
    case 'ajaxStore':
      {
        const modelName = shortName.endsWith('Store') ? `${className.slice(0, -5)}Model` : `${className}Model`;
        return `Ext.define('${className}', {\n    extend: 'Ext.data.Store',\n    alias: 'store.${xtype}',\n\n    model: '${modelName}',\n    autoLoad: true,\n    proxy: {\n        type: 'ajax',\n        url: '/api/items',\n        reader: {\n            type: 'json',\n            ${major >= 5 ? "rootProperty: 'data'" : "root: 'data'"}\n        }\n    }\n});\n`;
      }
    case 'application':
      return `Ext.define('${className}', {\n    extend: 'Ext.app.Application',\n\n    name: '${className.split('.')[0]}',\n\n    launch: function () {\n        // Application startup logic.\n    }\n});\n`;
    default:
      throw new Error(`Unsupported Ext JS element type: ${type}`);
  }
}

function createFunction({ type, name, toolkit = 'classic' }) {
  const methodName = type === 'lifecycle' ? (toolkit === 'modern' ? 'initialize' : 'initComponent') : name;
  let body;
  switch (type) {
    case 'handler':
      body = '        // Handle the event.\n';
      break;
    case 'storeLoad':
      body = '        if (!successful) {\n            // Handle operation.getError().\n            return;\n        }\n\n        // Process records.\n';
      break;
    case 'validator':
      body = toolkit === 'modern'
        ? '        return Boolean(value);\n'
        : "        if (!value) {\n            return 'This field is required.';\n        }\n\n        return true;\n";
      break;
    case 'ajaxRequest':
      body = "        Ext.Ajax.request({\n            url: '/api/items',\n            method: 'GET',\n            success: function (response) {\n                var result = Ext.decode(response.responseText);\n                // Process result.\n            },\n            failure: function (response) {\n                Ext.Msg.alert('Request failed', response.statusText);\n            }\n        });\n";
      break;
    case 'lifecycle':
      body = '        this.callParent(arguments);\n';
      break;
    default:
      throw new Error(`Unsupported Ext JS function type: ${type}`);
  }
  const args = { handler: 'button', storeLoad: 'store, records, successful, operation', validator: 'value', ajaxRequest: '', lifecycle: '' }[type];
  return `\n    ${methodName}: function (${args}) {\n${body}    },\n`;
}

module.exports = { ELEMENTS, FUNCTIONS, pascalCase, makeClassName, xtypeFor, createElement, createFunction };
