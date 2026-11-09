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

  // Cloud Health Check endpoint (for Render, Railway, Fly.io, Kubernetes, Docker)
  if (reqPath === '/health' || reqPath === '/api/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
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
      'Access-Control-Allow-Origin': '*'
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
  const filePath = path.join(__dirname, reqPath);

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'text/plain',
      'Cache-Control': 'no-cache'
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
