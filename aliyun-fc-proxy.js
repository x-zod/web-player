// aliyun-fc-proxy.js —— 阿里云函数计算（FC 3.0，内置 Node.js 运行时）用的 CORS 代理
//
// 用途：给 iptv-player.html 的“代理地址”栏提供云端代理，出口是阿里云国内机房 IP，
//       不会被源站按“境外/机房 IP”拒掉，也不受 Cloudflare 那份出站端口白名单限制。
//
// 部署：
//   1) 控制台 → 函数计算 FC → 创建函数：运行环境 Node.js 18 或 20，规格 512MB / 60s
//   2) 函数代码：新建 index.js，把本文件内容整段粘进去，导出方式保持 exports.handler
//   3) 配置 → 触发器 → 创建 HTTP 触发器：认证方式选「无需认证 / anonymous」，请求方法全勾
//   4) 拿到形如 https://xxxx.cn-hangzhou.fcapp.run 的地址
//   5) 播放器“代理地址”栏填这个地址（结尾不要带 /?u=），播放器会自动拼 ?u=<原流地址>
//
// 说明：
//   - FC 内置运行时的 HTTP 触发器不提供流式响应，分片会整体读进内存再返回；
//     普通 1080p 的 TS 分片 1~3MB 没问题，遇到超大分片（>6MB）可能被平台截断。
//   - 单次执行受函数超时限制（建议设 60s），冷启动约 1~3s，首次选台会稍慢。
//   - 默认域名 fcapp.run 不用备案；要绑自己的域名（国内地域）就得先备案。

'use strict';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, Accept-Ranges',
};

// FC 3.0 内置运行时给的是 event.queries；2.0 风格是 event.queryParameters；两个都兼容
function pickU(event) {
  const q = event.queries || event.queryParameters || {};
  let v = q.u;
  if (Array.isArray(v)) v = v[0];
  if (!v && event.queryStringParameters) v = event.queryStringParameters.u;
  return (v || '').trim();
}

function header(event, name) {
  const h = event.headers || {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === lower) return h[k];
  }
  return null;
}

// 把清单里的相对地址、URI="..." 全部换成经过本函数的绝对地址
// keyPrefix 形如 "" 或 "&k=你的密钥"，保证重写后的分片地址也能过密钥校验
function rewritePlaylist(text, baseUrl, selfOrigin, keyPrefix) {
  const toAbs = (u) => {
    try { return new URL(u, baseUrl).toString(); } catch (e) { return null; }
  };
  const prox = (abs) => selfOrigin + '/?u=' + encodeURIComponent(abs) + (keyPrefix || '');

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

exports.handler = async function (event, context) {
  const method = String(
    event.httpMethod ||
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    'GET'
  ).toUpperCase();

  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // 可选密钥：函数 URL 默认无认证，任何人拿到地址都能拿你的额度代理任意 URL；
  // 在函数的环境变量里设 PROXY_KEY=你的口令 即可开启，播放器代理栏填 .../ ? 后面带 k=口令
  const KEY = process.env.PROXY_KEY || '';
  if (KEY) {
    const q = event.queries || event.queryParameters || {};
    let k = q.k;
    if (Array.isArray(k)) k = k[0];
    if (k !== KEY) return { statusCode: 403, headers: CORS, body: 'forbidden: bad or missing k' };
  }

  const raw = pickU(event);
  if (!raw) return { statusCode: 400, headers: CORS, body: 'missing ?u=' };

  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: 'bad url' };
  }
  if (!/^https?:$/.test(target.protocol)) {
    return { statusCode: 400, headers: CORS, body: 'only http(s) allowed' };
  }

  const headers = { 'User-Agent': UA, Accept: '*/*' };
  const range = header(event, 'range');
  if (range) headers.Range = range;
  // 默认不发 Referer：部分源带 Referer 会把清单降级成错误 JSON

  let upstream;
  try {
    upstream = await fetch(target.toString(), { headers, redirect: 'follow' });
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: 'upstream fetch error: ' + e.message };
  }

  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  if (!upstream.ok && upstream.status !== 206) {
    return {
      statusCode: upstream.status,
      headers: CORS,
      body: 'upstream ' + upstream.status + ' (port ' + port + ', final ' + (upstream.url || target.toString()) + ')',
    };
  }

  const ctype = upstream.headers.get('content-type') || '';
  const isPlaylist = /mpegurl/i.test(ctype) || /\.m3u8$/i.test(target.pathname);

  if (isPlaylist) {
    const text = await upstream.text();
    const host = header(event, 'host') || (event.requestContext && event.requestContext.domainName) || '';
    const selfOrigin = 'https://' + host;
    return {
      statusCode: 200,
      headers: Object.assign({}, CORS, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
      }),
      body: rewritePlaylist(text, upstream.url || target.toString(), selfOrigin, KEY ? '&k=' + encodeURIComponent(KEY) : ''),
      isBase64Encoded: false,
    };
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  const outHeaders = Object.assign({}, CORS, {
    'Content-Type': ctype || 'application/octet-stream',
    'Cache-Control': 'public, max-age=8',
  });
  const cr = upstream.headers.get('content-range');
  if (cr) outHeaders['Content-Range'] = cr;
  const ar = upstream.headers.get('accept-ranges');
  if (ar) outHeaders['Accept-Ranges'] = ar;

  return {
    statusCode: upstream.status,
    headers: outHeaders,
    body: buf.toString('base64'),
    isBase64Encoded: true,
  };
};
