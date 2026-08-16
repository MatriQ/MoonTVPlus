'use client';

/**
 * DLNA 投屏面板(右侧 Drawer)
 * - 设备发现(服务端 SSDP,自建部署可用)/ 手动添加(IP 或完整控制地址)
 * - 投屏:直链经服务端签名代理(moontv.hids.vip/api/dlna/proxy)供电视拉流,规避防盗链
 * - 投屏中:播放/暂停/Seek±30s/停止;换集自动重投
 */

import { Cast, Loader2, MonitorPlay, Pause, Play, Plus, RefreshCw, Square, Trash2, Tv } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import Drawer from '@/components/Drawer';
import {
  castToDevice,
  discoverDevices,
  extractCastableUrl,
  formatSeconds,
  loadManualDevices,
  normalizeManualDeviceInput,
  prepareCastUri,
  saveManualDevices,
  sendCommand,
  type DlnaDevice,
} from '@/lib/dlna-client';

export interface DlnaCastPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** 播放页原始 videoUrl(直链或站内相对代理),变化时触发自动重投 */
  currentUrl: string;
  getTitle: () => string;
  /** 投屏开始:本机播放器暂停 */
  onCastingStart?: () => void;
  /** 投屏结束 */
  onCastingStop?: () => void;
}

interface CastingState {
  device: DlnaDevice;
  /** 候选模式成功后回填的具体控制地址 */
  controlUrl?: string;
  title: string;
  uri: string;
}

export default function DlnaCastPanel({
  isOpen,
  onClose,
  currentUrl,
  getTitle,
  onCastingStart,
  onCastingStop,
}: DlnaCastPanelProps) {
  const [discovered, setDiscovered] = useState<DlnaDevice[]>([]);
  const [manualDevices, setManualDevices] = useState<DlnaDevice[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState('');
  const [casting, setCasting] = useState<CastingState | null>(null);
  const [castingBusy, setCastingBusy] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [position, setPosition] = useState<{ rel: number | null; duration: number | null }>({
    rel: null,
    duration: null,
  });
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const castingRef = useRef<CastingState | null>(null);

  useEffect(() => {
    castingRef.current = casting;
  }, [casting]);

  useEffect(() => {
    setManualDevices(loadManualDevices());
  }, []);

  const runDiscover = useCallback(async () => {
    setSearching(true);
    setSearchError(null);
    try {
      const devices = await discoverDevices(4000);
      setDiscovered(devices);
      if (devices.length === 0) {
        setSearchError('未发现设备。若 MoonTV 部署在云端,服务端无法扫描家庭网络,请在下方手动添加电视 IP');
      }
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : '搜索失败');
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen && discovered.length === 0 && !searching) {
      void runDiscover();
    }
  }, [isOpen, discovered.length, searching, runDiscover]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startPolling = useCallback((controlUrl: string) => {
    stopPolling();
    pollTimerRef.current = setInterval(async () => {
      const current = castingRef.current;
      if (!current) return;
      const res = await sendCommand({ ...current.device, controlUrl }, 'getInfo');
      if (res.ok && res.info && res.info.relTimeSec !== null) {
        setPosition({ rel: res.info.relTimeSec, duration: res.info.durationSec });
      }
    }, 5000);
  }, [stopPolling]);

  const doCast = useCallback(
    async (device: DlnaDevice) => {
      const extracted = extractCastableUrl(currentUrl);
      if (!extracted) {
        setStatusText('当前视频不支持投屏(本地离线文件或地址无法公开访问)');
        return;
      }
      const title = getTitle();
      setCastingBusy(true);
      setStatusText('正在生成投屏地址...');
      try {
        const uri = await prepareCastUri(extracted.url, 'proxy');
        setStatusText(device.controlUrl.startsWith('dlna-candidates://') ? '正在尝试常见控制地址,请留意电视...' : '正在投屏...');
        const result = await castToDevice(device, uri, title, (candidate) => {
          setStatusText(`尝试 ${candidate} ...`);
        });
        if (result.ok) {
          const state: CastingState = {
            device,
            controlUrl: result.resolvedControlUrl,
            title,
            uri,
          };
          setCasting(state);
          castingRef.current = state;
          setPosition({ rel: null, duration: null });
          if (result.resolvedControlUrl) startPolling(result.resolvedControlUrl);
          onCastingStart?.();
          setStatusText(null);
        } else {
          setStatusText(result.error || '投屏失败');
        }
      } catch (error) {
        setStatusText(error instanceof Error ? error.message : '投屏失败');
      } finally {
        setCastingBusy(false);
      }
    },
    [currentUrl, getTitle, onCastingStart, startPolling]
  );

  // 换集自动重投
  useEffect(() => {
    const current = castingRef.current;
    if (!isOpen || !current || castingBusy) return;
    const extracted = extractCastableUrl(currentUrl);
    if (!extracted) return;
    void (async () => {
      setCastingBusy(true);
      try {
        const uri = await prepareCastUri(extracted.url, 'proxy');
        const target = current.controlUrl || current.device.controlUrl;
        await sendCommand({ ...current.device, controlUrl: target }, 'setUri', { uri, title: getTitle() });
        await new Promise((r) => setTimeout(r, 300));
        await sendCommand({ ...current.device, controlUrl: target }, 'play');
        setCasting({ ...current, uri, title: getTitle() });
        setPosition({ rel: null, duration: null });
      } catch {
        setStatusText('换集重投失败,请停止后重新投屏');
      } finally {
        setCastingBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUrl]);

  const stopCasting = useCallback(async () => {
    const current = castingRef.current;
    stopPolling();
    if (current) {
      const target = current.controlUrl || current.device.controlUrl;
      await sendCommand({ ...current.device, controlUrl: target }, 'stop').catch(() => undefined);
    }
    setCasting(null);
    castingRef.current = null;
    onCastingStop?.();
  }, [onCastingStop, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const addManualDevice = () => {
    const device = normalizeManualDeviceInput(manualInput);
    if (!device) {
      setSearchError('请输入有效的 IP 地址(如 192.168.1.100)或完整控制 URL(http://ip:port/path)');
      return;
    }
    const next = [...manualDevices.filter((d) => d.id !== device.id), device];
    setManualDevices(next);
    saveManualDevices(next);
    setManualInput('');
    setSearchError(null);
  };

  const removeManualDevice = (id: string) => {
    const next = manualDevices.filter((d) => d.id !== id);
    setManualDevices(next);
    saveManualDevices(next);
  };

  const sendControl = async (action: 'play' | 'pause' | 'stop', deltaSec?: number) => {
    const current = castingRef.current;
    if (!current) return;
    const target = current.controlUrl || current.device.controlUrl;
    if (action === 'stop') {
      await stopCasting();
      return;
    }
    if (deltaSec !== undefined && position.rel !== null) {
      await sendCommand({ ...current.device, controlUrl: target }, 'seek', {
        positionSec: Math.max(0, position.rel + deltaSec),
      });
      return;
    }
    if (deltaSec === undefined) {
      await sendCommand({ ...current.device, controlUrl: target }, action);
    }
  };

  const renderDeviceItem = (device: DlnaDevice, removable: boolean) => (
    <div
      key={device.id}
      className='flex items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2.5 hover:border-sky-400 dark:hover:border-sky-500 transition-colors'
    >
      <button
        type='button'
        disabled={castingBusy}
        onClick={() => void doCast(device)}
        className='flex items-center gap-2.5 flex-1 min-w-0 text-left disabled:opacity-50'
      >
        <Tv size={18} className='text-sky-500 shrink-0' />
        <span className='truncate text-sm text-gray-800 dark:text-gray-200'>{device.name}</span>
      </button>
      {removable && (
        <button
          type='button'
          onClick={() => removeManualDevice(device.id)}
          className='p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-900/30 text-gray-400 hover:text-red-500 shrink-0'
          title='删除'
        >
          <Trash2 size={15} />
        </button>
      )}
    </div>
  );

  return (
    <Drawer isOpen={isOpen} onClose={onClose} title='DLNA 投屏' width='w-full md:w-[26rem]'>
      <div className='p-4 space-y-4'>
        {statusText && (
          <div className='rounded-lg bg-sky-50 dark:bg-sky-900/30 border border-sky-200 dark:border-sky-800 px-3 py-2 text-xs text-sky-700 dark:text-sky-300 flex items-center gap-2'>
            {castingBusy && <Loader2 size={13} className='animate-spin shrink-0' />}
            <span className='break-all'>{statusText}</span>
          </div>
        )}

        {casting ? (
          <>
            <div className='rounded-xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-4'>
              <div className='flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-300'>
                <MonitorPlay size={16} />
                正在投屏到 {casting.device.name}
              </div>
              <div className='mt-1.5 text-xs text-gray-500 dark:text-gray-400 truncate' title={casting.title}>
                {casting.title}
              </div>
              <div className='mt-2 text-xs font-mono text-gray-500 dark:text-gray-400'>
                {formatSeconds(position.rel)} / {formatSeconds(position.duration)}
                {position.rel === null && ' (直发模式无法回显进度)'}
              </div>
            </div>

            <div className='grid grid-cols-4 gap-2'>
              <button
                type='button'
                onClick={() => void sendControl('pause')}
                className='flex flex-col items-center gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 py-2.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors'
              >
                <Pause size={16} /> 暂停
              </button>
              <button
                type='button'
                onClick={() => void sendControl('play')}
                className='flex flex-col items-center gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 py-2.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors'
              >
                <Play size={16} /> 播放
              </button>
              <button
                type='button'
                onClick={() => void sendControl('play', -30)}
                className='flex flex-col items-center gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 py-2.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors'
              >
                <span className='text-base leading-none'>↺</span> -30s
              </button>
              <button
                type='button'
                onClick={() => void sendControl('play', 30)}
                className='flex flex-col items-center gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 py-2.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors'
              >
                <span className='text-base leading-none'>↻</span> +30s
              </button>
            </div>

            <button
              type='button'
              onClick={() => void sendControl('stop')}
              className='w-full flex items-center justify-center gap-2 rounded-lg bg-red-500 hover:bg-red-600 text-white py-2.5 text-sm font-medium transition-colors'
            >
              <Square size={14} /> 停止投屏
            </button>

            <div className='text-xs text-gray-400 dark:text-gray-500 leading-relaxed'>
              投屏后本页播放器已暂停;切换剧集会自动在电视上重新播放。若电视画面未更新,请点击"停止投屏"后重试。
            </div>
          </>
        ) : (
          <>
            <div className='flex items-center justify-between'>
              <h3 className='text-sm font-semibold text-gray-700 dark:text-gray-300'>可用设备</h3>
              <button
                type='button'
                onClick={() => void runDiscover()}
                disabled={searching}
                className='flex items-center gap-1.5 text-xs text-sky-600 dark:text-sky-400 hover:underline disabled:opacity-50'
              >
                <RefreshCw size={13} className={searching ? 'animate-spin' : ''} />
                {searching ? '搜索中...' : '重新搜索'}
              </button>
            </div>

            {discovered.length > 0 && (
              <div className='space-y-2'>{discovered.map((d) => renderDeviceItem(d, false))}</div>
            )}

            {searchError && (
              <div className='rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 leading-relaxed'>
                {searchError}
              </div>
            )}

            {manualDevices.length > 0 && (
              <div className='space-y-2 pt-1'>
                <div className='text-xs text-gray-400 dark:text-gray-500'>手动添加的设备</div>
                {manualDevices.map((d) => renderDeviceItem(d, true))}
              </div>
            )}

            <div className='pt-2 border-t border-gray-200 dark:border-gray-700'>
              <div className='flex gap-2'>
                <input
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addManualDevice();
                  }}
                  placeholder='电视 IP,如 192.168.1.100'
                  className='flex-1 min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-800 dark:text-gray-200 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-sky-500'
                />
                <button
                  type='button'
                  onClick={addManualDevice}
                  className='flex items-center gap-1 rounded-lg bg-sky-500 hover:bg-sky-600 text-white px-3 text-sm transition-colors'
                >
                  <Plus size={14} /> 添加
                </button>
              </div>
              <div className='mt-2 text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed'>
                云端部署时自动搜索不可用:输入电视 IP(自动尝试常见控制端口),或输入完整控制地址
                (http://IP:端口/路径)。要求浏览器与电视在同一网络。
              </div>
            </div>

            <div className='flex items-start gap-2 text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed pt-1'>
              <Cast size={13} className='mt-0.5 shrink-0' />
              投屏走 MoonTV 服务器代理拉流,可绕过资源站防盗链;电视需能访问本站点地址。
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}
