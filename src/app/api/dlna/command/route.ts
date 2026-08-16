/**
 * POST /api/dlna/command
 * 由服务端向局域网 DLNA 渲染器转发 SOAP 控制指令(服务端与电视同网段时可用)。
 * 电视不可达(云端部署)时前端会退化为浏览器直发模式,见 src/lib/dlna-client.ts。
 *
 * body: { controlUrl, action, uri?, title?, positionSec? }
 * action ∈ setUri | play | pause | stop | seek | getInfo
 */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  buildDidlLite,
  isPrivateHttpUrl,
  parsePositionInfo,
  secondsToRelTime,
  sendAvTransportSoap,
} from '@/lib/dlna';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DlnaCommand =
  | 'setUri'
  | 'play'
  | 'pause'
  | 'stop'
  | 'seek'
  | 'getInfo';

interface CommandBody {
  controlUrl?: string;
  action?: DlnaCommand;
  uri?: string;
  title?: string;
  positionSec?: number;
}

export async function POST(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: CommandBody;
  try {
    body = (await request.json()) as CommandBody;
  } catch {
    return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
  }

  const { controlUrl, action } = body;
  if (!controlUrl || !action) {
    return NextResponse.json({ error: '缺少 controlUrl 或 action' }, { status: 400 });
  }
  if (!/^https?:\/\//i.test(controlUrl)) {
    return NextResponse.json({ error: 'controlUrl 必须是 http(s) 地址' }, { status: 400 });
  }
  // SOAP 端点只允许指向局域网设备,防止该接口被当作 SSRF 跳板
  if (!(await isPrivateHttpUrl(controlUrl))) {
    return NextResponse.json({ error: '控制地址必须指向局域网设备' }, { status: 400 });
  }

  try {
    switch (action) {
      case 'setUri': {
        if (!body.uri || !/^https?:\/\//i.test(body.uri)) {
          return NextResponse.json({ error: '缺少有效的 uri' }, { status: 400 });
        }
        await sendAvTransportSoap(
          controlUrl,
          'SetAVTransportURI',
          `<InstanceID>0</InstanceID><CurrentURI>${body.uri
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')}</CurrentURI><CurrentURIMetaData>${buildDidlLite(
            body.title || 'MoonTV',
            body.uri
          )}</CurrentURIMetaData>`
        );
        return NextResponse.json({ success: true });
      }
      case 'play':
        await sendAvTransportSoap(controlUrl, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>');
        return NextResponse.json({ success: true });
      case 'pause':
        await sendAvTransportSoap(controlUrl, 'Pause', '<InstanceID>0</InstanceID>');
        return NextResponse.json({ success: true });
      case 'stop':
        await sendAvTransportSoap(controlUrl, 'Stop', '<InstanceID>0</InstanceID>');
        return NextResponse.json({ success: true });
      case 'seek': {
        if (typeof body.positionSec !== 'number' || body.positionSec < 0) {
          return NextResponse.json({ error: 'positionSec 无效' }, { status: 400 });
        }
        await sendAvTransportSoap(
          controlUrl,
          'Seek',
          `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${secondsToRelTime(
            body.positionSec
          )}</Target>`
        );
        return NextResponse.json({ success: true });
      }
      case 'getInfo': {
        const xml = await sendAvTransportSoap(controlUrl, 'GetPositionInfo', '<InstanceID>0</InstanceID>');
        return NextResponse.json({ success: true, info: parsePositionInfo(xml) });
      }
      default:
        return NextResponse.json({ error: `不支持的动作: ${action}` }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SOAP 调用失败';
    console.error(`[DLNA] command ${action} failed:`, message);
    // 网络不可达/超时统一返回 502,前端据此切换浏览器直发模式
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
