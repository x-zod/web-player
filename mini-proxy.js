// mini-proxy.js —— 极简 CORS 代理（零依赖，Node 18+）
// 用法：node mini-proxy.js   环境变量 HOST / PORT
// 接口：http://HOST:PORT/?u=<encodeURIComponent(原始地址)>
const http = require('http');
const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,Content-Type',
};
const self = (req) => (req.socket.encrypted ? 'https://' : 'http://') + (req.headers.host || '');

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const u = new URL(req.url, 'http://x').searchParams.get('u');
  if (!u) { res.writeHead(400, { ...CORS, 'Content-Type': 'text/plain;charset=utf-8' }); return res.end('missing u'); }
  let t;
  try { t = new URL(u); } catch { res.writeHead(400, CORS); return res.end('bad u'); }
  if (!/^https?:$/.test(t.protocol)) { res.writeHead(400, CORS); return res.end('only http/https'); }

  const h = { 'User-Agent': UA, Accept: '*/*' };
  if (req.headers.range) h.Range = req.headers.range;
  try {
    const r = await fetch(u, { headers: h, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const ct = r.headers.get('content-type') || '';
    const pl = /mpegurl/i.test(ct) || /\.m3u8$/i.test(t.pathname);
    const base = { ...CORS, 'Cache-Control': 'no-cache' };
    const cr = r.headers.get('content-range'), ar = r.headers.get('accept-ranges');
    if (cr) base['Content-Range'] = cr;
    if (ar) base['Accept-Ranges'] = ar;

    if (pl) {
      const txt = await r.text();
      const abs = (l) => { try { return new URL(l, u).toString(); } catch { return l; } };
      const wrap = (l) => self(req).replace(/\/+$/, '') + '/?u=' + encodeURIComponent(abs(l));
      const out = txt.split(/\r?\n/).map((raw) => {
        const l = raw.trim();
        if (!l) return l;
        if (l[0] === '#') return l.replace(/URI="([^"]+)"/g, (m, p) => 'URI="' + wrap(p) + '"');
        return wrap(l);
      }).join('\n');
      res.writeHead(200, { ...base, 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(out);
    }
    base['Content-Type'] = ct || 'application/octet-stream';
    res.writeHead(r.status, base);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain;charset=utf-8' });
    res.end('upstream error: ' + (e && e.message ? e.message : e) + ' | ' + u);
  }
}).listen(PORT, HOST, () => console.log('mini-proxy listening on http://' + HOST + ':' + PORT + '/?u=<url>'));
