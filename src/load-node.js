// src/load-node.js
//
// The Node side of loading. Kept separate from src/core.js so that nothing browser-specific
// is reachable from Node and nothing Node-specific is shipped to a browser. See docs/ffi.md.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Where `npm run build` puts the module. */
export const DEFAULT_WASM_PATH = fileURLToPath(
  new URL('../build/fluidmark_core.wasm', import.meta.url),
);

/**
 * Read and instantiate the core, returning a wrapper from `createCore`.
 *
 * Instantiated rather than compiled ahead of time, so the same object works in Node and in a
 * test runner without a second code path.
 */
export async function loadCore(path = DEFAULT_WASM_PATH) {
  const bytes = await readFile(path);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const { createCore } = await import('./core.js');
  return createCore(instance);
}