// ═══════════════════════════════════════════════════════════════════════════
//  Stealth Transfer — Local deployment server
//  Zero dependencies (Node.js built-ins only)
//  Usage:  node web/serve.js [port]
//  Default port: 4173
// ═══════════════════════════════════════════════════════════════════════════

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');
const PORT = parseInt(process.argv[2], 10) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    let filePath = join(DIST, url.pathname);

    // If the path is a directory or doesn't exist, serve index.html (SPA fallback)
    try {
      const s = await stat(filePath);
      if (s.isDirectory()) filePath = join(filePath, 'index.html');
    } catch {
      filePath = join(DIST, 'index.html');
    }

    const content = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html'
        ? 'no-cache'
        : 'public, max-age=3600, immutable',
    });
    res.end(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Fallback to index.html for SPA routing
      try {
        const index = await readFile(join(DIST, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(index);
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }
    } else {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  🛡️  Stealth Transfer — Multi-Chain');
  console.log(`  Local:  http://localhost:${PORT}`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
