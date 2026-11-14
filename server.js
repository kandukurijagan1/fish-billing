const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execSync } = require('child_process');

const PORT = process.env.PORT || 5000;
let botProcess = null;
let isStartingBot = false;
let lastBotStartTime = 0;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject'
};

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];

  const reqOrigin = req.headers.origin || '';
  let originHost = '';
  try { originHost = reqOrigin ? new URL(reqOrigin).hostname : ''; } catch (e) {}
  const isTrustedOrigin = !reqOrigin || reqOrigin === 'null' || [
    'aaryanaqua.netlify.app', 'aaryan-aqua-billing.netlify.app',
    'kandukurijagan1.github.io', 'localhost', '127.0.0.1'
  ].includes(originHost);
  const safeCorsOrigin = isTrustedOrigin ? (reqOrigin || '*') : 'https://aaryanaqua.netlify.app';

  // Cloud Health Check endpoint (for Render, Railway, Fly.io, Kubernetes, Docker)
  if (reqPath === '/health' || reqPath === '/api/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': safeCorsOrigin
    });
    res.end(JSON.stringify({
      status: 'healthy',
      app: 'Aaryan Aqua Needs Enterprise Cloud Billing',
      timestamp: new Date().toISOString(),
      botActive: !!(botProcess && !botProcess.killed)
    }));
    return;
  }

  // Auto-start / health-check endpoint for frontend client
  if (reqPath === '/api/ensure-whatsapp-bot') {
    autoStartWhatsAppBot();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': safeCorsOrigin
    });
    res.end(JSON.stringify({ ok: true, active: !!botProcess }));
    return;
  }

  // Cloud Reverse-Proxy: transparently forward WhatsApp API, sync streams, and dashboard to port 3001
  if (
    reqPath.startsWith('/api/whatsapp/') ||
    reqPath === '/api/whatsapp' ||
    reqPath.startsWith('/api/sync/') ||
    reqPath === '/api/sync' ||
    reqPath === '/companion' ||
    reqPath.startsWith('/companion/')
  ) {
    autoStartWhatsAppBot();

    const proxyHeaders = Object.assign({}, req.headers, {
      host: '127.0.0.1:3001',
      'x-forwarded-for': req.socket.remoteAddress || '',
      'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http'
    });

    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: 3001,
      path: req.url,
      method: req.method,
      headers: proxyHeaders
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({
        ok: false,
        status: 'OFFLINE',
        error: 'bot_connecting',
        message: 'WhatsApp Bot Companion is initializing. Please retry in a few seconds.'
      }));
    });

    req.pipe(proxyReq);
    return;
  }

  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

  // Security: Prevent path traversal and unauthorized local file access (CWE-22)
  if (reqPath.includes('..') || reqPath.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request: Invalid path characters');
    return;
  }

  const safeBaseDir = path.resolve(__dirname);
  const normalizedPath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  const resolvedPath = path.resolve(safeBaseDir, '.' + path.sep + normalizedPath);

  // Enforce root containment boundary
  if (!resolvedPath.startsWith(safeBaseDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden: Access denied');
    return;
  }

  // Block access to sensitive dotfiles, environment files, and internal session folders
  const relPath = path.relative(safeBaseDir, resolvedPath);
  const baseName = path.basename(resolvedPath);
  if (baseName.startsWith('.') || relPath.startsWith('.env') || relPath.startsWith('.git') || relPath.startsWith('data' + path.sep) || relPath.startsWith('node_modules' + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden: Protected file');
    return;
  }

  fs.readFile(resolvedPath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(resolvedPath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'text/plain',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN'
    });
    res.end(content);
  });
});

function autoStartWhatsAppBot() {
  const botFile = path.join(__dirname, 'whatsapp-bot.js');
  if (!fs.existsSync(botFile)) return;

  // RULE 1: Never spawn if a botProcess is already running
  if (botProcess && !botProcess.killed) {
    return;
  }

  // RULE 2: Throttle - do not attempt another start if one started in the last 15 seconds
  const now = Date.now();
  if (isStartingBot || (now - lastBotStartTime < 15000)) {
    return;
  }

  // Test if port 3001 is already listening
  const sock = new net.Socket();
  sock.setTimeout(1500);

  sock.on('connect', () => {
    sock.destroy();
    // Port 3001 is active and healthy!
  });

  sock.on('timeout', () => {
    sock.destroy();
  });

  sock.on('error', () => {
    sock.destroy();
    if (botProcess && !botProcess.killed) return;
    if (isStartingBot || (Date.now() - lastBotStartTime < 15000)) return;

    isStartingBot = true;
    lastBotStartTime = Date.now();

    console.log('🚀 Auto-starting WhatsApp Bot Companion on port 3001 in background...');
    botProcess = spawn('node', ['whatsapp-bot.js'], {
      cwd: __dirname,
      env: Object.assign({}, process.env, { NO_AUTO_OPEN: 'true', DAEMON: 'true' }),
      stdio: 'inherit'
    });

    botProcess.on('exit', (code) => {
      console.log(`ℹ️ WhatsApp Bot Daemon exited with code ${code}.`);
      botProcess = null;
      isStartingBot = false;
    });

    // Guard window: keep isStartingBot true for 12 seconds so bot can finish boot & bind 3001
    setTimeout(() => {
      isStartingBot = false;
    }, 12000);
  });

  sock.connect(3001, '127.0.0.1');
}

// Keep-Alive Watchdog: Check port 3001 every 10 seconds.
setInterval(() => {
  autoStartWhatsAppBot();
}, 10000);

function cleanup() {
  if (botProcess && botProcess.pid) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /T /PID ${botProcess.pid}`, { stdio: 'ignore' });
      } else {
        botProcess.kill('SIGTERM');
      }
    } catch (e) {}
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🌐 Aaryan Aqua Billing Website is LIVE!`);
  console.log(`👉 Open in your browser: http://localhost:${PORT}`);
  console.log(`======================================================\n`);

  // Automatically start WhatsApp Bot daemon
  autoStartWhatsAppBot();
});
