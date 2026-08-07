import type { MscBridge } from '../../electron/preload';

declare global {
  interface Window {
    msc: MscBridge;
  }
}

export {};
