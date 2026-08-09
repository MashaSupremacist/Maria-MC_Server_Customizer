import { vi } from 'vitest';
import type { MscBridge } from '../../../electron/preload';

export function installMscMock(overrides: Partial<MscBridge> = {}): MscBridge {
  const fallback = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  const bridge = new Proxy(overrides as MscBridge, {
    get(target, property, receiver) {
      const existing = Reflect.get(target, property, receiver);
      if (existing !== undefined) return existing;
      let mock = fallback.get(property);
      if (!mock) {
        mock = vi.fn();
        fallback.set(property, mock);
      }
      return mock;
    },
  });
  Object.defineProperty(window, 'msc', { value: bridge, configurable: true });
  return bridge;
}
