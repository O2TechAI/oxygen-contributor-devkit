import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { InsightTakeaway } from '../components/insight-takeaway.ts';

void test('renders developed paragraphs with bold descriptions and inline code', () => {
  const html = renderToStaticMarkup(createElement(InsightTakeaway, {
    markdown: '**Check the evidence:** Preserve the reasoning and `status: pending`.\n\n**Retain the limits:** This is still a proposal with qualifications.',
  }));
  assert.equal((html.match(/<p>/g) ?? []).length, 2);
  assert.match(html, /<strong>Check the evidence:<\/strong>/);
  assert.match(html, /<strong>Retain the limits:<\/strong>/);
  assert.match(html, /<code>status: pending<\/code>/);
  assert.doesNotMatch(html, /\*\*|<ul>|<li>/);
});

void test('keeps plain legacy text readable and excludes raw HTML and interactive children', () => {
  const plain = renderToStaticMarkup(createElement(InsightTakeaway, { markdown: 'A legacy takeaway with <TOKEN>.' }));
  assert.match(plain, /<p>A legacy takeaway with &lt;TOKEN&gt;\.<\/p>/);
  const html = renderToStaticMarkup(createElement(InsightTakeaway, {
    markdown: '**Safe description:** Read [the reference](https://example.com).\n\n<script>alert(1)</script>\n\n<button>unsafe control</button>',
  }));
  assert.match(html, /the reference/);
  assert.doesNotMatch(html, /<script|<button|<a\b|href=|alert\(1\)/);
});
