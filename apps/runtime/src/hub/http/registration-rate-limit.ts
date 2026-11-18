/**
 * Attempts at /cells/register one client address may make in a window, per
 * hub replica. The route takes connections without a client certificate, so
 * a caller guessing tokens is slowed down before the token is even looked up.
 */
export const REGISTRATION_ATTEMPTS_PER_WINDOW = 10;
export const REGISTRATION_WINDOW_MS = 60_000;

/** Addresses tracked at once; past it the oldest windows are forgotten first. */
const MAX_TRACKED_ADDRESSES = 10_000;

/** A fixed-window counter per client address. */
export class RegistrationRateLimit {
    private readonly windows = new Map<string, { startedAt: number; attempts: number }>();

    constructor(
        private readonly limit = REGISTRATION_ATTEMPTS_PER_WINDOW,
        private readonly windowMs = REGISTRATION_WINDOW_MS,
    ) {}

    /** Whether this attempt from `address` may go on; every call counts. */
    allow(address: string, nowMs: number): boolean {
        const w = this.windows.get(address);
        if (!w || nowMs - w.startedAt >= this.windowMs) {
            this.windows.delete(address);
            if (this.windows.size >= MAX_TRACKED_ADDRESSES) this.windows.delete(this.windows.keys().next().value!);
            this.windows.set(address, { startedAt: nowMs, attempts: 1 });
            return true;
        }
        w.attempts++;
        return w.attempts <= this.limit;
    }
}
