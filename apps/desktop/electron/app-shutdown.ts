export interface PreventableQuitEvent {
  preventDefault(): void;
}

export interface AppShutdownOptions {
  shutdownBackend: () => Promise<void>;
  quit: () => void;
  onError?: (error: unknown) => void;
}

/** Coordinates Electron's re-entrant before-quit event around async cleanup. */
export function createBeforeQuitHandler(
  options: AppShutdownOptions,
): (event: PreventableQuitEvent) => void {
  let shutdownStarted = false;
  let shutdownComplete = false;

  return (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;

    void options.shutdownBackend().catch((error: unknown) => {
      options.onError?.(error);
    }).finally(() => {
      shutdownComplete = true;
      options.quit();
    });
  };
}
