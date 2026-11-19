/**
 * Node ≥22 exposes an experimental `localStorage` global that stays undefined
 * unless `--localstorage-file` is passed, shadowing jsdom's implementation.
 * Persistence tests need a working Storage regardless of the Node version, so
 * install an in-memory one whenever the ambient one is missing.
 */
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length(): number {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
}

for (const target of [globalThis, globalThis.window].filter(
  (t): t is typeof globalThis => t !== undefined,
)) {
  let missing = false;
  try {
    missing = !target.localStorage;
  } catch {
    missing = true;
  }
  if (missing) {
    Object.defineProperty(target, 'localStorage', {
      value: memoryStorage(),
      configurable: true,
      writable: true,
    });
  }
}

// auto-cleanup RTL after every jsdom test; dynamic imports keep the
// node-environment (pure logic) tests free of DOM dependencies
if (typeof window !== 'undefined') {
  const { afterEach } = await import('vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(cleanup);
}

export {};
