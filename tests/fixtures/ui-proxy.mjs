// In-process stand-in for nginx, used by transport integration tests.
import http from 'node:http';
import fs from 'node:fs/promises';

export function createUi(apiUrl) {
  return http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      const upstream = http.request(new URL(req.url, apiUrl), { method: req.method, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end('{"error":"API unavailable"}');
      });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    if (req.url !== '/') { res.writeHead(404); res.end(); return; }
    try {
      const content = await fs.readFile(new URL('../../services/ui/public/index.html', import.meta.url));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
}
