#!/usr/bin/env node
/**
 * Mock DLNA MediaRenderer,用于无真机环境下端到端测试投屏链路。
 *
 * 启动后:
 *   1. HTTP 服务(默认 :9197):
 *      - GET /ddxml            设备描述 XML(含 AVTransport controlURL)
 *      - POST /ctrl/avtransport 接收 SOAP(SetAVTransportURI/Play/Pause/Stop/Seek/GetPositionInfo)
 *        并按指令返回/记录状态,日志实时打印
 *   2. SSDP 响应:加入组播 239.255.255.250:1900,对 M-SEARCH 回 LOCATION 指向本机描述 XML
 *
 * 用法: node scripts/mock-dlna-device.js [--port 9197] [--name "Mock TV"]
 * 验证流代理时可配合: node scripts/mock-dlna-device.js 后从 /api/dlna/discover 应能看到设备
 */

const http = require('http');
const dgram = require('dgram');

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(getArg('port', 9197));
const NAME = getArg('name', 'Mock DLNA TV');

// ---- 播放器模拟状态 ----
const state = {
  uri: null,
  transportState: 'STOPPED',
  relTime: 0,
  duration: 5400,
  startedAt: null,
};

function xml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relTimeStr(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function currentRelTime() {
  if (state.transportState === 'PLAYING' && state.startedAt) {
    return state.relTime + (Date.now() - state.startedAt) / 1000;
  }
  return state.relTime;
}

const descriptionXml = `<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>${xml(NAME)}</friendlyName>
    <manufacturer>MoonTV Test</manufacturer>
    <modelName>MockRenderer</modelName>
    <UDN>uuid:2fac1234-31f8-11b4-a222-08002b34c00${PORT % 10}</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <controlURL>/ctrl/avtransport</controlURL>
        <eventSubURL>/evt/avtransport</eventSubURL>
        <SCPDURL>/scpd/avtransport.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && (url === '/ddxml' || url === '/description.xml')) {
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end(descriptionXml);
    return;
  }
  // 用于测试 MoonTV 流代理的 m3u8 重写:混合绝对/相对/key URI 三种行
  if (req.method === 'GET' && url === '/test.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-KEY:METHOD=AES-128,URI="enc.key"\n#EXTINF:10.0,\nseg001.ts\n#EXTINF:10.0,\n/media/seg002.ts\n#EXTINF:10.0,\nhttps://upstream.example.com/abs/seg003.ts\n#EXT-X-ENDLIST\n');
    return;
  }
  if (req.method === 'POST' && url === '/ctrl/avtransport') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const action = (req.headers.soapaction || '').match(/#(\w+)"?$/) || [];
      const act = action[1] || 'Unknown';
      let inner = '';
      if (/Play/.test(act) && /Speed/.test(body)) {
        state.transportState = 'PLAYING';
        state.startedAt = Date.now();
      } else if (/Pause/.test(act)) {
        state.relTime = currentRelTime();
        state.startedAt = null;
        state.transportState = 'PAUSED_PLAYBACK';
      } else if (/Stop/.test(act)) {
        state.relTime = 0;
        state.startedAt = null;
        state.transportState = 'STOPPED';
      } else if (/SetAVTransportURI/.test(act)) {
        const m = body.match(/<CurrentURI>([\s\S]*?)<\/CurrentURI>/);
        state.uri = m ? m[1] : null;
        state.relTime = 0;
        state.transportState = 'STOPPED';
        state.startedAt = null;
        console.log(`[SET-URI] ${state.uri}`);
      } else if (/Seek/.test(act)) {
        const m = body.match(/<Target>([\s\S]*?)<\/Target>/);
        if (m) {
          const p = m[1].split(':').map(Number);
          state.relTime = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : state.relTime;
          state.startedAt = state.transportState === 'PLAYING' ? Date.now() : null;
        }
      } else if (/GetPositionInfo/.test(act)) {
        inner =
          `<Track>1</Track>` +
          `<TrackDuration>${relTimeStr(state.duration)}</TrackDuration>` +
          `<TrackMetaData></TrackMetaData>` +
          `<TrackURI>${xml(state.uri || '')}</TrackURI>` +
          `<RelTime>${relTimeStr(currentRelTime())}</RelTime>` +
          `<AbsTime>${relTimeStr(currentRelTime())}</AbsTime>` +
          `<RelCount>2147483647</RelCount><AbsCount>2147483647</AbsCount>`;
      }
      console.log(`[SOAP] ${act}  state=${state.transportState}  rel=${relTimeStr(currentRelTime())}`);
      const soapBody = inner
        ? `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${act}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">${inner}</u:${act}Response></s:Body></s:Envelope>`
        : `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${act}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"></u:${act}Response></s:Body></s:Envelope>`;
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(soapBody);
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-dlna] HTTP on :${PORT}  description: /ddxml  control: /ctrl/avtransport`);
});

// ---- SSDP ----
const ssdp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
ssdp.on('message', (msg, rinfo) => {
  const text = msg.toString();
  if (!/^M-SEARCH/i.test(text)) return;
  const myIp = (() => {
    const os = require('os');
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const it of ifs[name] || []) {
        if (it.family === 'IPv4' && !it.internal) return it.address;
      }
    }
    return '127.0.0.1';
  })();
  const st = (text.match(/^ST:\s*(.+)$/im) || [])[1] || 'ssdp:all';
  const response = [
    'HTTP/1.1 200 OK',
    'CACHE-CONTROL: max-age=1800',
    `DATE: ${new Date().toUTCString()}`,
    'EXT:',
    `LOCATION: http://${myIp}:${PORT}/ddxml`,
    'SERVER: Linux UPnP/1.0 MoonTVMock/1.0',
    'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
    'USN: uuid:2fac1234-31f8-11b4-a222-08002b34c00' + (PORT % 10) + '::urn:schemas-upnp-org:device:MediaRenderer:1',
    'CONTENT-LENGTH: 0',
    '',
    '',
  ].join('\r\n');
  ssdp.send(response, rinfo.port, rinfo.address);
  console.log(`[ssdp] M-SEARCH(${st.trim()}) from ${rinfo.address} -> responded LOCATION`);
});

ssdp.bind(1900, () => {
  try {
    ssdp.addMembership('239.255.255.250');
    console.log('[mock-dlna] SSDP responder on :1900 (239.255.255.250)');
  } catch (e) {
    console.warn('[mock-dlna] SSDP multicast join failed:', e.message);
  }
});

process.on('SIGINT', () => {
  console.log('\n[mock-dlna] shutting down');
  try { ssdp.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});
