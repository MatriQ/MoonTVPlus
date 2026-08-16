/**
 * GET /api/dlna/proxy?url=...&sig=...
 * DLNA 投屏专用流代理:
 * - 鉴权用 HMAC 签名(见 src/lib/dlna.ts),因为电视拉流无法携带登录 Cookie
 * - m3u8: 重写内部 segment / key 地址为带签名的绝对代理地址
 * - 媒体分片/整文件: 透传 Range 请求与 206 响应,流式转发
 * - 默认以目标 URL 自身 origin 作为 Referer / 浏览器 UA 拉源,绕过大部分资源站防盗链
 */

import { NextRequest } from 'next/server';

import { signProxyUrl, verifyProxySig } from '@/lib/dlna';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function requestOrigin(request: NextRequest): string {
  const proto = request.headers.get('x-forwarded-proto') || 'http';
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'localhost';
  return `${proto}://${host}`;
}

function proxyWrap(origin: string, absoluteUrl: string): string {
  return `${origin}/api/dlna/proxy?url=${encodeURIComponent(absoluteUrl)}&sig=${signProxyUrl(absoluteUrl)}`;
}

function sourceHeaders(targetUrl: string, range?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
  };
  try {
    headers.Referer = new URL(targetUrl).origin + '/';
  } catch {
    // ignore
  }
  if (range) headers.Range = range;
  return headers;
}

export async function GET(request: NextRequest) {
  const target = request.nextUrl.searchParams.get('url');
  const sig = request.nextUrl.searchParams.get('sig') || '';
  if (!target || !sig || !verifyProxySig(target, sig)) {
    return new Response('Forbidden: invalid signature', { status: 403 });
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response('Bad Request: invalid url', { status: 400 });
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return new Response('Bad Request: unsupported protocol', { status: 400 });
  }
  // 只允许代理资源站直链,不允许指向本站自身接口(避免被当转发跳板)
  const host = request.headers.get('host');
  if (host && targetUrl.host === host) {
    return new Response('Bad Request: cannot proxy self', { status: 400 });
  }

  const range = request.headers.get('range');

  try {
    let upstream = await fetchUpstream(targetUrl, range);
    // 实际拉取的地址(HTML 播放页解析后会变化,m3u8 相对地址基于它解析)
    let effectiveUrl: URL = targetUrl;

    // 部分资源站(如飞飞 CMS)返回的是 HTML 播放页而非直链,
    // 真实流地址内嵌在 JS 变量/JSON 里,解析后跟随一层
    const contentType0 = upstream.headers.get('content-type') || '';
    if (contentType0.includes('text/html')) {
      const html = await upstream.text();
      const resolved = parseEmbeddedStreamUrl(html, targetUrl.toString());
      if (!resolved) {
        return new Response('Upstream returned a player page without a stream URL', {
          status: 502,
        });
      }
      console.log(`[DLNA] proxy resolved embedded stream: ${resolved}`);
      effectiveUrl = new URL(resolved);
      upstream = await fetchUpstream(effectiveUrl, range);
    }

    if (!upstream.ok && upstream.status !== 206) {
      return new Response(`Upstream error: ${upstream.status}`, { status: upstream.status });
    }

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const isPlaylist =
      contentType.includes('mpegurl') ||
      contentType.includes('m3u') ||
      effectiveUrl.pathname.toLowerCase().split('?')[0].endsWith('.m3u8');

    if (isPlaylist && upstream.body) {
      const text = await upstream.text();
      const origin = requestOrigin(request);
      const lines = text.split('\n').map((line) => rewritePlaylistLine(line, effectiveUrl, origin));
      return new Response(lines.join('\n'), {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
        },
      });
    }

    // 二进制媒体:透传 Range / 长度 / 类型
    const headers = new Headers();
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
    headers.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    console.error('[DLNA] proxy failed:', targetUrl.toString(), error);
    return new Response('Upstream fetch failed', { status: 502 });
  }
}

function rewritePlaylistLine(line: string, playlistUrl: URL, origin: string): string {
  const trimmed = line.trim();
  if (!trimmed) return line;
  if (trimmed.startsWith('#')) {
    // EXT-X-KEY / EXT-X-MAP 里的 URI="..." 也要重写,否则电视回源拉不到
    return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
      try {
        const abs = new URL(uri, playlistUrl).toString();
        return `URI="${proxyWrap(origin, abs)}"`;
      } catch {
        return `URI="${uri}"`;
      }
    });
  }
  try {
    const abs = new URL(trimmed, playlistUrl).toString();
    return proxyWrap(origin, abs);
  } catch {
    return line;
  }
}

async function fetchUpstream(target: URL, range?: string | null): Promise<Response> {
  return fetch(target, {
    headers: sourceHeaders(target.toString(), range),
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
}

/**
 * 从 CMS 播放页 HTML 中解析真实流地址。
 * 覆盖常见模式:
 *   - 飞飞/苹果CMS 播放页: const url = "/20240613/xxx/index.m3u8?sign=..."
 *   - player_aaaa = {"url":"https://...m3u8", ...}(苹果CMS V10 经典)
 *   - 直接内嵌完整 m3u8/mp4 链接
 * 只解析指向 .m3u8/.mp4 的候选,相对路径基于播放页 URL 解析。
 */
function parseEmbeddedStreamUrl(html: string, baseUrl: string): string | null {
  const candidates: string[] = [];
  const jsVar = html.match(/\burl\s*[:=]\s*["']([^"']+)["']/i);
  if (jsVar) candidates.push(jsVar[1]);
  const playerAaaa = html.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})/);
  if (playerAaaa) {
    try {
      const obj = JSON.parse(playerAaaa[1]) as { url?: string };
      if (obj.url) candidates.push(obj.url);
    } catch {
      const inner = playerAaaa[1].match(/["']url["']\s*:\s*["']([^"']+)["']/);
      if (inner) candidates.push(inner[1]);
    }
  }
  const direct = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/);
  if (direct) candidates.push(direct[0]);

  for (const c of candidates) {
    const value = c.trim();
    if (!value) continue;
    if (!/\.m3u8(\?|$)/i.test(value) && !/\.mp4(\?|$)/i.test(value)) continue;
    if (value.startsWith('data:') || value.startsWith('blob:')) continue;
    try {
      return new URL(value, baseUrl).toString();
    } catch {
      // ignore invalid
    }
  }
  return null;
}
