import http from 'http';

/**
 * Minimal HTTP health check server for Railway.
 * The bot uses long-polling (not webhooks), so Railway needs
 * something listening on a port to know the app is alive.
 */
export function startHealthServer(port = 3000) {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        bot: 'gahmood',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(port, () => {
    console.log(`✅ Health check server on port ${port}`);
  });

  return server;
}
