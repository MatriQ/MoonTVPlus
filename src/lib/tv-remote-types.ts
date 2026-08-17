export type TVRemoteKey =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'ok'
  | 'back'
  | 'menu'
  | 'home'
  | 'playPause'
  | 'pageUp'
  | 'pageDown'
  | 'digit';

export type TVRemoteTextMode = 'replace' | 'append' | 'backspace' | 'clear';

export interface TVRemoteDevice {
  deviceId: string;
  deviceName: string;
  currentPath: string;
  title?: string;
  lastActiveAt: number;
}

export interface TVRemoteKeyCommand {
  key: TVRemoteKey;
  repeat?: boolean;
  digit?: string;
}

export interface TVRemoteTextCommand {
  mode: TVRemoteTextMode;
  text?: string;
}

/** 投屏到 TV 端:让电视播放指定影片(episodeIndex 为 0-based,与 /tv/play 的 index 一致) */
export interface TVRemotePlayMediaCommand {
  source: string;
  id: string;
  title: string;
  episodeIndex?: number;
  positionSec?: number;
  fileName?: string;
}
