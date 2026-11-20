// local-proxy.js —— 本机 IPTV 代理 + 静态页服务（Node 18+，零依赖）
//
// 为什么不用 Cloudflare Worker：CF 的 fetch 只允许访问少数出站端口
//   （80/8080/8880/2052/2082/2086/2095、443/2053/2083/2087/2096/8443 等），
//   而这类 IPTV 源大量跑在 82、8181、9000 之类的端口上，Worker 直接 403。
// 本机代理没有端口限制，出口还是你家的宽带 IP，不会因为“境外/机房 IP”被源站拒绝。
//
// 用法：
//   node local-proxy.js
//   浏览器打开  http://127.0.0.1:8787/iptv-player.html
//   播放器“代理地址”栏填  http://127.0.0.1:8787/proxy
//
// 端口可用环境变量覆盖：  PORT=9000 node local-proxy.js
// 监听地址也可覆盖：      HOST=0.0.0.0 node local-proxy.js   （放到云服务器上时用，才能从公网访问）

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';   // 云服务器上记得设 0.0.0.0
const ROOT = __dirname;
const ORIGIN = 'http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT;
const PROXY_PATH = '/proxy';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, ORIGIN);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (reqUrl.pathname === PROXY_PATH || reqUrl.pathname === PROXY_PATH + '/') {
    return handleProxy(reqUrl, req, res);
  }
  return serveStatic(reqUrl, res);
});

/* ---------------- 代理 ---------------- */
async function handleProxy(reqUrl, req, res) {
  const raw = reqUrl.searchParams.get('u');
  if (!raw) return plain(res, 400, 'missing ?u=');

  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    return plain(res, 400, 'bad url');
  }
  if (!/^https?:$/.test(target.protocol)) return plain(res, 400, 'only http(s) allowed');

  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
  };
  // 默认不带 Referer：有的源（如 74.91.26.218:82）带 Referer 会把清单换成 {"error":"频道 byt 不存在"}
  if (req.url.includes('ref=1')) headers.Referer = target.origin + '/';
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(target, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    console.log('[proxy] fetch error', target.href, e.message);
    return plain(res, 502, 'upstream fetch error: ' + e.message);
  }

  if (!upstream.ok && upstream.status !== 206) {
    console.log('[proxy] upstream', upstream.status, target.href);
    return plain(res, upstream.status, 'upstream ' + upstream.status);
  }

  const ctype = upstream.headers.get('content-type') || '';
  const isPlaylist = /mpegurl/i.test(ctype) || /\.m3u8$/i.test(target.pathname);

  if (isPlaylist) {
    const text = await upstream.text();
    const body = rewritePlaylist(text, upstream.url || target.href);
    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache',
    });
    return res.end(body);
  }

  const outHeaders = {
    ...CORS,
    'Content-Type': ctype || 'application/octet-stream',
    'Cache-Control': 'public, max-age=8',
  };
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) outHeaders['Content-Range'] = contentRange;

  res.writeHead(upstream.status, outHeaders);
  if (!upstream.body) return res.end();

  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// 把清单里的相对地址、URI="..." 全部重写成经本机代理的绝对地址
function rewritePlaylist(text, baseUrl) {
  const toAbs = (u) => {
    try {
      return new URL(u, baseUrl).href;
    } catch (e) {
      return null;
    }
  };
  const prox = (abs) => ORIGIN + PROXY_PATH + '?u=' + encodeURIComponent(abs);

  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.charAt(0) === '#') {
        return line.replace(/URI="([^"]+)"/g, (m, u) => {
          const abs = toAbs(u);
          return abs ? 'URI="' + prox(abs) + '"' : m;
        });
      }
      const abs = toAbs(t);
      return abs ? prox(abs) : line;
    })
    .join('\n');
}

/* ---------------- 静态页 ---------------- */
function serveStatic(reqUrl, res) {
  const name = reqUrl.pathname === '/' ? '/iptv-player.html' : reqUrl.pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(name);
  } catch (e) {
    return plain(res, 400, 'bad path');
  }

  const file = path.join(ROOT, path.normalize(decoded));
  if (!file.startsWith(ROOT)) return plain(res, 403, 'forbidden');

  fs.readFile(file, (err, data) => {
    if (err) return plain(res, 404, 'not found: ' + decoded);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function plain(res, status, text) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

server.listen(PORT, HOST, () => {
  console.log('IPTV 本地代理已启动：' + ORIGIN + '（监听 ' + HOST + ':' + PORT + '）');
  console.log('播放器：' + ORIGIN + '/iptv-player.html');
  console.log('代理地址栏填：' + ORIGIN + PROXY_PATH);
});
