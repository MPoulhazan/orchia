import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { iconCandidatesNow, projectIcon } from '../server/projectIcon.ts';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'orchia-icon-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const ids = (root: string) => iconCandidatesNow(root).map((c) => c.id);

test('an icon written inline in the web page is found', () => {
  const root = project({ 'web/index.html': `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(SVG)}">` });
  const [icon] = iconCandidatesNow(root);
  assert.equal(icon.id, 'inline:web/index.html');
  assert.equal(icon.mime, 'image/svg+xml');
  assert.equal(icon.data?.toString(), SVG);
});

test('an inline SVG with the other quote and > inside is read whole', () => {
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32'/></svg>";
  const root = project({ 'index.html': `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${svg.replace(/</g, '%3C')}" />` });
  assert.equal(iconCandidatesNow(root)[0]?.data?.toString(), svg);
});

test('a root-relative href in a Vite page points into public/', () => {
  const root = project({
    'frontend/package.json': '{}',
    'frontend/index.html': '<link rel="shortcut icon" href="/images/mark.svg?v=2">',
    'frontend/public/images/mark.svg': SVG,
  });
  assert.equal(ids(root)[0], 'frontend/public/images/mark.svg');
});

test('the page declaration wins over a file in a usual place', () => {
  const root = project({
    'index.html': '<link rel="icon" href="brand/mark.svg">',
    'brand/mark.svg': SVG,
    'favicon.ico': 'x',
  });
  assert.deepEqual(ids(root).slice(0, 2), ['brand/mark.svg', 'favicon.ico']);
});

test('the largest icon of a web manifest is used', () => {
  const root = project({
    'public/manifest.json': JSON.stringify({ icons: [{ src: 'small.png', sizes: '48x48' }, { src: 'big.png', sizes: '512x512' }] }),
    'public/small.png': 'png',
    'public/big.png': 'png',
  });
  assert.equal(ids(root)[0], 'public/big.png');
});

test("the README's logo is found, its badges are not", () => {
  const root = project({
    'README.md': '![build](https://img.shields.io/x.svg)\n<p align="center"><img src="docs/brand/logo-wide.svg" alt="Acme logo"></p>\n# Acme',
    'docs/brand/logo-wide.svg': SVG,
  });
  assert.deepEqual(ids(root), ['docs/brand/logo-wide.svg']);
});

test('dependencies and user data are never taken for the project icon', () => {
  const root = project({
    'node_modules/some-lib/logo.svg': SVG,
    'data/logos/logo.png': 'png',
    'uploads/icon.png': 'png',
  });
  assert.deepEqual(ids(root), []);
});

test('a page pointing outside the project folder is ignored', () => {
  const root = project({ 'index.html': '<link rel="icon" href="../../../secret.svg">' });
  assert.deepEqual(ids(root), []);
});

test('hosted icons are never fetched', () => {
  const root = project({ 'index.html': '<link rel="icon" href="https://example.com/icon.svg">' });
  assert.deepEqual(ids(root), []);
});

test("the user's choice wins, and `none` means the initial only", () => {
  const root = project({ 'icon.svg': SVG, 'logo.png': 'png' });
  iconCandidatesNow(root);
  assert.equal(projectIcon(root)?.id, 'icon.svg');
  assert.equal(projectIcon(root, 'logo.png')?.id, 'logo.png');
  assert.equal(projectIcon(root, 'none'), null);
  // A choice no longer in the folder falls back to the best find.
  assert.equal(projectIcon(root, 'gone.png')?.id, 'icon.svg');
});
