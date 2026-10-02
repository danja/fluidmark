// src/index.js
//
// The side-agnostic entry point: the wrapper and the memory helpers, with no I/O and no
// reference to either host. A Node caller gets the loader from `./node.js` and a browser
// caller from `./browser.js`, so importing this module never pulls in the wrong side.

export { ABI_VERSION_EXPECTED, check, createCore, ERRORS } from './core.js';
export { doubleOut, floatView, growMemory, isDetached, uint32Out } from './memory.js';
export { frame, frameBytesFor, unframe, crc16, bitErrors, REASONS } from './frame.js';
export { embed, extract, extractRaw, splitKey } from './watermark.js';