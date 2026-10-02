#!/usr/bin/env node
// bin/check-native-link.js
//
// Compile and run the C++ link check against the static library, so the promise in
// docs/ffi.md that C++ hosts reach the same DSP from the same source is exercised rather than
// asserted. The plugin is a later stage, but the artifact it will link is built now, and a
// static library nothing has ever linked is a promise with no check on it.
//
// Two steps on purpose, matching how a plugin build will work: build the crate, then compile
// the check and link the result. Both failing loudly matters more than being fast here.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const buildDir = `${root}build`;
const lib = `${buildDir}/libfluidmark_core.a`;
const source = `${root}wasm/tests/link_check.cpp`;
const binary = `${buildDir}/link_check`;

if (!existsSync(lib)) {
  console.error(`${lib} is missing; run npm run build first`);
  process.exit(1);
}
mkdirSync(buildDir, { recursive: true });

const compiler = process.env.CXX ?? 'g++';
const args = ['-O2', '-Wall', '-Wextra', '-o', binary, source, `-L${buildDir}`, '-lfluidmark_core', '-lm'];
console.log(`  ${compiler} ${args.join(' ')}`);
execFileSync(compiler, args, { stdio: 'inherit' });

console.log(`  ${binary}`);
const code = execFileSync(binary, { stdio: 'inherit' });
process.exit(code);