// Split checked-in migrations without splitting trigger bodies or SQL strings.
export function migrationStatements(sql) {
  const statements = [];
  let start = 0, quote = '', lineComment = false, blockComment = false;
  let tokens = [], depth = 0, trigger = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (c === quote) { if (next === quote) i++; else quote = ''; }
      continue;
    }
    if (c === '-' && next === '-') { lineComment = true; i++; continue; }
    if (c === '/' && next === '*') { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let end = i + 1;
      while (end < sql.length && /[A-Za-z_0-9]/.test(sql[end])) end++;
      const token = sql.slice(i, end).toUpperCase();
      tokens.push(token);
      if (tokens[0] === 'CREATE' && token === 'TRIGGER') trigger = true;
      if (trigger && (token === 'BEGIN' || token === 'CASE')) depth++;
      if (trigger && token === 'END') depth--;
      i = end - 1;
      continue;
    }
    if (c === ';' && (!trigger || depth === 0)) {
      const statement = sql.slice(start, i + 1).trim();
      if (tokens.length) statements.push(statement);
      start = i + 1;
      tokens = []; trigger = false; depth = 0;
    }
  }
  if (tokens.length) statements.push(sql.slice(start).trim());
  return statements;
}
