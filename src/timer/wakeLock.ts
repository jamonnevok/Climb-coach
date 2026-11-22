/**
 * Screen Wake Lock: keeps the screen on during guided sessions.
 * The browser releases the lock when the tab is hidden; we re-acquire on visibilitychange.
 */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;
  private onVisibility = () => {
    if (this.wanted && document.visibilityState === 'visible') void this.acquire();
  };

  static supported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  get active(): boolean {
    return !!this.sentinel && !this.sentinel.released;
  }

  async enable(): Promise<boolean> {
    this.wanted = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    return this.acquire();
  }

  async disable(): Promise<void> {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    try {
      await this.sentinel?.release();
    } catch {
      /* ignore */
    }
    this.sentinel = null;
  }

  private async acquire(): Promise<boolean> {
    if (!ScreenWakeLock.supported()) return false;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      return true;
    } catch {
      return false; // e.g. battery saver, or page not visible
    }
  }
}
