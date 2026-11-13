function decodeString(raw) {
  return raw.replace(/\\(\\|['"`bnrtfv0])/g, (_, escaped) => ({
    '\\': '\\', "'": "'", '"': '"', '`': '`', b: '\b', n: '\n', r: '\r', t: '\t', f: '\f', v: '\v', '0': '\0'
  })[escaped]).replace(/\\x([\da-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([\da-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  const isIdStart = c => !!c && /[A-Za-z_$]/.test(c);
  const isIdPart = c => !!c && /[\w$]/.test(c);
  const push = (type, value, start, end, valueStart = start, valueEnd = end) => {
    const token = { type, value, start, end, valueStart, valueEnd };
    tokens.push(token);
    return token;
  };
  const regexMayStart = () => {
    const previous = tokens[tokens.length - 1];
    if (!previous) return true;
    if (previous.type === 'identifier') return /^(return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else|do)$/.test(previous.value);
    return previous.type === 'punct' && '([{=,:;!&|?+-*%^~<>'.includes(previous.value);
  };

  while (i < source.length) {
    const c = source[i], next = source[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(source.length, i + 2);
      continue;
    }
    if (c === '/' && regexMayStart()) {
      i++;
      let inClass = false, escaped = false;
      while (i < source.length) {
        const current = source[i++];
        if (escaped) { escaped = false; continue; }
        if (current === '\\') { escaped = true; continue; }
        if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) break;
        else if (current === '\n') break;
      }
      while (/[A-Za-z]/.test(source[i] || '')) i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = i, quote = c, valueStart = ++i;
      let escaped = false;
      while (i < source.length) {
        const current = source[i];
        if (escaped) { escaped = false; i++; continue; }
        if (current === '\\') { escaped = true; i++; continue; }
        if (current === quote) break;
        i++;
      }
      const raw = source.slice(valueStart, i);
      const closed = source[i] === quote;
      if (closed) i++;
      const isDynamicTemplate = quote === '`' && /\$\{/.test(raw);
      push(isDynamicTemplate ? 'template' : 'string', isDynamicTemplate ? raw : decodeString(raw), start, i, valueStart, closed ? i - 1 : i);
      continue;
    }
    if (isIdStart(c)) {
      const start = i++;
      while (isIdPart(source[i])) i++;
      push('identifier', source.slice(start, i), start, i);
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i++;
      while (/[\w.]/.test(source[i] || '')) i++;
      push('number', source.slice(start, i), start, i);
      continue;
    }
    push('punct', c, i, i + 1);
    i++;
  }
  return tokens;
}

function matchingToken(tokens, openIndex) {
  const closingFor = { '{': '}', '[': ']', '(': ')' };
  const stack = [];
  for (let i = openIndex; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (closingFor[value]) stack.push(closingFor[value]);
    else if (value === '}' || value === ']' || value === ')') {
      if (stack.pop() !== value) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

function objectProperties(tokens, openIndex) {
  const closeIndex = matchingToken(tokens, openIndex);
  if (closeIndex < 0) return [];
  const properties = [];
  const addProperty = (start, end) => {
    const first = tokens[start], second = tokens[start + 1];
    if ((first?.type === 'identifier' || first?.type === 'string') && second?.value === ':') {
      properties.push({ key: first.value, value: tokens.slice(start + 2, end), valueStart: start + 2, valueEnd: end });
    }
  };
  let segmentStart = openIndex + 1;
  let i = segmentStart;
  while (i <= closeIndex) {
    if (i === closeIndex) {
      addProperty(segmentStart, closeIndex);
      break;
    }
    if (tokens[i].value === ',' && i === segmentStart) {
      i++;
      segmentStart = i;
      continue;
    }
    const value = tokens[i].value;
    if (value === '{' || value === '[' || value === '(') {
      const match = matchingToken(tokens, i);
      if (match < 0) return properties;
      i = match + 1;
      continue;
    }
    if (value === ',' && i < closeIndex) {
      addProperty(segmentStart, i);
      segmentStart = ++i;
      continue;
    }
    i++;
  }
  return properties;
}

function staticStringValue(tokens) {
  if (!tokens.length || tokens[0].type !== 'string') return undefined;
  let value = tokens[0].value;
  for (let i = 1; i < tokens.length; i += 2) {
    if (tokens[i]?.value !== '+' || tokens[i + 1]?.type !== 'string') return undefined;
    value += tokens[i + 1].value;
  }
  return value;
}

function staticStringValues(tokens) {
  if (tokens[0]?.value !== '[') {
    const value = staticStringValue(tokens);
    return value === undefined ? [] : [value];
  }
  const closeIndex = matchingToken(tokens, 0);
  if (closeIndex !== tokens.length - 1) return [];
  const values = [];
  let segmentStart = 1;
  for (let i = 1; i <= closeIndex; i++) {
    if (i < closeIndex && ['{', '[', '('].includes(tokens[i].value)) {
      const nestedClose = matchingToken(tokens, i);
      if (nestedClose < 0) return values;
      i = nestedClose;
      continue;
    }
    if (i === closeIndex || tokens[i].value === ',') {
      const value = staticStringValue(tokens.slice(segmentStart, i));
      if (value !== undefined) values.push(value);
      segmentStart = i + 1;
    }
  }
  return values;
}

function scanFile(text, uri) {
  const tokens = tokenize(text);
  const declarations = [];
  for (let i = 0; i < tokens.length; i++) {
    let nameIndex = -1, objectIndex = -1;
    if (tokens[i].value === 'Ext' && tokens[i + 1]?.value === '.' && tokens[i + 2]?.value === 'define' &&
        tokens[i + 3]?.value === '(' && tokens[i + 4]?.type === 'string' && tokens[i + 5]?.value === ',') {
      nameIndex = i + 4;
      objectIndex = i + 6;
    } else if (tokens[i].value === 'Ext' && tokens[i + 1]?.value === '.' && tokens[i + 2]?.value === 'ClassManager' &&
        tokens[i + 3]?.value === '.' && ['create', 'set'].includes(tokens[i + 4]?.value) && tokens[i + 5]?.value === '(' &&
        tokens[i + 6]?.type === 'string' && tokens[i + 7]?.value === ',') {
      nameIndex = i + 6;
      objectIndex = i + 8;
    }
    if (nameIndex < 0) continue;

    const properties = tokens[objectIndex]?.value === '{' ? objectProperties(tokens, objectIndex) : [];
    const aliasesForClass = [];
    const dependencies = [];
    for (const property of properties) {
      if (property.key === 'alias') {
        aliasesForClass.push(...staticStringValues(property.value));
      }
      if (property.key === 'xtype') {
        const xtype = staticStringValue(property.value);
        if (xtype !== undefined) aliasesForClass.push(`widget.${xtype}`);
      }
      const dependencyKind = ({
        extend: 'extends', requires: 'requires', uses: 'uses', mixins: 'mixins',
        controller: 'controller', viewModel: 'viewModel'
      })[property.key];
      if (dependencyKind) {
        for (const dependency of property.value) {
          if (dependency.type === 'string' && dependency.value) dependencies.push({ name: dependency.value, kind: dependencyKind });
        }
      }
    }
    const nameToken = tokens[nameIndex];
    declarations.push({
      name: nameToken.value,
      aliases: [...new Set(aliasesForClass)],
      dependencies: dependencies.filter((dependency, index, all) => all.findIndex(candidate => candidate.name === dependency.name && candidate.kind === dependency.kind) === index),
      uri,
      offset: nameToken.valueStart,
      nameEnd: nameToken.valueEnd
    });
  }
  return { declarations, tokens };
}

function propertyAt(tokens, index) {
  let innermostOpen = -1, containingProperty;
  for (let i = 0; i < index; i++) {
    if (tokens[i].value !== '{') continue;
    const closeIndex = matchingToken(tokens, i);
    if (closeIndex <= index || i < innermostOpen) continue;
    const property = objectProperties(tokens, i).find(candidate => candidate.valueStart <= index && index < candidate.valueEnd);
    if (property) {
      innermostOpen = i;
      containingProperty = property;
    }
  }
  return containingProperty;
}

function isXtypeValue(tokens, index) {
  const property = propertyAt(tokens, index);
  if (property?.key === 'xtype') return true;
  return tokens[index - 1]?.value === '(' && tokens[index - 2]?.value === 'widget' && tokens[index - 3]?.value === '.';
}

function findReferenceTokens(target, tokens, fileUri, includeDeclaration = false) {
  const targetAliases = new Set(target.aliases);
  const widgetXtypes = [...targetAliases].filter(alias => alias.startsWith('widget.')).map(alias => alias.slice('widget.'.length));
  const references = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let matches = token.type === 'string' && token.value === target.name;
    if (!matches && token.type === 'string' && targetAliases.has(token.value)) {
      matches = propertyAt(tokens, i)?.key === 'alias';
    }
    if (!matches && token.type === 'string' && widgetXtypes.includes(token.value)) matches = isXtypeValue(tokens, i);
    if (matches && !includeDeclaration && fileUri === target.uri && token.valueStart === target.offset) continue;
    if (token.type === 'identifier') {
      let expression = token.value, j = i;
      while (tokens[j + 1]?.value === '.' && tokens[j + 2]?.type === 'identifier') {
        expression += `.${tokens[j + 2].value}`;
        j += 2;
      }
      if (expression === target.name) matches = true;
    }
    if (matches) references.push(token);
  }
  return references;
}

module.exports = { tokenize, scanFile, findReferenceTokens };
