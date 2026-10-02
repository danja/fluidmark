// src/load-browser.js
//
// The browser side of loading. Kept separate from src/core.js so that nothing Node-specific is
// shipped to a browser. See docs/ffi.md.

import { createCore } from './core.js';

/** Where the build puts the module, relative to a page in `www/`. */
export const DEFAULT_WASM_URL = new URL('../build/fluidmark_core.wasm', import.meta.url);

/**
 * Fetch and instantiate the core, returning a wrapper from `createCore`.
 *
 * Prefers `instantiateStreaming`, which compiles while the bytes arrive, and falls back to
 * `arrayBuffer` for a server that serves the module without a `application/wasm` content type.
 * The fallback is not defensive padding: a wrong content type is a common deployment
 * accident and the error it produces otherwise names nothing useful.
 */
export async function loadCore(url = DEFAULT_WASM_URL) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetching the core failed: ${response.status} ${response.statusText}`);
  }
  let instance;
  if (typeof WebAssembly.instantiateStreaming === 'function') {
    try {
      ({ instance } = await WebAssembly.instantiateStreaming(response.clone()));
    } catch {
      instance = undefined;
    }
  }
  if (!instance) {
    const bytes = await response.arrayBuffer();
    ({ instance } = await WebAssembly.instantiate(bytes, {}));
  }
  return createCore(instance);
}