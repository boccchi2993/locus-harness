// Consumer preview launcher (test/ci-port-chrome-readiness): starts the
// consumer's vite preview through the shared EADDRINUSE port-retry
// (startServiceWithRetry in ./chrome-helper.cjs — the same helper the gate
// drivers use), waits for readiness, then writes the resolved URL to
// consumer-server.json next to this file. CI runs it in the background;
// the gate drivers fall back to that JSON when CONSUMER_URL /
// CONSUMER_FAULTS_URL are unset, so a retried port flows everywhere.
// Retry exhaustion exits nonzero with the complete "ports tried" error and
// no JSON — the serve step then fails before any gate runs.
// Run: node tests/serve-consumer.cjs   (background; CONSUMER_PREVIEW_PORT
// overrides the initial port, default 4931)
const fs = require('fs');
const path = require('path');
const {
  closeManagedProcess, isProcessAlive, launchManagedProcess,
  startServiceWithRetry, waitForHttp,
} = require('./chrome-helper.cjs');

const INITIAL_PORT = Number(process.env.CONSUMER_PREVIEW_PORT || 4931);
const OUT_PATH = path.join(__dirname, 'consumer-server.json');

async function main() {
  try { fs.rmSync(OUT_PATH, { force: true }); } catch (e) {}
  let service;
  try {
    service = await startServiceWithRetry(async (port) => {
      const child = launchManagedProcess(process.execPath, [
        require.resolve('vite/bin/vite.js'),
        'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort',
      ], { cwd: path.dirname(__dirname), port, label: 'vite preview (consumer)' });
      try {
        await waitForHttp('http://127.0.0.1:' + port + '/', { process: child, timeoutMs: 20000 });
      } catch (e) {
        // Retry ONLY the bind race: the child died with EADDRINUSE in its
        // output. Any other readiness failure is rethrown untouched.
        const raced = !isProcessAlive(child)
          && /EADDRINUSE|address already in use/.test(child.stderrTail + '\n' + child.stdoutTail);
        await closeManagedProcess(child);
        if (raced) {
          const bindError = new Error('vite preview could not bind port ' + port + ' (EADDRINUSE)');
          bindError.code = 'EADDRINUSE';
          throw bindError;
        }
        throw e;
      }
      return child;
    }, INITIAL_PORT);
  } catch (error) {
    console.error('CONSUMER-PREVIEW ERROR:', error && error.stack || error);
    process.exit(1);
  }
  const url = 'http://127.0.0.1:' + service.port + '/';
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    url,
    port: service.port,
    portsTried: service.portsTried,
  }, null, 2) + '\n');
  console.log('consumer preview on ' + url + ' (ports tried: ' + service.portsTried.join(', ') + ')');
  // Stay attached: the launcher exits when the preview child does, so a
  // dead server shows up in the job log instead of dying silently.
  const child = service.handle;
  await new Promise((resolve) => child.child.once('exit', resolve));
  console.log('consumer preview exited (exitCode=' + child.exitCode + ' signal=' + child.signal + ')');
}

main();
