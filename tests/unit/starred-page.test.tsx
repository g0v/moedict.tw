/**
 * Regression for issue #217: star toggle buttons in the recent-words
 * (history) section of the 字詞紀錄簿 page, replacing the bullet dots.
 * Also verifies the starred section shows filled stars.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StarredPage } from '../../src/pages/StarredPage';
import { addStarWord, addToLRU } from '../../src/utils/word-record-utils';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // Suppress React 19 act() warning — known false positive with
  // createRoot + useEffect + happy-dom (effects fire after act returns)
  const originalConsoleError = console.error.bind(console);
  vi.spyOn(console, 'error').mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (typeof msg === 'string' && msg.includes('not wrapped in act')) return;
    originalConsoleError(msg, ...rest);
  });
});

afterEach(() => {
  root.unmount();
  container.remove();
});

function renderPage(lang: 'a' | 't' | 'h' | 'c' = 'a'): void {
  act(() => {
    flushSync(() => {
      root.render(
        <MemoryRouter>
          <StarredPage lang={lang} />
        </MemoryRouter>,
      );
    });
  });
}

function clickEl(el: HTMLElement): void {
  act(() => {
    el.click();
  });
}

describe('StarredPage — star toggle in history (#217)', () => {
  it('renders star buttons instead of bullet dots in the recent section', () => {
    addToLRU('測試', 'a');
    renderPage('a');

    const recent = container.querySelector('.recent-section');
    expect(recent).toBeTruthy();

    const starButtons = recent!.querySelectorAll('m3e-icon-button.btn-star-word, .btn-star-word');
    expect(starButtons.length).toBe(1);

    // No leftover bullet <span>·</span> elements
    const bulletSpans = recent!.querySelectorAll('span');
    expect(bulletSpans.length).toBe(0);
  });

  it('shows empty-star aria-label for non-starred recent words', () => {
    addToLRU('未收藏', 'a');
    renderPage('a');

    const btn = container.querySelector<HTMLElement>('.recent-section m3e-icon-button.btn-star-word, .recent-section .btn-star-word');
    expect(btn).toBeTruthy();
    expect(btn!.getAttribute('aria-label')).toContain('收藏');
    expect(btn!.getAttribute('aria-label')).not.toContain('取消');
  });

  it('shows filled-star aria-label for recent words that are also starred', () => {
    addStarWord('a', '已收藏');
    addToLRU('已收藏', 'a');
    renderPage('a');

    const btn = container.querySelector<HTMLElement>('.recent-section m3e-icon-button.btn-star-word, .recent-section .btn-star-word');
    expect(btn).toBeTruthy();
    expect(btn!.getAttribute('aria-label')).toContain('取消收藏');
  });

  it('toggling star from recent section adds word to starred section', () => {
    addToLRU('可收藏', 'a');
    renderPage('a');

    // Initially not starred
    let btn = container.querySelector<HTMLElement>('.recent-section m3e-icon-button.btn-star-word, .recent-section .btn-star-word');
    expect(btn!.getAttribute('aria-label')).toContain('收藏');
    expect(btn!.getAttribute('aria-label')).not.toContain('取消');

    // Starred section should be empty (only the guidance <p>)
    expect(container.querySelectorAll('.starred-section .word-list a').length).toBe(0);

    // Click to star
    clickEl(btn!);

    // Word should now appear in the starred section
    const starredLinks = container.querySelectorAll('.starred-section .word-list a');
    expect(starredLinks.length).toBe(1);
    expect(starredLinks[0].textContent).toBe('可收藏');

    // Recent section star should now show "取消收藏"
    btn = container.querySelector<HTMLElement>('.recent-section m3e-icon-button.btn-star-word, .recent-section .btn-star-word');
    expect(btn!.getAttribute('aria-label')).toContain('取消收藏');
  });

  it('toggling star from recent section removes word from starred section', () => {
    addStarWord('a', '雙重');
    addToLRU('雙重', 'a');
    renderPage('a');

    // Initially starred
    let btn = container.querySelector<HTMLElement>('.recent-section m3e-icon-button.btn-star-word, .recent-section .btn-star-word');
    expect(btn!.getAttribute('aria-label')).toContain('取消收藏');
    expect(container.querySelectorAll('.starred-section .word-list a').length).toBe(1);

    // Click to unstar
    clickEl(btn!);

    // Starred section should now be empty
    expect(container.querySelectorAll('.starred-section .word-list a').length).toBe(0);

    // Recent section star should now show "收藏"
    btn = container.querySelector<HTMLElement>('.recent-section m3e-icon-button.btn-star-word, .recent-section .btn-star-word');
    expect(btn!.getAttribute('aria-label')).toContain('收藏');
    expect(btn!.getAttribute('aria-label')).not.toContain('取消');
  });

  it('renders filled star buttons in the starred section', () => {
    addStarWord('a', '已星');
    renderPage('a');

    const starred = container.querySelector('.starred-section');
    const starButtons = starred!.querySelectorAll('m3e-icon-button.btn-star-word, .btn-star-word');
    expect(starButtons.length).toBe(1);
    expect(starButtons[0].getAttribute('aria-label')).toContain('取消收藏');
  });

  it('clicking star in starred section removes the word', () => {
    addStarWord('a', '消失');
    renderPage('a');

    expect(container.querySelectorAll('.starred-section .word-list a').length).toBe(1);

    const btn = container.querySelector<HTMLElement>('.starred-section m3e-icon-button.btn-star-word, .starred-section .btn-star-word');
    clickEl(btn!);

    expect(container.querySelectorAll('.starred-section .word-list a').length).toBe(0);
  });

  it('keeps the remove-from-history button separate from the star toggle', () => {
    addToLRU('保留', 'a');
    renderPage('a');

    const recent = container.querySelector('.recent-section');
    const starBtns = recent!.querySelectorAll('m3e-icon-button.btn-star-word, .btn-star-word');
    const removeBtns = recent!.querySelectorAll('m3e-icon-button.btn-remove-word, .btn-remove-word');
    expect(starBtns.length).toBe(1);
    expect(removeBtns.length).toBe(1);
    // Star is before the link, remove is after
    const starBtn = starBtns[0] as HTMLElement;
    const removeBtn = removeBtns[0] as HTMLElement;
    const link = recent!.querySelector('a')!;
    expect(starBtn.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(removeBtn.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});