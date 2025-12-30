export class ConnectionTracker {
  private connections = new Set<string>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleTimeout: number;
  private readonly onIdle: () => void;

  constructor(idleTimeout: number, onIdle: () => void) {
    this.idleTimeout = idleTimeout;
    this.onIdle = onIdle;
  }

  add(connectionId: string): void {
    this.connections.add(connectionId);
    this.clearIdleTimer();
  }

  remove(connectionId: string): void {
    this.connections.delete(connectionId);
    if (this.connections.size === 0) {
      this.startIdleTimer();
    }
  }

  private startIdleTimer(): void {
    this.idleTimer = setTimeout(() => {
      this.onIdle();
    }, this.idleTimeout);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  get count(): number {
    return this.connections.size;
  }

  destroy(): void {
    this.clearIdleTimer();
    this.connections.clear();
  }
}
