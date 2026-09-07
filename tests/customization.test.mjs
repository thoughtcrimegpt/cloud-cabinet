import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCss } from '../src/customization.ts';

test('accepts the limited branded-surface CSS grammar and normalizes it', () => {
  assert.equal(
    validateCss(
      '.brand-surface .title, .brand-surface { color: #abc; padding: 1rem; }',
    ),
    '.brand-surface .title, .brand-surface { color: #abc; padding: 1rem; }',
  );
  assert.equal(validateCss(''), '');
});

test('rejects selectors and constructs that can escape the branded surface', () => {
  for (const css of [
    'body { color: red; }',
    '.brand-surface > .title { color: red; }',
    '.brand-surface { background-image: url(https://evil.test/x); }',
    '.brand-surface { color: red; } @import url(https://evil.test);',
    '.brand-surface { color: red; } </style><script>alert(1)</script>',
    '.brand-surface { position: fixed; }',
    '.brand-surface { color: var(--secret); }',
  ])
    assert.throws(() => validateCss(css));
});

test('rejects oversized, commented, escaped, and malformed CSS', () => {
  assert.throws(() => validateCss('a'.repeat(8001)));
  for (const css of [
    '/* comment */',
    '.brand-surface { color: red',
    '.brand-surface { color; }',
    '.brand-surface { color: 12px;',
  ])
    assert.throws(() => validateCss(css));
});
