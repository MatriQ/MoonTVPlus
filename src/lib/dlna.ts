/**
 * DLNA/UPnP 投屏服务端核心库(零第三方依赖)
 * - SSDP M-SEARCH 发现局域网 MediaRenderer
 * - 解析设备描述 XML,提取 AVTransport controlURL
 * - 构建/发送 SOAP 控制指令(SetAVTransportURI / Play / Pause / Seek ...)
 * - 为电视拉流生成带签名的代理 URL(HMAC)
 */

import { createHmac, timingSafeEqual } from 'crypto';

export const AVTRANSPORT_SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1';

export interface SsdpDeviceAnnouncement {
  usn: string;
  location: string;
  server?: string;
}

export interface DlnaDevice {
  id: string;
  name: string;
  controlUrl: string;
  server?: string;
  location?: string;
}

export interface PositionInfo {
  relTimeSec: number | null;
  durationSec: number | null;
  trackUri: string | null;
}

// ---------- SSDP ----------

export async function ssdpSearch(timeoutMs = 4000): Promise<SsdpDeviceAnnouncement[]> {
  const dgram = (await import('dgram')).default ?? (await import('dgram'));
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  const found = new Map<string, SsdpDeviceAnnouncement>();
  const SSDP_ADDR = '239.255.255.250';
  const SSDP_PORT = 1900;
  const searchTargets = [
    'urn:schemas-upnp-org:device:MediaRenderer:1',
    'ssdp:all',
  ];

  return new Promise<SsdpDeviceAnnouncement[]>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(bindTimer);
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(Array.from(found.values()));
    };
    const timer = setTimeout(finish, timeoutMs);
    // Docker bridge 等环境下 bind 回调可能不触发,提前结束避免请求挂满超时
    const bindTimer = setTimeout(finish, 1200);
    // 兜底:socket 异常时提前结束,避免整个请求挂死
    socket.on('error', finish);
    socket.on('message', (msg) => {
      const text = msg.toString('utf8');
      const location = matchHttpHeader(text, 'LOCATION');
      const usn = matchHttpHeader(text, 'USN');
      if (!location || !usn) return;
      // ssdp:all 会带出大量非渲染设备,先按 ST 粗过滤,再在描述解析阶段确认 AVTransport
      const st = matchHttpHeader(text, 'ST') || matchHttpHeader(text, 'NT') || '';
      const looksLikeRenderer =
        /MediaRenderer|AVTransport| renderer|dlna/i.test(`${st} ${usn}`) || st === 'ssdp:all';
      if (!looksLikeRenderer) return;
      const key = usn.split('::')[0];
      if (!found.has(key)) {
        found.set(key, {
          usn: key,
          location,
          server: matchHttpHeader(text, 'SERVER') || undefined,
        });
      }
    });
    socket.bind(() => {
      clearTimeout(bindTimer);
      try {
        socket.addMembership(SSDP_ADDR);
      } catch {
        // Docker bridge 网络等场景组播加入失败,仍保留直发 M-SEARCH 的机会
      }
      for (const st of searchTargets) {
        const req = [
          'M-SEARCH * HTTP/1.1',
          `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
          'MAN: "ssdp:discover"',
          'MX: 3',
          `ST: ${st}`,
          '',
          '',
        ].join('\r\n');
        // 每种 ST 发两次,提高丢包场景命中率
        socket.send(req, SSDP_PORT, SSDP_ADDR);
        socket.send(req, SSDP_PORT, SSDP_ADDR);
      }
    });
  });
}

function matchHttpHeader(text: string, header: string): string | null {
  const m = text.match(new RegExp(`^${header}:\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : null;
}

// ---------- 设备描述解析 ----------

export async function fetchDeviceDescription(location: string): Promise<DlnaDevice | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(location, {
      signal: controller.signal,
      headers: { 'User-Agent': 'MoonTV DLNA' },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const xml = await res.text();
    const name =
      firstTag(xml, 'friendlyName') || firstTag(xml, 'modelName') || '未知设备';
    const controlPath = findAvTransportControlUrl(xml);
    if (!controlPath) return null;
    return {
      id: location,
      name: decodeXmlEntities(name),
      controlUrl: new URL(controlPath, location).toString(),
      location,
    };
  } catch {
    return null;
  }
}

/** 描述 XML 可能嵌套 deviceList,直接全文找 <service> 块里 serviceType 为 AVTransport 的 controlURL */
function findAvTransportControlUrl(xml: string): string | null {
  const services = xml.match(/<service>[\s\S]*?<\/service>/gi) || [];
  for (const svc of services) {
    const type = firstTag(svc, 'serviceType') || '';
    if (/AVTransport/i.test(type)) {
      const url = firstTag(svc, 'controlURL');
      if (url) return url;
    }
  }
  return null;
}

function firstTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------- SOAP ----------

export function buildSoapEnvelope(action: string, innerArgsXml: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    '<s:Body>',
    `<u:${action} xmlns:u="${AVTRANSPORT_SERVICE}">`,
    innerArgsXml,
    `</u:${action}>`,
    '</s:Body>',
    '</s:Envelope>',
  ].join('');
}

export async function sendAvTransportSoap(
  controlUrl: string,
  action: string,
  innerArgsXml: string,
  timeoutMs = 6000
): Promise<string> {
  const body = buildSoapEnvelope(action, innerArgsXml);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(controlUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: `"${AVTRANSPORT_SERVICE}#${action}"`,
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      const errDesc =
        text.match(/<errorDescription>([\s\S]*?)<\/errorDescription>/i)?.[1] ||
        text.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ||
        `HTTP ${res.status}`;
      throw new Error(decodeXmlEntities(errDesc));
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildDidlLite(title: string, uri: string): string {
  const protocolInfo = guessProtocolInfo(uri);
  const didl =
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="${protocolInfo}">${escapeXml(uri)}</res>` +
    '</item></DIDL-Lite>';
  // CurrentURIMetaData 要求传"被转义的 XML 字符串"
  return escapeXml(didl);
}

function guessProtocolInfo(uri: string): string {
  const clean = uri.split('?')[0].toLowerCase();
  if (clean.includes('.m3u8')) return 'http-get:*:application/vnd.apple.mpegurl:*';
  if (clean.includes('.mp4') || clean.includes('.m4v')) return 'http-get:*:video/mp4:*';
  if (clean.includes('.mkv')) return 'http-get:*:video/x-matroska:*';
  if (clean.includes('.flv')) return 'http-get:*:video/x-flv:*';
  if (clean.includes('.webm')) return 'http-get:*:video/webm:*';
  return 'http-get:*:video/mpeg:*';
}

export function secondsToRelTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}

export function relTimeToSeconds(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function parsePositionInfo(soapResponseXml: string): PositionInfo {
  return {
    relTimeSec: relTimeToSeconds(firstTag(soapResponseXml, 'RelTime')),
    durationSec: relTimeToSeconds(firstTag(soapResponseXml, 'TrackDuration')),
    trackUri: firstTag(soapResponseXml, 'TrackURI') || firstTag(soapResponseXml, 'TrackMetaData'),
  };
}

// ---------- 投屏代理 URL 签名 ----------
// 电视(DLNA 渲染器)拉流时无法携带登录 Cookie,代理路由用 HMAC 签名做一次性授权。
// secret 复用部署密码,不落库不新增配置。

function proxySecret(): string {
  return process.env.PASSWORD || 'moontv-dlna-proxy';
}

export function signProxyUrl(url: string): string {
  return createHmac('sha256', proxySecret()).update(url).digest('hex').slice(0, 32);
}

export function verifyProxySig(url: string, sig: string): boolean {
  const expected = signProxyUrl(url);
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

export function buildProxyUrl(origin: string, url: string): string {
  return `${origin}/api/dlna/proxy?url=${encodeURIComponent(url)}&sig=${signProxyUrl(url)}`;
}

// ---------- SSRF 防护 ----------

const PRIVATE_V4_CIDRS: Array<[string, number]> = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
];

function ipv4ToLong(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return -1;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function isPrivateIp(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) {
    return true;
  }
  // IPv4-mapped IPv6 (::ffff:192.168.1.2)
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const v4 = mapped ? mapped[1] : ip;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return false;
  const long = ipv4ToLong(v4);
  if (long < 0) return false;
  return PRIVATE_V4_CIDRS.some(([base, bits]) => {
    const baseLong = ipv4ToLong(base);
    if (baseLong < 0) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (long & mask) === (baseLong & mask);
  });
}

/** 校验控制地址是否指向私网(SOAP 控制端点只允许指向局域网设备,防 SSRF) */
export async function isPrivateHttpUrl(rawUrl: string): Promise<boolean> {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const dns = await import('dns');
    const { lookup } = dns.promises;
    const results = await lookup(u.hostname, { all: true });
    if (results.length === 0) return false;
    return results.every((r) => isPrivateIp(r.address));
  } catch {
    return false;
  }
}
