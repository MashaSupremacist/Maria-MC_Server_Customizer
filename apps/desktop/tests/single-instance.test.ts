import { describe, expect, it, vi } from 'vitest';
import {
  acquireSingleInstanceOwnership,
  focusPrimaryWindow,
  type FocusableWindow,
} from '../electron/single-instance';

function createWindow(overrides: Partial<FocusableWindow> = {}): FocusableWindow {
  return {
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    isVisible: vi.fn(() => true),
    show: vi.fn(),
    focus: vi.fn(),
    ...overrides,
  };
}

describe('single-instance ownership', () => {
  it('quits a losing instance without registering startup behavior', () => {
    const quit = vi.fn();
    const onSecondInstance = vi.fn();

    const ownsSingleInstance = acquireSingleInstanceOwnership({
      requestLock: () => false,
      quit,
      onSecondInstance,
      getWindow: () => null,
    });

    expect(ownsSingleInstance).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(onSecondInstance).not.toHaveBeenCalled();
  });

  it('restores, shows, and focuses the primary window on a second instance', () => {
    const calls: string[] = [];
    const window = createWindow({
      isMinimized: () => true,
      restore: () => calls.push('restore'),
      isVisible: () => false,
      show: () => calls.push('show'),
      focus: () => calls.push('focus'),
    });
    let secondInstanceListener: (() => void) | undefined;
    const quit = vi.fn();

    const ownsSingleInstance = acquireSingleInstanceOwnership({
      requestLock: () => true,
      quit,
      onSecondInstance: (listener) => {
        secondInstanceListener = listener;
      },
      getWindow: () => window,
    });

    expect(ownsSingleInstance).toBe(true);
    expect(quit).not.toHaveBeenCalled();
    expect(secondInstanceListener).toBeTypeOf('function');

    secondInstanceListener?.();
    expect(calls).toEqual(['restore', 'show', 'focus']);
  });
});

describe('focusPrimaryWindow', () => {
  it('only focuses a visible, non-minimized window', () => {
    const window = createWindow();

    focusPrimaryWindow(window);

    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it('does nothing while the primary window is not yet available', () => {
    expect(() => focusPrimaryWindow(null)).not.toThrow();
  });
});
