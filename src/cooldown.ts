/** Limits each person to one nudge per window. In memory only, like everything else. */
export class UserCooldown {
  readonly #until = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  isCoolingDown(user: string, now = Date.now()): boolean {
    const until = this.#until.get(user);
    if (until === undefined) return false;
    if (until > now) return true;
    this.#until.delete(user);
    return false;
  }

  start(user: string, now = Date.now()): void {
    if (this.windowMs <= 0) return;
    this.#until.set(user, now + this.windowMs);
  }

  /** Undo `start`, e.g. when the nudge it was guarding never reached the person. */
  clear(user: string): void {
    this.#until.delete(user);
  }
}
