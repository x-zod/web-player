// Cloudflare Worker：给 IPTV 源做 CORS 代理（配合 iptv-player.html 的“代理地址”栏使用）
//
// 为什么需要它：第三方 IPTV 源站基本都不返回 Access-Control-Allow-Origin，
// 浏览器里的 hls.js / fetch 会被同源策略拦掉，但 VLC、PowerShell 这类非浏览器客户端不受限。
// 这个 Worker 把 m3u8 和分片统一转发一遍，并补上 CORS 头，顺带重写清单里的相对地址。
//
// 部署：
//   1) 打开 https://dash.cloudflare.com → Workers & Pages → Create Worker
//   2) 把本文件内容粘进编辑器，Deploy
//   3) 得到一个地址，比如 https://iptv-proxy.你的账号.workers.dev
//   4) 在播放器“可选：CORS 代理地址”栏填这个地址（结尾不要带 /?u=）
//
// 播放器会自动拼成  https://xxx.workers.dev/?u=<encodeURIComponent(原始流地址)>

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const self = new URL(request.url);
    const raw = self.searchParams.get('u');
    if (!raw) return new Response('missing ?u=', { status: 400, headers: CORS });

    let target;
    try {
      target = new URL(raw);
    } catch (e) {
      return new Response('bad url', { status: 400, headers: CORS });
    }
    if (!/^https?:$/.test(target.protocol)) {
      return new Response('only http(s) allowed', { status: 400, headers: CORS });
    }

    const headers = {
      'User-Agent': UA,
      'Accept': '*/*',
    };
    // 默认不发 Referer：部分 IPTV 源（如 74.91.26.218:82）带 Referer 会把清单降级成
    // {"error":"频道 byt 不存在"}；确实需要 Referer 的源用 ?ref=1 打开
    if (self.searchParams.get('ref') === '1') headers['Referer'] = target.origin + '/';
    const range = request.headers.get('Range');
    if (range) headers.Range = range;

    // Cloudflare 出口在境外机房，不少国内 IPTV 源会按 IP/地域直接回 403；
    // 失败时把目标地址和端口原样带出来，便于判断是“源封云端 IP”还是“源已失效”
    const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');

    let upstream;
    try {
      upstream = await fetch(target.toString(), { headers, redirect: 'follow' });
    } catch (e) {
      return new Response('upstream fetch error: ' + e.message, { status: 502, headers: CORS });
    }

    if (!upstream.ok && upstream.status !== 206) {
      return new Response('upstream ' + upstream.status + ' (port ' + targetPort + ', final ' + (upstream.url || target.toString()) + ')',
        { status: upstream.status, headers: CORS });
    }

    const ctype = upstream.headers.get('content-type') || '';
    const isPlaylist = /mpegurl/i.test(ctype) || /\.m3u8$/i.test(target.pathname);

    if (isPlaylist) {
      const text = await upstream.text();
      return new Response(rewritePlaylist(text, upstream.url || target.toString(), self.origin), {
        status: 200,
        headers: {
          ...CORS,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache',
        },
      });
    }

    const outHeaders = {
      ...CORS,
      'Content-Type': ctype || 'application/octet-stream',
      'Cache-Control': 'public, max-age=8',
    };
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) outHeaders['Content-Range'] = contentRange;

    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  },
};

// 把清单里的相对地址、URI="..." 全部换成经过本 Worker 的绝对地址
function rewritePlaylist(text, baseUrl, selfOrigin) {
  const toAbs = (u) => {
    try {
      return new URL(u, baseUrl).toString();
    } catch (e) {
      return null;
    }
  };
  const prox = (abs) => selfOrigin + '/?u=' + encodeURIComponent(abs);

  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.charAt(0) === '#') {
        // 关键帧 / 加密 / 子清单等标签里可能有 URI="..."
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
