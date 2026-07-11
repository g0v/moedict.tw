/**
 * Direct-call tests for src/oembed/html-escape.ts — the self-contained
 * escaping used across the oEmbed subtree (see types.ts for why it isn't
 * shared with src/utils/radical-page-utils.ts).
 */

import { describe, expect, it } from 'vitest';
import { escapeHtml, stripTags } from '../../src/oembed/html-escape';

describe('escapeHtml', () => {
  it('coerces null/undefined to empty string', () => {
    expect(escapeHtml(null as unknown as string)).toBe('');
    expect(escapeHtml(undefined as unknown as string)).toBe('');
  });

  it('escapes &, <, >, ", and \'', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});

describe('stripTags', () => {
  it('coerces null/undefined to empty string', () => {
    expect(stripTags(null as unknown as string)).toBe('');
    expect(stripTags(undefined as unknown as string)).toBe('');
  });

  it('removes tags and trims surrounding whitespace', () => {
    expect(stripTags('  <b>hi</b>  ')).toBe('hi');
  });
});
