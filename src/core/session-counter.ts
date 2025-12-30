interface SessionData {
  lastAccess: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class SessionAccessCounter {
  private sessions: Map<string, SessionData> = new Map();
  private readonly timeout: number;
  private readonly onTimeout: (sessionId: string) => void;

  constructor(timeout: number, onTimeout: (sessionId: string) => void) {
    this.timeout = timeout;
    this.onTimeout = onTimeout;
  }

  access(sessionId: string): void {
    const existing = this.sessions.get(sessionId);

    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.onTimeout(sessionId);
      this.sessions.delete(sessionId);
    }, this.timeout);

    this.sessions.set(sessionId, {
      lastAccess: Date.now(),
      timer,
    });
  }

  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.timer) {
      clearTimeout(session.timer);
    }
    this.sessions.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }

  getLastAccess(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.lastAccess ?? null;
  }

  destroy(): void {
    for (const [, session] of this.sessions) {
      if (session.timer) {
        clearTimeout(session.timer);
      }
    }
    this.sessions.clear();
  }
}
