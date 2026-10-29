/**
 * The native host reports when an agent's MCP client goes away. Its session is released after a
 * short grace period, so a client that only reconnected keeps its tabs; a released session's tabs
 * stay open and recorded, which is what lets the next session with the same label adopt them
 * instead of opening a new group (ADR-0025).
 */
export class SessionEndings {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly release: (sessionId: string) => Promise<void>,
    private readonly graceMs = 5_000,
    private readonly schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout
  ) {}

  ended(sessionId: string): void {
    this.resumed(sessionId);
    this.timers.set(sessionId, this.schedule(() => {
      this.timers.delete(sessionId);
      void this.release(sessionId);
    }, this.graceMs));
  }

  /* Any request from the session proves it is still there. */
  resumed(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer === undefined) return;
    this.cancel(timer);
    this.timers.delete(sessionId);
  }
}

export function isSessionEnded(value: unknown): value is { kind: "session_ended"; sessionId: string; hostId: string } {
  return typeof value === "object" && value !== null
    && (value as { kind?: unknown }).kind === "session_ended"
    && typeof (value as { sessionId?: unknown }).sessionId === "string" && (value as { sessionId: string }).sessionId.length > 0
    && typeof (value as { hostId?: unknown }).hostId === "string";
}
