// Some Node versions ship an experimental localStorage that isn't a full Web Storage
// implementation (missing `clear`, `getItem`, etc.). Install a tiny in-memory polyfill
// before any test module imports code that reads/writes `window.localStorage`.
import { beforeEach } from 'vitest';

function createStorage(): Storage {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(String(key), String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
  return storage;
}

const w = globalThis as unknown as {
  window?: unknown;
  localStorage: Storage;
  sessionStorage: Storage;
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
Object.defineProperty(w, 'localStorage', { value: createStorage(), configurable: true, writable: false });
Object.defineProperty(w, 'sessionStorage', { value: createStorage(), configurable: true, writable: false });
if (typeof (w as { window?: { localStorage?: Storage; sessionStorage?: Storage } }).window === 'object') {
  Object.defineProperty(w.window as object, 'localStorage', { value: w.localStorage, configurable: true });
  Object.defineProperty(w.window as object, 'sessionStorage', { value: w.sessionStorage, configurable: true });
}
// Enable React 19 act() — global flag checked by React's test renderer
w.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  w.localStorage.clear();
  w.sessionStorage.clear();
});
