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
    const upstream = await fetch(targetUrl, {
      headers: sourceHeaders(target, range),
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok && upstream.status !== 206) {
      return new Response(`Upstream error: ${upstream.status}`, { status: upstream.status });
    }

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const isPlaylist =
      contentType.includes('mpegurl') ||
      contentType.includes('m3u') ||
      targetUrl.pathname.toLowerCase().split('?')[0].endsWith('.m3u8');

    if (isPlaylist && upstream.body) {
      const text = await upstream.text();
      const origin = requestOrigin(request);
      const lines = text.split('\n').map((line) => rewritePlaylistLine(line, targetUrl, origin));
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
