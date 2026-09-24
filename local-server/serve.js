#!/usr/bin/env node
// Zero-dependency static file server used by the extension's "Map Local" rules.
//
//   node local-server/serve.js [--port 4815]
//
// The extension pushes the folders to serve ("mounts") with POST /__config, and each
// Map Local rule redirects to http://127.0.0.1:<port>/m/<ruleId>/<path>. Mounts are
// persisted in ~/.devmode-serve.json so they survive restarts.
// Every response carries permissive CORS + no-store headers so assets redirected
// from an https page load without console errors.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = path.join(os.homedir(), '.devmode-serve.json');
const MOUNT_PREFIX = '/m/';

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm'
};

function parseArgs(argv) {
  const args = { port: 4815, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--port' || a === '-p') && argv[i + 1]) args.port = Number(argv[++i]);
    else if (a === '--host' && argv[i + 1]) args.host = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node local-server/serve.js [--port 4815] [--host 127.0.0.1]');
      process.exit(0);
    }
  }
  return args;
}

const { port, host } = parseArgs(process.argv.slice(2));

// ---- mounts: { [id]: absoluteDir } ----
let mounts = {};

function loadMounts() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (data && typeof data.mounts === 'object') mounts = data.mounts;
  } catch { /* first run */ }
}

function saveMounts() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ mounts }, null, 2));
  } catch (err) {
    console.error('[serve] Could not persist mounts:', err.message);
  }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function mountStatus() {
  return Object.fromEntries(Object.entries(mounts).map(([id, dir]) => [id, { dir, exists: isDir(dir) }]));
}

const BASE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Allow-Private-Network': 'true',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Timing-Allow-Origin': '*',
  'Cache-Control': 'no-store'
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, { 'Content-Type': 'application/json' }, JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Only the extension may change mounts: web pages cannot forge a chrome-extension:// Origin
function isExtensionRequest(req) {
  return (req.headers.origin || '').startsWith('chrome-extension://');
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const url = new URL(req.url, `http://${host}:${port}`);
  const pathname = decodeURIComponent(url.pathname);

  if (method === 'OPTIONS') return send(res, 204, {}, '');

  if (pathname === '/__health') {
    return sendJson(res, 200, { ok: true, port, mounts: mountStatus() });
  }

  if (pathname === '/__config') {
    if (method !== 'POST') return sendJson(res, 405, { error: 'POST required' });
    if (!isExtensionRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
    if (!body || typeof body.mounts !== 'object') return sendJson(res, 400, { error: 'Expected { mounts: { id: dir } }' });

    mounts = {};
    for (const [id, dir] of Object.entries(body.mounts)) {
      if (/^[\w-]+$/.test(id) && typeof dir === 'string' && path.isAbsolute(dir)) mounts[id] = path.resolve(dir);
    }
    saveMounts();
    console.log('[serve] mounts updated:', Object.keys(mounts).length ? mounts : '(none)');
    return sendJson(res, 200, { ok: true, mounts: mountStatus() });
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return send(res, 405, { 'Content-Type': 'text/plain' }, 'Method Not Allowed');
  }

  // /m/<id>/<path> -> file under mounts[id]
  if (!pathname.startsWith(MOUNT_PREFIX)) {
    return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
  }
  const rest = pathname.slice(MOUNT_PREFIX.length);
  const slash = rest.indexOf('/');
  const id = slash === -1 ? rest : rest.slice(0, slash);
  const relPath = slash === -1 ? '/' : rest.slice(slash);
  const root = mounts[id];
  if (!root) {
    console.log(`404 ${method} ${pathname} (unknown mount "${id}")`);
    return send(res, 404, { 'Content-Type': 'text/plain' }, 'Unknown mount');
  }

  // Resolve inside root only (path traversal guard)
  const filePath = path.resolve(root, '.' + path.posix.normalize(relPath));
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
  }

  fs.stat(filePath, (err, stat) => {
    let target = filePath;
    if (!err && stat.isDirectory()) target = path.join(filePath, 'index.html');

    fs.stat(target, (err2, stat2) => {
      if (err2 || !stat2.isFile()) {
        console.log(`404 ${method} ${pathname}`);
        return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
      }

      const headers = {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat2.size
      };
      console.log(`200 ${method} ${pathname}`);
      if (method === 'HEAD') return send(res, 200, headers, '');

      res.writeHead(200, { ...BASE_HEADERS, ...headers });
      fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
    });
  });
});

loadMounts();

server.listen(port, host, () => {
  console.log(`[serve] http://${host}:${port}/  (health: /__health, config: POST /__config)`);
  console.log('[serve] mounts:', Object.keys(mounts).length ? mounts : '(none yet — save the extension settings)');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`[serve] Port ${port} is already in use`);
  else console.error('[serve]', err.message);
  process.exit(1);
});
