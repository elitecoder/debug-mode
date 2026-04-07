#!/usr/bin/env node
// Tiny zero-dep HTTP log ingest for debug-mode.
// Receives JSON or text POSTs and appends them as NDJSON to .claude/debug.log.
//
// Usage:
//   node scripts/ingest_server.js                       # 127.0.0.1:8792, cwd
//   PORT=9000 HOST=0.0.0.0 LOG_FILE=./.claude/debug.log node scripts/ingest_server.js
//
// HOST=0.0.0.0 is required to accept connections from a physical iOS/Android
// device on the same LAN. Localhost-only is the default.

const http = require('http');
const fs = require('fs');
const path = require('path');

const MAX_PORT_TRIES = 10;
const MAX_BODY_BYTES = 1e6;

// Each server invocation = one debug session = one timestamped log file.
function timestampedName(date = new Date(), pid = process.pid) {
  const pad = n => String(n).padStart(2, '0');
  return `debug-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
         `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
         `-${pid}.log`;
}

function resolveLogFile(envLogFile, cwd = process.cwd()) {
  return path.resolve(cwd, envLogFile || path.join('.claude', timestampedName()));
}

function prepareLogFile(logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // Touch the file so readers can `tail -f` it immediately.
  fs.closeSync(fs.openSync(logFile, 'a'));
  // Maintain a `.claude/debug.log` symlink → newest session, for convenience.
  const latest = path.join(path.dirname(logFile), 'debug.log');
  if (latest === logFile) return; // user pinned LOG_FILE=debug.log; skip symlink
  try {
    if (fs.lstatSync(latest, { throwIfNoEntry: false })) {
      fs.unlinkSync(latest);
    }
  } catch {}
  try { fs.symlinkSync(path.basename(logFile), latest); } catch {}
}

function createAppender(logFile, now = Date.now) {
  return function append(record) {
    const line = JSON.stringify({ ts: now(), ...record }) + '\n';
    fs.appendFileSync(logFile, line);
  };
}

function createServer({ logFile, append, maxBodyBytes = MAX_BODY_BYTES } = {}) {
  if (!append) append = createAppender(logFile);
  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, log: logFile }));
    }

    if (req.method === 'POST' && (req.url === '/ingest' || req.url === '/')) {
      let body = '';
      let oversized = false;
      req.on('data', chunk => {
        body += chunk;
        if (body.length > maxBodyBytes) { oversized = true; req.destroy(); }
      });
      req.on('end', () => {
        if (oversized) return;
        let record;
        try { record = JSON.parse(body); }
        catch { record = { message: body }; }
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          record = { message: String(body) };
        }
        try {
          append(record);
          res.writeHead(204);
          res.end();
        } catch (e) {
          res.writeHead(500);
          res.end(String(e));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });
}

function listen({ server, port, host, strictPort, logger = console }) {
  return new Promise((resolve, reject) => {
    function attempt(p, n) {
      // Strip stale listeners — listen()'s success cb is added to 'listening'
      // but not removed on error; without this, each retry would double-fire.
      server.removeAllListeners('listening');
      server.removeAllListeners('error');

      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && !strictPort && n < MAX_PORT_TRIES - 1) {
          logger.log(`[debug-mode] port ${p} in use, trying ${p + 1}…`);
          setImmediate(() => attempt(p + 1, n + 1));
        } else {
          logger.error(`[debug-mode] failed to bind: ${err.message}`);
          reject(err);
        }
      });
      server.listen(p, host, () => resolve(server.address().port));
    }
    attempt(port, 0);
  });
}

async function start({
  port = parseInt(process.env.PORT || '8792', 10),
  host = process.env.HOST || '127.0.0.1',
  logFile = resolveLogFile(process.env.LOG_FILE),
  strictPort = process.env.STRICT_PORT === '1',
  logger = console,
} = {}) {
  prepareLogFile(logFile);
  const server = createServer({ logFile });
  const boundPort = await listen({ server, port, host, strictPort, logger });
  logger.log(`[debug-mode] ingest listening on http://${host}:${boundPort}`);
  logger.log(`[debug-mode] writing to ${logFile}`);
  if (host === '0.0.0.0') {
    logger.log('[debug-mode] WARNING: bound to 0.0.0.0 — only do this on a trusted LAN.');
  }
  return { server, port: boundPort, logFile };
}

module.exports = {
  MAX_PORT_TRIES,
  MAX_BODY_BYTES,
  timestampedName,
  resolveLogFile,
  prepareLogFile,
  createAppender,
  createServer,
  listen,
  start,
};

if (require.main === module) {
  start().catch(() => process.exit(1));
}
