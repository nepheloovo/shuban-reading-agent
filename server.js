// 书伴 Demo 服务：静态页面 + /api。零依赖，Node 18+ 即可运行。
const http = require('http');
const fs = require('fs');
const path = require('path');
const agent = require('./lib/agent');

const PORT = +(process.env.PORT || 8790);
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/book') {
      return send(res, 200, { book: agent.book.book, author: agent.book.author, chapters: agent.book.chapters.map((c) => ({ id: c.id, title: c.title, paras: c.paras })) });
    }
    if (url.pathname === '/api/ask' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const q = JSON.parse(body || '{}');
      const out = await agent.ask({ question: String(q.question || '').slice(0, 300), selection: String(q.selection || '').slice(0, 200), chapterId: q.chapterId || null });
      return send(res, 200, out);
    }
    if (url.pathname === '/api/eval') {
      const f = path.join(__dirname, 'eval', 'results.json');
      if (!fs.existsSync(f)) return send(res, 404, { error: '还没有评测结果，先运行 npm run eval' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return fs.createReadStream(f).pipe(res);
    }
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (file === '/eval') file = '/eval.html';
    const full = path.join(PUB, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(PUB) || !fs.existsSync(full)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`书伴已启动：http://127.0.0.1:${PORT}`));
