// Local preview of the static GitHub Pages site. No dependencies required.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'docs');
const port = Number(process.env.HAVVN_SITE_PORT || 4173);
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8'};
const server = http.createServer((request, response) => {
  let file;
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    file = path.resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + path.sep)) throw new Error('Invalid path');
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.statSync(file).isFile()) throw new Error('Missing file');
  } catch {
    response.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}).end('Not found');
    return;
  }
  response.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store'});
  const stream = fs.createReadStream(file);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
});
server.on('error', error => {console.error(error.message);process.exitCode=1;});
module.exports = server;
if (require.main === module) {
  server.listen(port, '127.0.0.1', () => console.log('HAVVN site preview: http://127.0.0.1:' + port));
  process.on('SIGINT', () => server.close());
  process.on('SIGTERM', () => server.close());
}
