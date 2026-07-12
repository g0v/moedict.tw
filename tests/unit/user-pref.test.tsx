/**
 * UserPref — 方音符號聲調 (bopomofo_sandhi_t) toggle wiring.
 *
 * The localStorage key `bopomofo_sandhi_t` was introduced in bfd310a as an
 * orphaned opt-out (no UI). This test verifies the preference panel now
 * surfaces it: the control appears only on the Taiwanese route, reflects
 * the stored value, and changing it persists + reloads. Other language
 * routes must not show it (a/c/h have no derived bopomofo to toggle).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { UserPref } from '../../src/components/user-pref';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	window.localStorage.clear();
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
	vi.spyOn(console, 'error').mockImplementation((msg: unknown, ...rest: unknown[]) => {
		if (typeof msg === 'string' && msg.includes('not wrapped in act')) return;
		console.error(msg, ...rest);
	});
});

afterEach(() => {
	root.unmount();
	container.remove();
	vi.restoreAllMocks();
});

function renderPref(pathname: string): void {
	act(() => {
		flushSync(() => {
			root.render(
				<MemoryRouter initialEntries={[pathname]}>
					<UserPref />
				</MemoryRouter>,
			);
		});
	});
}

function getSandhiSelect(): HTMLSelectElement | null {
	return container.querySelector<HTMLSelectElement>('#pref-select-bopomofo_sandhi_t');
}

describe('UserPref — bopomofo_sandhi_t toggle', () => {
	it('shows the 方音符號聲調 control on the Taiwanese route (/\')', () => {
		renderPref("/'tāi-gí");

		const select = getSandhiSelect();
		expect(select).not.toBeNull();
		expect(select!.value).toBe('off'); // citation is the default per MOE spec
	});

	it('reflects a stored "off" value as the active selection', () => {
		window.localStorage.setItem('bopomofo_sandhi_t', 'off');
		renderPref("/'tāi-gí");

		const select = getSandhiSelect();
		expect(select).not.toBeNull();
		expect(select!.value).toBe('off');
	});

	it('reflects a stored "sandhi" value as the active selection', () => {
		window.localStorage.setItem('bopomofo_sandhi_t', 'sandhi');
		renderPref("/'tāi-gí");

		const select = getSandhiSelect();
		expect(select).not.toBeNull();
		expect(select!.value).toBe('sandhi');
	});

	it('persists the new value to localStorage and triggers reload on change', () => {
		renderPref("/'tāi-gí");
		const select = getSandhiSelect();
		expect(select).not.toBeNull();

		const reloadSpy = vi.fn();
		vi.stubGlobal('location', { ...window.location, reload: reloadSpy });

		act(() => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLSelectElement.prototype,
				'value',
			)?.set;
			setter!.call(select, 'sandhi');
			select!.dispatchEvent(new Event('change', { bubbles: true }));
		});

		expect(window.localStorage.getItem('bopomofo_sandhi_t')).toBe('sandhi');
		expect(reloadSpy).toHaveBeenCalled();
	});

	it('does not show the control on the Mandarin route (/)', () => {
		renderPref('/萌');
		expect(getSandhiSelect()).toBeNull();
	});

	it('does not show the control on the Hakka route (/:)', () => {
		renderPref('/:客語');
		expect(getSandhiSelect()).toBeNull();
	});

	it('does not show the control on the cross-strait route (/~)', () => {
		renderPref('/~兩岸');
		expect(getSandhiSelect()).toBeNull();
	});
});
