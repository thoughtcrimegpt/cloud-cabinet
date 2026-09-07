// Deliberately limited CSS grammar. No external resources, selectors outside the
// branded surface, at-rules, escapes, positioning, or script-bearing content.
const properties = new Set([
  'color',
  'background-color',
  'border-color',
  'border-width',
  'border-radius',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'padding',
  'padding-top',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'gap',
  'row-gap',
  'column-gap',
]);
export function validateCss(input: unknown): string {
  if (typeof input !== 'string' || input.length > 8000)
    throw new Error('Custom CSS must be at most 8,000 characters.');
  if (!input.trim()) return '';
  if (
    /[\\@<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input) ||
    /\/\*|\*\/|url\s*\(|expression\s*\(/i.test(input)
  )
    throw new Error(
      'CSS cannot load resources, contain comments, or use at-rules or escapes.',
    );
  let remaining = input.trim();
  const rules: string[] = [];
  while (remaining) {
    const match = /^([^{}]+)\{([^{}]*)\}\s*/.exec(remaining);
    if (!match) throw new Error('Use complete CSS rules.');
    const selectors = match[1].split(',').map((s) => s.trim());
    for (const s of selectors) {
      if (!/^\.brand-surface(?:\s+\.[a-z][a-z0-9_-]*)*$/.test(s))
        throw new Error(
          'Each selector must start with .brand-surface and may use descendant classes only.',
        );
    }
    const declarations: string[] = [];
    for (const declaration of match[2]
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const colon = declaration.indexOf(':');
      const key = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      if (colon < 1 || !properties.has(key))
        throw new Error(
          'CSS property is not supported. Use colors, borders, type size, padding, or gaps.',
        );
      if (
        !/^(?:#[a-fA-F0-9]{3,8}|[a-zA-Z]+|\d*\.?\d+(?:px|rem|em|%)?|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\))(?:\s+(?:\d*\.?\d+(?:px|rem|em|%)?))*$/.test(
          value,
        )
      )
        throw new Error(
          'Use plain colors, nonnegative lengths, or numeric values in custom CSS.',
        );
      declarations.push(`${key}: ${value}`);
    }
    rules.push(`${selectors.join(', ')} { ${declarations.join('; ')}; }`);
    remaining = remaining.slice(match[0].length).trim();
  }
  return rules.join('\n');
}
