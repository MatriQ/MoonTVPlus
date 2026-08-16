/**
 * GET /api/dlna/discover?timeout=4000
 * SSDP 搜索局域网 DLNA MediaRenderer 并解析 AVTransport 控制地址。
 * 仅当 MoonTV 服务端与电视处于同一局域网时有效(自建 NAS/本地 Docker 场景);
 * 云端部署收不到组播应答,前端应引导用户手动添加设备。
 */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { fetchDeviceDescription, ssdpSearch } from '@/lib/dlna';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const timeout = Math.min(Math.max(Number(request.nextUrl.searchParams.get('timeout')) || 4000, 1000), 10000);

  try {
    const announcements = await ssdpSearch(timeout);
    const devices = await Promise.all(
      announcements.map((a) => fetchDeviceDescription(a.location))
    );
    const seen = new Set<string>();
    const list = devices.filter((d): d is NonNullable<typeof d> => {
      if (!d || seen.has(d.controlUrl)) return false;
      seen.add(d.controlUrl);
      return true;
    });
    return NextResponse.json({ devices: list });
  } catch (error) {
    console.error('[DLNA] discover failed:', error);
    return NextResponse.json(
      { devices: [], error: 'SSDP 搜索不可用(可能与电视不在同一网络,请手动添加设备)' },
      { status: 200 }
    );
  }
}
