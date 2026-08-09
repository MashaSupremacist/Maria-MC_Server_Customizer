/** Minimal window surface needed to restore and focus the primary instance. */
export interface FocusableWindow {
  isMinimized: () => boolean;
  restore: () => void;
  isVisible: () => boolean;
  show: () => void;
  focus: () => void;
}

export interface SingleInstanceOwnershipOptions {
  requestLock: () => boolean;
  quit: () => void;
  onSecondInstance: (listener: () => void) => void;
  getWindow: () => FocusableWindow | null;
}

/** Restore, reveal, and focus the existing desktop window when possible. */
export function focusPrimaryWindow(window: FocusableWindow | null): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

/**
 * Claim ownership of the app's data/process boundary before initialization.
 * The losing process quits without registering any startup work.
 */
export function acquireSingleInstanceOwnership(
  options: SingleInstanceOwnershipOptions,
): boolean {
  if (!options.requestLock()) {
    options.quit();
    return false;
  }

  options.onSecondInstance(() => {
    focusPrimaryWindow(options.getWindow());
  });
  return true;
}
