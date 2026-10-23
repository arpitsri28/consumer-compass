import assert from 'node:assert/strict';
import { test } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { markdownOptions } from '../../app/lib/markdown-options.js';

const render = (content) => renderToStaticMarkup(React.createElement(Markdown, markdownOptions, content));

test('assistant Markdown renders text structure, lists and code', () => {
  const html = render('**Rights**\n\n- Item\n\n`code`');
  assert.match(html, /<strong>Rights<\/strong>/);
  assert.match(html, /<li>Item<\/li>/);
  assert.match(html, /<code>code<\/code>/);
});

test('untrusted Markdown cannot inject HTML, scripts or unsafe link protocols', () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29)\n\n[data](data:text/html,test)');
  assert.doesNotMatch(html, /<script|<img|onerror|href="javascript:|href="data:/);
});

test('remote Markdown images are disabled while HTTPS links remain usable', () => {
  const html = render('![tracking](https://example.com/pixel)\n\n[Ontario](https://ontario.ca)');
  assert.doesNotMatch(html, /<img|src=/);
  assert.match(html, /href="https:\/\/ontario.ca"/);
});
