import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListView } from '../../src/pages/ListView';

const pairRows = Array.from(
  { length: 30 },
  (_, index) => `;臺灣詞${index};大陸詞${index}`,
);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // Suppress React 19 act() warning — known false positive with
  // createRoot + useEffect + happy-dom (effects fire after act returns)
  vi.spyOn(console, 'error').mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (typeof msg === 'string' && msg.includes('not wrapped in act')) return;
    console.error(msg, ...rest);
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => pairRows,
  })));
});

afterEach(() => {
  root.unmount();
  container.remove();
  vi.unstubAllGlobals();
});

async function renderList(lang: 'a' | 't' | 'h' | 'c', category: string): Promise<void> {
  await act(async () => {
    flushSync(() => {
      root.render(
        <MemoryRouter>
          <ListView lang={lang} category={category} />
        </MemoryRouter>,
      );
    });
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ListView cross-strait comparison table', () => {
  it('renders ordered pair cells as separate cross-strait dictionary links', async () => {
    await renderList('c', '同實異名');

    const table = container.querySelector('table[aria-label="臺灣及大陸用語對照"]');
    expect(table).not.toBeNull();
    expect(table?.querySelector('th')?.textContent).toContain('🇹🇼 臺灣用語');
    expect(table?.querySelectorAll('th')[1]?.textContent).toContain('🇨🇳 大陸用語');
    expect(table?.querySelector('a[href="/~臺灣詞0"]')?.textContent).toBe('臺灣詞0');
    expect(table?.querySelector('a[href="/~大陸詞0"]')?.textContent).toBe('大陸詞0');
    expect(container.querySelector('a[href*=";"]')).toBeNull();
  });

  it('matches a keyword in either term of a cross-strait pair', async () => {
    await renderList('c', '同實異名');
    const input = container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(input).not.toBeNull();
    const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setNativeValue.call(input!, '大陸詞29');
    await act(async () => input!.dispatchEvent(new Event('input', { bubbles: true })));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(container.textContent).toContain('臺灣詞29');

    setNativeValue.call(input!, '臺灣詞20');
    await act(async () => input!.dispatchEvent(new Event('input', { bubbles: true })));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(container.textContent).toContain('大陸詞20');
  });

  it('keeps a non-comparison category as the existing bullet list', async () => {
    await renderList('a', '近義詞');
    expect(container.querySelector('table')).toBeNull();
  });
});
