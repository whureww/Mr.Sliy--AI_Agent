import { DownloadState } from '../ipc/client';

/**
 * 全局共享的安装包下载状态。
 * 设置页与顶部更新横幅是两个独立挂载的 UI,各自轮询/触发下载;
 * 任一处状态变化(开始下载/进度/完成/失败/取消)都写入此 store,
 * 另一处通过订阅即时同步,避免"设置页在下,Banner 还显示下载按钮"。
 */
let current: DownloadState | null = null;
const listeners = new Set<(s: DownloadState | null) => void>();

export function getUpdateDl(): DownloadState | null {
  return current;
}

/** 写入并广播最新下载状态(null = 复位为空闲) */
export function setUpdateDl(s: DownloadState | null): void {
  current = s;
  for (const fn of listeners) fn(s);
}

/** 订阅状态变化,返回取消订阅函数 */
export function subscribeUpdateDl(fn: (s: DownloadState | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
