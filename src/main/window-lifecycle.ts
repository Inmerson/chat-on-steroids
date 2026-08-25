export interface PresentableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** Show a live window, or replace a BrowserWindow that Electron has already destroyed. */
export function presentWindow(window: PresentableWindow | null, createWindow: () => void): void {
  if (!window || window.isDestroyed()) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** A new launch during asynchronous shutdown must be relaunched after the old process exits. */
export function secondInstanceAction(quitting: boolean, shutdownStarted: boolean): 'show' | 'relaunch' {
  return quitting || shutdownStarted ? 'relaunch' : 'show';
}
