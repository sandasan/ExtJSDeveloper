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

function parseVersion(value) {
  const match = typeof value === 'string' && value.match(/\b(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? `${match[1]}.${match[2]}.${match[3] || '0'}` : undefined;
}

function detectFrameworkVersion(app, packageFiles = []) {
  const direct = parseVersion(app?.frameworkVersion);
  if (direct) return direct;
  for (const file of packageFiles) {
    const parsed = parseVersion(file?.version) || parseVersion(file?.frameworkVersion);
    if (parsed) return parsed;
  }
  return undefined;
}

module.exports = { resolveClassPath, parseVersion, detectFrameworkVersion };
