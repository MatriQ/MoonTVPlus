/**
 * POST /api/dlna/prepare
 * 把播放直链包装成电视可访问的投屏地址:
 * - proxy(默认): {origin}/api/dlna/proxy?url=...&sig=HMAC —— 解决防盗链(带浏览器 UA/Referer)
 *   和部分电视不支持特定直链域名的兼容问题,流量经 MoonTV 服务器中转
 * - direct: 原样返回直链,电视直接访问资源站
 */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { buildProxyUrl } from '@/lib/dlna';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function requestOrigin(request: NextRequest): string {
  const proto = request.headers.get('x-forwarded-proto') || 'http';
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'localhost';
  return `${proto}://${host}`;
}

export async function POST(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { url?: string; mode?: 'proxy' | 'direct' };
  try {
    body = (await request.json()) as { url?: string; mode?: 'proxy' | 'direct' };
  } catch {
    return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
  }

  const { url, mode = 'proxy' } = body;
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: '缺少有效的 http(s) 播放地址' }, { status: 400 });
  }

  if (mode === 'direct') {
    return NextResponse.json({ uri: url, mode });
  }
  return NextResponse.json({ uri: buildProxyUrl(requestOrigin(request), url), mode });
}
