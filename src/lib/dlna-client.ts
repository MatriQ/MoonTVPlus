/**
 * DLNA 投屏前端逻辑(浏览器端)
 *
 * 两条控制链路,自动选择:
 * 1. 服务端转发:POST /api/dlna/command —— MoonTV 服务端与电视同网段(自建 NAS)时可用,
 *    能读到 SOAP 响应,支持进度轮询
 * 2. 浏览器直发:用户浏览器与电视同网段(云端部署 MoonTV 时)由浏览器直接对电视发 SOAP。
 *    受 CORS 限制只能 no-cors 盲发(读不到响应),控制指令为"尽力而为",设备兼容性因品牌而异
 */

import { fetchWithAuth } from '@/lib/db.client';

export interface DlnaDevice {
  id: string;
  name: string;
  controlUrl: string;
  manual?: boolean;
}

export interface DlnaPositionInfo {
  relTimeSec: number | null;
  durationSec: number | null;
  trackUri: string | null;
}

const DEVICES_KEY = 'moontv_dlna_devices';

export function loadManualDevices(): DlnaDevice[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(DEVICES_KEY);
    const list = raw ? (JSON.parse(raw) as DlnaDevice[]) : [];
    return Array.isArray(list) ? list.filter((d) => d && d.controlUrl && d.name) : [];
  } catch {
    return [];
  }
}

export function saveManualDevices(devices: DlnaDevice[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DEVICES_KEY, JSON.stringify(devices));
}

// ---------- 设备发现 ----------

export async function discoverDevices(timeoutMs = 4000): Promise<DlnaDevice[]> {
  const res = await fetchWithAuth(`/api/dlna/discover?timeout=${timeoutMs}`);
  const data = (await res.json()) as { devices?: DlnaDevice[]; error?: string };
  if (!res.ok) throw new Error(data.error || '搜索失败');
  return (data.devices || []).map((d) => ({
    id: d.id || d.controlUrl,
    name: d.name,
    controlUrl: d.controlUrl,
  }));
}

/**
 * 手动添加设备:输入 IP 或完整 control URL。
 * 只输 IP 时按常见端口 × 路径组合盲发探测(见 castToCandidates)。
 */
export function normalizeManualDeviceInput(input: string): DlnaDevice | null {
  const value = input.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    let name = '手动设备';
    try {
      const u = new URL(value);
      name = `手动设备 (${u.hostname}:${u.port || '80'})`;
    } catch {
      return null;
    }
    return { id: value, name, controlUrl: value, manual: true };
  }
  // 纯 IP:存为候选模式,投屏时逐个尝试
  const ip = value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return null;
  return { id: `manual-${ip}`, name: `手动设备 (${ip})`, controlUrl: `dlna-candidates://${ip}`, manual: true };
}

// 常见 DLNA 渲染器 control 端口与路径(社区经验值,涵盖 libupnp/miniupnp 默认与主流电视)
export const CANDIDATE_PORTS = [49152, 8200, 1443, 9197, 52235, 13456, 46383, 80];
export const CANDIDATE_PATHS = [
  '/dev/render/ctl',
  '/control/',
  '/upnp/control/rendertransport1',
  '/MediaRenderer/AVTransport/control',
  '/AVTransport/control',
  '/ctl/AVTransport',
];

function candidateControlUrls(ip: string): string[] {
  const urls: string[] = [];
  for (const port of CANDIDATE_PORTS) {
    for (const path of CANDIDATE_PATHS) {
      urls.push(`http://${ip}:${port}${path}`);
    }
  }
  return urls.slice(0, 12);
}

// ---------- SOAP 直发(浏览器 → 电视) ----------

function buildSoap(action: string, innerXml: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    '<s:Body>',
    `<u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">`,
    innerXml,
    `</u:${action}>`,
    '</s:Body>',
    '</s:Envelope>',
  ].join('');
}

function escapeXmlValue(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * no-cors 直发:自定义 SOAPACTION 头会被 no-cors 模式剥掉,
 * 部分电视校验该头会失败 —— 这是浏览器直发模式的固有兼容性损耗
 */
async function soapDirect(controlUrl: string, action: string, innerXml: string): Promise<void> {
  await fetch(controlUrl, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: buildSoap(action, innerXml),
  }).catch(() => undefined);
}

// ---------- 统一控制入口 ----------

export type DlnaCommandAction = 'setUri' | 'play' | 'pause' | 'stop' | 'seek' | 'getInfo';

export interface CommandOptions {
  uri?: string;
  title?: string;
  positionSec?: number;
}

/** 服务端转发是否可达;不可达(云端部署)时走浏览器直发 */
let serverMode: boolean | null = null;

export async function isServerMode(controlUrl: string): Promise<boolean> {
  if (serverMode !== null) return serverMode;
  try {
    const res = await fetchWithAuth('/api/dlna/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ controlUrl, action: 'getInfo' }),
    });
    serverMode = res.ok;
  } catch {
    serverMode = false;
  }
  return serverMode;
}

export function resetModeCache() {
  serverMode = null;
}

export async function sendCommand(
  device: DlnaDevice,
  action: DlnaCommandAction,
  options: CommandOptions = {}
): Promise<{ ok: boolean; info?: DlnaPositionInfo; error?: string }> {
  if (device.controlUrl.startsWith('dlna-candidates://')) {
    return { ok: false, error: '该设备为候选模式,请使用 castToDevice 完整投屏流程' };
  }
  const viaServer = await isServerMode(device.controlUrl);
  if (viaServer) {
    try {
      const res = await fetchWithAuth('/api/dlna/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ controlUrl: device.controlUrl, action, ...options }),
      });
      const data = (await res.json()) as { success?: boolean; info?: DlnaPositionInfo; error?: string };
      if (res.ok) return { ok: true, info: data.info };
      return { ok: false, error: data.error || `指令失败 (${res.status})` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '网络错误' };
    }
  }
  // 浏览器直发(盲发,无回执)
  await soapDirectAction(device.controlUrl, action, options);
  return { ok: true };
}

async function soapDirectAction(controlUrl: string, action: DlnaCommandAction, options: CommandOptions) {
  switch (action) {
    case 'setUri': {
      const didl = escapeXmlValue(
        `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${escapeXmlValue(
          options.title || 'MoonTV'
        )}</dc:title><upnp:class>object.item.videoItem</upnp:class></item></DIDL-Lite>`
      );
      await soapDirect(
        controlUrl,
        'SetAVTransportURI',
        `<InstanceID>0</InstanceID><CurrentURI>${escapeXmlValue(
          options.uri || ''
        )}</CurrentURI><CurrentURIMetaData>${didl}</CurrentURIMetaData>`
      );
      return;
    }
    case 'play':
      await soapDirect(controlUrl, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>');
      return;
    case 'pause':
      await soapDirect(controlUrl, 'Pause', '<InstanceID>0</InstanceID>');
      return;
    case 'stop':
      await soapDirect(controlUrl, 'Stop', '<InstanceID>0</InstanceID>');
      return;
    case 'seek': {
      const s = Math.max(0, Math.floor(options.positionSec || 0));
      const hh = String(Math.floor(s / 3600)).padStart(2, '0');
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      await soapDirect(controlUrl, 'Seek', `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${hh}:${mm}:${ss}</Target>`);
      return;
    }
    case 'getInfo':
      // 直发模式读不到响应,直接返回
      return;
  }
}

// ---------- 投屏主流程 ----------

/** 把直链包装为电视可拉流的地址(默认走服务器签名代理解决防盗链) */
export async function prepareCastUri(url: string, mode: 'proxy' | 'direct' = 'proxy'): Promise<string> {
  const res = await fetchWithAuth('/api/dlna/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, mode }),
  });
  const data = (await res.json()) as { uri?: string; error?: string };
  if (!res.ok || !data.uri) throw new Error(data.error || '生成投屏地址失败');
  return data.uri;
}

export async function castToDevice(
  device: DlnaDevice,
  uri: string,
  title: string,
  onCandidateTried?: (url: string) => void
): Promise<{ ok: boolean; resolvedControlUrl?: string; error?: string }> {
  // 候选模式:纯 IP 手动设备,逐个尝试常见 control 地址
  if (device.controlUrl.startsWith('dlna-candidates://')) {
    const ip = device.controlUrl.replace('dlna-candidates://', '');
    const candidates = candidateControlUrls(ip);
    const viaServer = await isServerMode(`http://${ip}:9197/x`);
    for (const candidate of candidates) {
      onCandidateTried?.(candidate);
      if (viaServer) {
        try {
          const res = await fetchWithAuth('/api/dlna/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ controlUrl: candidate, action: 'setUri', uri, title }),
          });
          if (res.ok) {
            await fetchWithAuth('/api/dlna/command', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ controlUrl: candidate, action: 'play' }),
            });
            return { ok: true, resolvedControlUrl: candidate };
          }
        } catch {
          // 继续下一个候选
        }
      } else {
        const didl = escapeXmlValue(
          `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${escapeXmlValue(
            title
          )}</dc:title><upnp:class>object.item.videoItem</upnp:class></item></DIDL-Lite>`
        );
        await soapDirect(
          candidate,
          'SetAVTransportURI',
          `<InstanceID>0</InstanceID><CurrentURI>${escapeXmlValue(uri)}</CurrentURI><CurrentURIMetaData>${didl}</CurrentURIMetaData>`
        );
        await new Promise((r) => setTimeout(r, 250));
        await soapDirect(candidate, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>');
        await new Promise((r) => setTimeout(r, 900));
      }
    }
    return { ok: false, error: '已尝试常见控制地址,请确认电视是否响应;也可输入完整控制地址' };
  }

  const result = await sendCommand(device, 'setUri', { uri, title });
  if (!result.ok) return { ok: false, error: result.error };
  await new Promise((r) => setTimeout(r, 300));
  await sendCommand(device, 'play');
  return { ok: true, resolvedControlUrl: device.controlUrl };
}

// ---------- 播放地址提取 ----------

/**
 * 从播放页的 videoUrl(可能是直链、站内相对代理)提取可用于投屏的原始直链。
 * 返回 null 表示该地址类型不支持投屏(如本地离线文件)。
 */
export function extractCastableUrl(videoUrl: string): { url: string; proxied: boolean } | null {
  if (!videoUrl) return null;
  if (/^https?:\/\//i.test(videoUrl)) {
    return { url: videoUrl, proxied: false };
  }
  if (videoUrl.startsWith('/')) {
    // 站内代理:提取上游直链
    try {
      const u = new URL(videoUrl, window.location.origin);
      const upstream = u.searchParams.get('url');
      if (upstream && /^https?:\/\//i.test(upstream)) {
        return { url: upstream, proxied: true };
      }
    } catch {
      // ignore
    }
    // 本地离线下载文件等无上游直链的站内地址,电视无法访问
    if (videoUrl.startsWith('/api/offline-download') || videoUrl.startsWith('/api/local')) {
      return null;
    }
    return { url: new URL(videoUrl, window.location.origin).toString(), proxied: true };
  }
  return null;
}

export function formatSeconds(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '--:--';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}
