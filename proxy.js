const http = require('http');
const net = require('net');

const BACKEND_PORT = 8000;
const EXPO_PORT = 8081;

const server = http.createServer((req, res) => {
  const isApi = req.url.startsWith('/api');
  const targetPort = isApi ? BACKEND_PORT : EXPO_PORT;

  const options = {
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${targetPort}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(`Proxy error: ${err.message}`);
  });

  req.pipe(proxyReq, { end: true });
});

server.on('upgrade', (req, socket, head) => {
  const targetPort = req.url.startsWith('/api') ? BACKEND_PORT : EXPO_PORT;

  const proxy = net.createConnection({ port: targetPort, host: '127.0.0.1' }, () => {
    const headerLines = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    proxy.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headerLines}\r\n\r\n`
    );
    if (head && head.length > 0) proxy.write(head);
  });

  proxy.on('data', (chunk) => { if (!socket.destroyed) socket.write(chunk); });
  proxy.on('end', () => socket.end());
  proxy.on('error', () => socket.destroy());
  socket.on('data', (chunk) => { if (!proxy.destroyed) proxy.write(chunk); });
  socket.on('end', () => proxy.end());
  socket.on('error', () => proxy.destroy());
});

server.listen(5000, '0.0.0.0', () => {
  console.log('Proxy avviato su porta 5000  ->  Expo:' + EXPO_PORT + ' | Backend:' + BACKEND_PORT);
});
