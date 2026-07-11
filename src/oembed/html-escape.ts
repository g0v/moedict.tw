/**
 * Self-contained escaping for src/oembed — see types.ts for why this
 * subtree doesn't reuse src/utils/radical-page-utils' copies.
 */

export function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stripTags(input: string): string {
  return String(input ?? '').replace(/<[^>]*>/g, '').trim();
}
