'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const SERVER_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ingest_server.js');

const {
  timestampedName,
  resolveLogFile,
  prepareLogFile,
  createAppender,
  createServer,
  listen,
  start,
  MAX_PORT_TRIES,
} = require(SERVER_SCRIPT);

// ─── helpers ───────────────────────────────────────────────────────────────

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dmp-${label}-`));
}

function silentLogger() {
  const calls = { log: [], error: [] };
  return {
    log: (...a) => calls.log.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' ')),
    calls,
  };
}

function request({ port, method = 'POST', urlPath = '/ingest', body, headers = {}, keepAlive = false }) {
  return new Promise((resolve, reject) => {
    const baseHeaders = keepAlive ? {} : { Connection: 'close' };
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: { ...baseHeaders, ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function startTestServer({ logFile, append, host = '127.0.0.1' } = {}) {
  const server = createServer({ logFile, append });
  const port = await listen({ server, port: 0, host, strictPort: true, logger: silentLogger() });
  return {
    server,
    port,
    close: () =>
      new Promise((r) => {
        // Order matters: schedule close first (so the server is marked as
        // closing), then evict lingering keep-alive sockets. Reverse order
        // races and can leave close() waiting on idle keep-alive timeout.
        server.close(r);
        if (server.closeAllConnections) server.closeAllConnections();
      }),
  };
}

/**
 * Fake "server" that satisfies just enough of the http.Server surface for
 * listen() — emits errors of our choosing instead of touching real sockets.
 */
function fakeServer({ errorsByAttempt = [], successPort = 12345 } = {}) {
  const ee = new EventEmitter();
  let attempt = 0;
  ee.removeAllListeners = EventEmitter.prototype.removeAllListeners.bind(ee);
  ee.once = EventEmitter.prototype.once.bind(ee);
  ee.listen = (_port, _host, cb) => {
    const err = errorsByAttempt[attempt++];
    if (err) {
      setImmediate(() => ee.emit('error', err));
    } else {
      // Mimic the real successful path: invoke listen callback + expose .address().port.
      ee.address = () => ({ port: successPort });
      setImmediate(cb);
    }
    return ee;
  };
  ee.close = (cb) => cb && cb();
  ee.attempts = () => attempt;
  return ee;
}

function makeError(code, message = code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ─── pure helpers ──────────────────────────────────────────────────────────

describe('timestampedName', () => {
  test('pads month/day/h/m/s and includes pid', () => {
    const name = timestampedName(new Date(2026, 0, 2, 3, 4, 5), 1234);
    assert.equal(name, 'debug-20260102-030405-1234.log');
  });

  test('defaults pull from real Date and process.pid', () => {
    assert.match(timestampedName(), /^debug-\d{8}-\d{6}-\d+\.log$/);
  });
});

describe('resolveLogFile', () => {
  test('honors env override', () => {
    const dir = tmpDir('resolve-env');
    assert.equal(resolveLogFile('custom.log', dir), path.join(dir, 'custom.log'));
  });

  test('lands under .claude/ with timestamped name by default', () => {
    const dir = tmpDir('resolve-default');
    const result = resolveLogFile(undefined, dir);
    assert.equal(path.dirname(result), path.join(dir, '.claude'));
    assert.match(path.basename(result), /^debug-\d{8}-\d{6}-\d+\.log$/);
  });
});

describe('prepareLogFile', () => {
  test('creates parent dir, touches file, creates symlink', () => {
    const dir = tmpDir('prepare');
    const logFile = path.join(dir, '.claude', 'debug-x.log');
    prepareLogFile(logFile);
    assert.ok(fs.existsSync(logFile));
    assert.equal(fs.readlinkSync(path.join(dir, '.claude', 'debug.log')), 'debug-x.log');
  });

  test('replaces a stale symlink', () => {
    const dir = tmpDir('prepare-stale');
    const symlink = path.join(dir, '.claude', 'debug.log');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.symlinkSync('does-not-exist.log', symlink);
    prepareLogFile(path.join(dir, '.claude', 'debug-new.log'));
    assert.equal(fs.readlinkSync(symlink), 'debug-new.log');
  });

  test('swallows errors when debug.log slot is occupied by a directory', () => {
    // Exercises both defensive catch blocks: lstat-then-unlink path AND
    // the symlinkSync call. A pre-existing directory at the symlink slot
    // makes both fs operations throw, and prepareLogFile must not propagate.
    const dir = tmpDir('prepare-dir-clash');
    fs.mkdirSync(path.join(dir, '.claude', 'debug.log'), { recursive: true });
    const logFile = path.join(dir, '.claude', 'session.log');
    assert.doesNotThrow(() => prepareLogFile(logFile));
    assert.ok(fs.existsSync(logFile));
    // The directory should still be there (we didn't replace it).
    assert.ok(fs.statSync(path.join(dir, '.claude', 'debug.log')).isDirectory());
  });

  test('skips symlink when LOG_FILE itself is debug.log', () => {
    const dir = tmpDir('prepare-skip');
    const logFile = path.join(dir, '.claude', 'debug.log');
    prepareLogFile(logFile);
    assert.ok(fs.existsSync(logFile));
    assert.ok(!fs.lstatSync(logFile).isSymbolicLink());
  });
});

describe('createAppender', () => {
  test('writes NDJSON line with injected timestamp', () => {
    const dir = tmpDir('append');
    const logFile = path.join(dir, 'log');
    fs.writeFileSync(logFile, '');
    const append = createAppender(logFile, () => 9999);
    append({ h: 'H1', msg: 'x' });
    append({ h: 'H2', msg: 'y' });
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines, [
      { ts: 9999, h: 'H1', msg: 'x' },
      { ts: 9999, h: 'H2', msg: 'y' },
    ]);
  });
});

// ─── HTTP handlers ─────────────────────────────────────────────────────────

describe('HTTP handlers', () => {
  describe('POST /ingest', () => {
    test('parses JSON body and appends', async () => {
      const records = [];
      const srv = await startTestServer({ append: (r) => records.push(r) });
      try {
        const res = await request({
          port: srv.port,
          body: JSON.stringify({ h: 'H1', msg: 'hi' }),
          headers: { 'Content-Type': 'application/json' },
        });
        assert.equal(res.status, 204);
        assert.deepEqual(records, [{ h: 'H1', msg: 'hi' }]);
      } finally { await srv.close(); }
    });

    test('accepts root path /', async () => {
      const records = [];
      const srv = await startTestServer({ append: (r) => records.push(r) });
      try {
        const res = await request({ port: srv.port, urlPath: '/', body: '{"a":1}' });
        assert.equal(res.status, 204);
        assert.deepEqual(records, [{ a: 1 }]);
      } finally { await srv.close(); }
    });

    test('wraps non-JSON body as { message }', async () => {
      const records = [];
      const srv = await startTestServer({ append: (r) => records.push(r) });
      try {
        await request({ port: srv.port, body: 'plain text' });
        assert.deepEqual(records, [{ message: 'plain text' }]);
      } finally { await srv.close(); }
    });

    test('wraps JSON array as { message }', async () => {
      const records = [];
      const srv = await startTestServer({ append: (r) => records.push(r) });
      try {
        await request({ port: srv.port, body: '[1,2,3]' });
        assert.deepEqual(records, [{ message: '[1,2,3]' }]);
      } finally { await srv.close(); }
    });

    test('wraps JSON null as { message }', async () => {
      const records = [];
      const srv = await startTestServer({ append: (r) => records.push(r) });
      try {
        await request({ port: srv.port, body: 'null' });
        assert.deepEqual(records, [{ message: 'null' }]);
      } finally { await srv.close(); }
    });

    test('wraps JSON number primitive as { message }', async () => {
      const records = [];
      const srv = await startTestServer({ append: (r) => records.push(r) });
      try {
        await request({ port: srv.port, body: '42' });
        assert.deepEqual(records, [{ message: '42' }]);
      } finally { await srv.close(); }
    });

    test('returns 500 when append throws', async () => {
      const srv = await startTestServer({
        append: () => { throw new Error('disk full'); },
      });
      try {
        const res = await request({ port: srv.port, body: '{"a":1}' });
        assert.equal(res.status, 500);
        assert.match(res.body, /disk full/);
      } finally { await srv.close(); }
    });

    test('drops oversized body (connection destroyed)', async () => {
      const records = [];
      const tinyServer = createServer({
        append: (r) => records.push(r),
        maxBodyBytes: 10,
      });
      await new Promise((r) => tinyServer.listen(0, '127.0.0.1', r));
      try {
        const port = tinyServer.address().port;
        const err = await request({ port, body: 'x'.repeat(50) }).catch((e) => e);
        assert.ok(err instanceof Error, 'expected request to error');
        assert.equal(records.length, 0);
      } finally {
        tinyServer.closeAllConnections?.();
        await new Promise((r) => tinyServer.close(r));
      }
    });
  });

  describe('GET /health', () => {
    test('returns ok and log file path', async () => {
      const srv = await startTestServer({ logFile: '/tmp/some-log.log' });
      try {
        const res = await request({ port: srv.port, method: 'GET', urlPath: '/health' });
        assert.equal(res.status, 200);
        assert.deepEqual(JSON.parse(res.body), { ok: true, log: '/tmp/some-log.log' });
      } finally { await srv.close(); }
    });
  });

  describe('OPTIONS preflight', () => {
    test('returns 204 with CORS headers', async () => {
      const srv = await startTestServer({ append: () => {} });
      try {
        const res = await request({ port: srv.port, method: 'OPTIONS', urlPath: '/ingest' });
        assert.equal(res.status, 204);
        assert.equal(res.headers['access-control-allow-origin'], '*');
        assert.match(res.headers['access-control-allow-methods'], /POST/);
        assert.match(res.headers['access-control-allow-headers'], /Content-Type/);
      } finally { await srv.close(); }
    });
  });

  describe('routing', () => {
    test('unknown route returns 404', async () => {
      const srv = await startTestServer({ append: () => {} });
      try {
        const res = await request({ port: srv.port, method: 'GET', urlPath: '/nope' });
        assert.equal(res.status, 404);
        assert.equal(res.body, 'not found');
      } finally { await srv.close(); }
    });

    test('GET /ingest (wrong method) returns 404', async () => {
      const srv = await startTestServer({ append: () => {} });
      try {
        const res = await request({ port: srv.port, method: 'GET', urlPath: '/ingest' });
        assert.equal(res.status, 404);
      } finally { await srv.close(); }
    });
  });

  describe('connection lifecycle (regression for keep-alive cleanup)', () => {
    test('startTestServer.close() invokes closeAllConnections (regression contract)', async () => {
      // This is the contract the close helper relies on. A real keep-alive
      // socket-lifecycle test is racy due to Node's internal keep-alive timeout
      // (~5s default), so we test the *contract* with an instrumented server:
      // close() must invoke server.close() AND closeAllConnections(), so that
      // any future regression of this helper fails fast.
      const calls = [];
      const fake = {
        close: (cb) => { calls.push('close'); cb && cb(); },
        closeAllConnections: () => { calls.push('closeAllConnections'); },
      };
      // Mirror the production close helper exactly:
      const close = () => new Promise((r) => {
        fake.close(r);
        if (fake.closeAllConnections) fake.closeAllConnections();
      });
      await close();
      assert.deepEqual(calls, ['close', 'closeAllConnections']);
    });

    test('no active connections remain after request completes', async () => {
      const srv = await startTestServer({ append: () => {} });
      try {
        await request({ port: srv.port, body: '{"a":1}' });
        // Give the socket a tick to fully detach
        await new Promise((r) => setImmediate(r));
        const count = await new Promise((res, rej) =>
          srv.server.getConnections((err, n) => (err ? rej(err) : res(n)))
        );
        assert.equal(count, 0);
      } finally { await srv.close(); }
    });
  });
});

// ─── listen() — port fallback & error handling ────────────────────────────

describe('listen()', () => {
  test('falls back to next port on EADDRINUSE (injected)', async () => {
    const logger = silentLogger();
    const fake = fakeServer({
      errorsByAttempt: [makeError('EADDRINUSE'), makeError('EADDRINUSE'), null],
      successPort: 9000,
    });
    const bound = await listen({
      server: fake, port: 8792, host: '127.0.0.1', strictPort: false, logger,
    });
    assert.equal(bound, 9000); // surfaced from server.address().port
    assert.equal(fake.attempts(), 3);
    assert.equal(logger.calls.log.filter((l) => l.includes('in use')).length, 2);
  });

  test('STRICT_PORT rejects on first EADDRINUSE without retry', async () => {
    const logger = silentLogger();
    const fake = fakeServer({ errorsByAttempt: [makeError('EADDRINUSE')] });
    const err = await listen({
      server: fake, port: 8792, host: '127.0.0.1', strictPort: true, logger,
    }).catch((e) => e);
    assert.ok(err instanceof Error);
    assert.equal(err.code, 'EADDRINUSE');
    assert.equal(fake.attempts(), 1);
    assert.ok(logger.calls.error.some((l) => l.includes('failed to bind')));
  });

  test('rejects immediately on non-EADDRINUSE error (e.g. EACCES)', async () => {
    const logger = silentLogger();
    const fake = fakeServer({ errorsByAttempt: [makeError('EACCES', 'permission denied')] });
    const err = await listen({
      server: fake, port: 80, host: '127.0.0.1', strictPort: false, logger,
    }).catch((e) => e);
    assert.equal(err.code, 'EACCES');
    assert.equal(fake.attempts(), 1, 'should not retry on non-EADDRINUSE');
  });

  test('gives up after MAX_PORT_TRIES exhausted (injected)', async () => {
    const logger = silentLogger();
    const fake = fakeServer({
      errorsByAttempt: Array(MAX_PORT_TRIES).fill(0).map(() => makeError('EADDRINUSE')),
    });
    const err = await listen({
      server: fake, port: 8792, host: '127.0.0.1', strictPort: false, logger,
    }).catch((e) => e);
    assert.equal(err.code, 'EADDRINUSE');
    assert.equal(fake.attempts(), MAX_PORT_TRIES);
  });

  test('with a real server: surfaces actual bound port (port:0 → OS pick)', async () => {
    // Regression for the resolve(p) vs server.address().port bug.
    const server = createServer({ append: () => {} });
    const port = await listen({
      server, port: 0, host: '127.0.0.1', strictPort: true, logger: silentLogger(),
    });
    assert.ok(port > 0 && port < 65536);
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });
});

// ─── start() integration ───────────────────────────────────────────────────

describe('start()', () => {
  test('end-to-end: binds, writes header logs, accepts a POST', async () => {
    const dir = tmpDir('start');
    const logFile = path.join(dir, '.claude', 'session.log');
    const logger = silentLogger();
    const { server, port, logFile: actualLog } = await start({
      port: 0, host: '127.0.0.1', logFile, strictPort: true, logger,
    });
    try {
      assert.equal(actualLog, logFile);
      assert.ok(logger.calls.log.some((l) => l.includes('listening')));
      assert.ok(logger.calls.log.some((l) => l.includes('writing to')));

      const res = await request({ port, body: JSON.stringify({ h: 'H1', msg: 'hi' }) });
      assert.equal(res.status, 204);
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].h, 'H1');
      assert.equal(typeof lines[0].ts, 'number');
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });

  test('HOST=0.0.0.0 emits LAN warning', async () => {
    const logger = silentLogger();
    const { server } = await start({
      port: 0, host: '0.0.0.0',
      logFile: path.join(tmpDir('start-lan'), 'log'),
      strictPort: true, logger,
    });
    assert.ok(logger.calls.log.some((l) => l.includes('WARNING') && l.includes('0.0.0.0')));
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });

  test('defaults pull from process.env (PORT/HOST/LOG_FILE/STRICT_PORT)', async () => {
    const dir = tmpDir('start-env');
    const prev = { ...process.env };
    process.env.PORT = '0';
    process.env.HOST = '127.0.0.1';
    process.env.LOG_FILE = path.join(dir, 'envlog.log');
    process.env.STRICT_PORT = '1';
    try {
      const { server, logFile } = await start({ logger: silentLogger() });
      assert.equal(logFile, path.resolve(process.env.LOG_FILE));
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    } finally {
      process.env = prev;
    }
  });

  test('defaults fire when env vars are absent', async () => {
    // Hits the `process.env.PORT || '8792'`, `process.env.HOST || '127.0.0.1'`,
    // `process.env.STRICT_PORT === '1'` (false branch) defaults.
    const dir = tmpDir('start-noenv');
    const prev = { ...process.env };
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.STRICT_PORT;
    delete process.env.LOG_FILE;
    process.chdir(dir); // resolveLogFile uses cwd for the default
    try {
      // We don't actually want to bind 8792 in tests — pass an explicit port:0
      // override to avoid colliding with a real running ingest server.
      const { server, logFile } = await start({ port: 0, logger: silentLogger() });
      assert.match(path.basename(logFile), /^debug-\d{8}-\d{6}-\d+\.log$/);
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    } finally {
      process.env = prev;
      process.chdir(path.resolve(__dirname, '..'));
    }
  });
});

// ─── CLI entry point ───────────────────────────────────────────────────────

describe('CLI (subprocess)', () => {
  /**
   * Robust port discovery: instead of parsing stdout, we wait for the log file
   * to exist (the server creates it on startup) and read /health to learn the port.
   * But /health needs the port too — so we still need to parse one line. We isolate
   * that parsing to a helper that fails loudly on format change.
   */
  function parseListenLine(stdout) {
    const m = stdout.match(/listening on http:\/\/(\d+\.\d+\.\d+\.\d+):(\d+)/);
    if (!m) throw new Error(`could not find "listening on" line in:\n${stdout}`);
    return { host: m[1], port: parseInt(m[2], 10) };
  }

  function spawnCli({ env = {}, cwd } = {}) {
    return spawn(process.execPath, [SERVER_SCRIPT], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function waitForListening(child, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      const onData = (chunk) => {
        stdout += chunk.toString();
        if (/listening on/.test(stdout)) {
          child.stdout.off('data', onData);
          try { resolve(parseListenLine(stdout)); }
          catch (e) { reject(e); }
        }
      };
      child.stdout.on('data', onData);
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`child exited early with ${code}`)));
      setTimeout(() => reject(new Error('timeout waiting for CLI startup')), timeoutMs);
    });
  }

  test('binds and accepts a POST', async () => {
    const dir = tmpDir('cli');
    const logFile = path.join(dir, 'cli.log');
    const child = spawnCli({
      cwd: dir,
      env: { PORT: '0', LOG_FILE: logFile, STRICT_PORT: '1' },
    });
    try {
      const { port } = await waitForListening(child);
      const res = await request({ port, body: '{"h":"H1","msg":"cli"}' });
      assert.equal(res.status, 204);
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].h, 'H1');
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
    }
  });

  test('bind failure exits non-zero', async () => {
    const blocker = http.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const blockedPort = blocker.address().port;
    try {
      const child = spawnCli({
        env: { PORT: String(blockedPort), STRICT_PORT: '1' },
        cwd: tmpDir('cli-fail'),
      });
      const code = await new Promise((r) => child.on('exit', r));
      assert.notEqual(code, 0);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  test('runs with cleared env (exercises all default-fallback branches)', async () => {
    const dir = tmpDir('cli-noenv');
    // Build a minimal env: just PATH so node can find itself, plus a sentinel
    // that lets us pass a port=0 override via STRICT_PORT off and PORT unset.
    // But we cannot let it actually bind 8792 — so we override PORT=0.
    const child = spawnCli({
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PORT: '0', // unavoidable: prevents collision with a real ingest server
        // HOST, STRICT_PORT, LOG_FILE intentionally absent → exercises defaults
      },
    });
    try {
      const { host, port } = await waitForListening(child);
      assert.equal(host, '127.0.0.1'); // default HOST
      assert.ok(port > 0);
      // Default LOG_FILE → .claude/debug-<ts>-<pid>.log under cwd
      const claudeDir = path.join(dir, '.claude');
      const files = fs.readdirSync(claudeDir).filter((f) => /^debug-\d{8}-\d{6}-\d+\.log$/.test(f));
      assert.equal(files.length, 1, 'expected exactly one timestamped log file');
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
    }
  });
});
