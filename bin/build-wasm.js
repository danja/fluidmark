#!/usr/bin/env node
// bin/build-wasm.js
//
// Build the Rust core and put the artifacts where the hosts look for them.
//
// Two outputs, because the core is two things at once. The `.wasm` goes to build/ for the
// browser and the Node tools. The `.a` goes to build/ too, for the C++ hosts to link; it is not
// needed by anything running now, but building it here means a C++ host cannot pick up a
// stale one.
//
// One file, two ways of reaching it: docs/ffi.md.

import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const crate = `${root}wasm`;
const buildDir = `${root}build`;
const crateName = 'fluidmark_core';

function run(command, args, cwd) {
  process.stdout.write(`  ${command} ${args.join(' ')}\n`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

const profile = process.env.FLUIDMARK_PROFILE === 'debug' ? '' : '--release';
const profileDir = profile ? 'release' : 'debug';
// The native build goes to its own target directory, so it cannot clobber the Wasm build's
// artifacts: both use the same crate name, and cargo keys outputs by target triple.
const nativeDir = `${crate}/target/native-host`;
const wasmOut = `${crate}/target/wasm32-unknown-unknown/${profileDir}/${crateName}.wasm`;
const nativeOut = `${nativeDir}/${profileDir}/lib${crateName}.a`;

console.log('building the core');
run('cargo', ['build', ...(profile ? [profile] : []), '--target', 'wasm32-unknown-unknown'], crate);
run('cargo', ['build', ...(profile ? [profile] : []), '--target-dir', nativeDir], crate);

mkdirSync(buildDir, { recursive: true });

const artifacts = [
  [wasmOut, `${buildDir}/${crateName}.wasm`],
  [nativeOut, `${buildDir}/lib${crateName}.a`],
];

for (const [from, to] of artifacts) {
  if (!existsSync(from)) {
    console.error(`expected ${from} to exist after the build`);
    process.exit(1);
  }
  copyFileSync(from, to);
  const kb = (statSync(to).size / 1024).toFixed(1);
  console.log(`  ${to.replace(root, '.')}  ${kb} kB`);
}

console.log('core built');