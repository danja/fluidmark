#!/usr/bin/env node
// bin/deploy.js
//
// Put the current checkout on the live container, in one command, on the machine that runs it.
//
//   npm run deploy                      git pull, build, check, swap, check, roll back on failure
//   npm run deploy -- --no-pull         skip the pull (deploy what is checked out)
//   npm run deploy -- --name fm --port 8081
//
// The container has the site copied in at build time, so a pull changes nothing until the image
// is rebuilt and the container replaced. This does that in an order that cannot leave the site
// down because of a bad build: the new image is built and run on a spare port and checked first,
// and only if it serves does the live container get replaced.
//
// After the swap the live one is checked again, and a failure puts the previous image back. What
// it cannot check is the part that only exists on the real domain: the /fluidmark/ prefix and
// everything else the vhost serves. That is the checklist it prints at the end (docs/web.md).

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const NAME = value('name', 'fluidmark');
const PORT = value('port', '8080');
const SPARE = value('spare-port', '8099');
const IMAGE = 'fluidmark:local';
const NEXT = 'fluidmark:next';
const PREVIOUS = 'fluidmark:previous';

const run = (cmd, argv, { quiet = false, allowFail = false } = {}) => {
  try {
    return execFileSync(cmd, argv, { encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] }) ?? '';
  } catch (error) {
    if (allowFail) return null;
    throw error;
  }
};
const say = (text) => process.stdout.write(`\n== ${text}\n`);

/** Fetch a URL with curl, since Node's fetch is no better here and curl is what the docs use. */
function probe(url) {
  const out = run('curl', ['-s', '-m', '5', '-o', '/dev/null', '-w', '%{http_code} %{content_type}', url], { quiet: true, allowFail: true });
  return out ?? '000 ';
}

/** What a healthy container answers, as [path, expected status and type prefix]. */
const CHECKS = [
  ['/healthz', '200 text/plain'],
  ['/', '200 text/html'],
  ['/app.js', '200 application/javascript'],
  ['/src/load-browser.js', '200 application/javascript'],
  ['/build/fluidmark_core.wasm', '200 application/wasm'],
];

/** Poll until the container answers, because nginx takes a moment, then check every path. */
function healthy(port) {
  for (let i = 0; i < 20; i += 1) {
    if (probe(`http://127.0.0.1:${port}/healthz`).startsWith('200')) break;
    run('sleep', ['0.5'], { quiet: true });
  }
  const failures = [];
  for (const [path, expected] of CHECKS) {
    const got = probe(`http://127.0.0.1:${port}${path}`);
    if (!got.startsWith(expected)) failures.push(`${path}: wanted "${expected}", got "${got}"`);
  }
  return failures;
}

function start(name, image, port) {
  run('docker', ['rm', '-f', name], { quiet: true, allowFail: true });
  run('docker', ['run', '-d', '--name', name, '--restart', 'unless-stopped', '-p', `127.0.0.1:${port}:8080`, image], { quiet: true });
}

function main() {
  if (!flag('no-pull')) {
    say('git pull');
    run('git', ['pull', '--ff-only']);
  }

  say(`build ${NEXT}`);
  run('docker', ['build', '-t', NEXT, '.']);

  say(`try it on spare port ${SPARE}`);
  const trial = `${NAME}-trial`;
  start(trial, NEXT, SPARE);
  const trialFailures = healthy(SPARE);
  run('docker', ['rm', '-f', trial], { quiet: true, allowFail: true });
  if (trialFailures.length > 0) {
    process.stderr.write(`\nthe new image did not serve, so the live container was left alone:\n  ${trialFailures.join('\n  ')}\n`);
    return 1;
  }

  say(`replace ${NAME}`);
  // Keep what is running as a rollback target before it is overwritten.
  if (run('docker', ['image', 'inspect', IMAGE], { quiet: true, allowFail: true }) !== null) {
    run('docker', ['tag', IMAGE, PREVIOUS]);
  }
  run('docker', ['tag', NEXT, IMAGE]);
  start(NAME, IMAGE, PORT);

  const failures = healthy(PORT);
  if (failures.length > 0) {
    process.stderr.write(`\nthe live container failed its check:\n  ${failures.join('\n  ')}\n`);
    const haveOld = run('docker', ['image', 'inspect', PREVIOUS], { quiet: true, allowFail: true }) !== null;
    if (haveOld) {
      process.stderr.write('rolling back to the previous image\n');
      run('docker', ['tag', PREVIOUS, IMAGE]);
      start(NAME, IMAGE, PORT);
      process.stderr.write(healthy(PORT).length === 0 ? 'rolled back, and it serves\n' : 'rolled back, and it still fails: look at `docker logs`\n');
    } else {
      process.stderr.write('there was no previous image to go back to\n');
    }
    return 1;
  }

  say('done');
  process.stdout.write(
    `${NAME} is serving on 127.0.0.1:${PORT}. That is the container only. The prefix and the rest of the\n` +
      'domain are checked by hand: open /fluidmark/, hard-refresh, check the console for errors, and check that\n' +
      '/, /jigdaw/, /diddums/ and /api/update-feeds answer as before (docs/web.md).\n',
  );
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
