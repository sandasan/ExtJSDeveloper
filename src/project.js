const path = require('path');

function resolveClassPath(entry, appDir, workspaceDir, toolkit) {
  if (typeof entry !== 'string') return undefined;
  const resolved = entry
    .replaceAll('${app.dir}', appDir)
    .replaceAll('${workspace.dir}', workspaceDir || '${workspace.dir}')
    .replaceAll('${toolkit.name}', toolkit || '${toolkit.name}');
  if (/\$\{[^}]+\}/.test(resolved)) return undefined;
  return path.resolve(appDir, resolved);
}

module.exports = { resolveClassPath };
