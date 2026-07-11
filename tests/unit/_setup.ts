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

// happy-dom does not implement ElementInternals / attachInternals, but
// @m3e/web form-associated custom elements (m3e-icon-button, m3e-button, …)
// call attachInternals() during click / form-submitter event handling.
// Install a minimal stub so unit tests can exercise React onClick handlers.
type ElementInternalsStub = {
  form: HTMLFormElement | null;
  labels: NodeListOf<HTMLLabelElement>;
  states: Set<string>;
  willValidate: boolean;
  validity: ValidityState;
  validationMessage: string;
  role: string | null;
  ariaLabel: string | null;
  setFormValue: (value: File | string | FormData | null, state?: File | string | FormData | null) => void;
  setValidity: (flags?: ValidityStateFlags, message?: string, anchor?: HTMLElement) => void;
  checkValidity: () => boolean;
  reportValidity: () => boolean;
};

function createElementInternalsStub(element: HTMLElement): ElementInternalsStub {
  const emptyLabels = document.createDocumentFragment().querySelectorAll('label') as NodeListOf<HTMLLabelElement>;
  const validity = {
    valueMissing: false,
    typeMismatch: false,
    patternMismatch: false,
    tooLong: false,
    tooShort: false,
    rangeUnderflow: false,
    rangeOverflow: false,
    stepMismatch: false,
    badInput: false,
    customError: false,
    valid: true,
  } as ValidityState;
  return {
    form: element.closest('form'),
    labels: emptyLabels,
    states: new Set<string>(),
    willValidate: false,
    validity,
    validationMessage: '',
    role: null,
    ariaLabel: null,
    setFormValue() {},
    setValidity() {},
    checkValidity() {
      return true;
    },
    reportValidity() {
      return true;
    },
  };
}

const elementInternalsByHost = new WeakMap<HTMLElement, ElementInternalsStub>();
const htmlElementProto = HTMLElement.prototype as HTMLElement & {
  attachInternals?: () => ElementInternals;
};
if (typeof htmlElementProto.attachInternals !== 'function') {
  htmlElementProto.attachInternals = function attachInternals(this: HTMLElement): ElementInternals {
    let internals = elementInternalsByHost.get(this);
    if (!internals) {
      internals = createElementInternalsStub(this);
      elementInternalsByHost.set(this, internals);
    }
    return internals as unknown as ElementInternals;
  };
}

beforeEach(() => {
  w.localStorage.clear();
  w.sessionStorage.clear();
});
