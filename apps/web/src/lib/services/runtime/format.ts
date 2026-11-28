// How the Runtime screens print numbers, times and ids. Pure and tested.

/** 850 ms · 12 s · 3 min 05 s · 1 h 02 min */
export const formatDurationMs = (ms: number | undefined | null): string => {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const totalSeconds = Math.round(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds} s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60)
        return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
    const hours = Math.floor(minutes / 60);
    return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
};

export const durationBetween = (
    from: string | undefined,
    to: string | undefined,
): number | undefined => {
    if (!from || !to) return undefined;
    const ms = Date.parse(to) - Date.parse(from);
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};

/** A 0..1 rate as a whole percentage; out-of-range input reads as unknown. */
export const formatRate = (rate: number | undefined | null): string => {
    if (rate == null || !Number.isFinite(rate) || rate < 0 || rate > 1)
        return "—";
    return `${Math.round(rate * 100)}%`;
};

export const shortSha = (sha: string | undefined) =>
    sha ? sha.slice(0, 7) : "—";

/** 14:02:09.112, in the viewer's time zone. */
export const formatClockTime = (at?: string) => {
    if (!at) return "--:--:--.---";
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return "--:--:--.---";
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

const BYTES_PER_GIB = 2 ** 30;
export const formatGiB = (bytes: number) =>
    `${(bytes / BYTES_PER_GIB).toFixed(1)} GiB`;

/** `acme/checkout-api` → `checkout-api`. */
export const shortRepositoryName = (name: string | undefined) =>
    name?.split("/").pop() || undefined;

/**
 * An estimated US$ amount (Run cost, list prices): two decimals at most, so
 * the screen never shows more precision than the estimate has.
 * null = could not be priced.
 */
export const formatEstimatedUsd = (usd: number | null | undefined): string => {
    if (usd == null || !Number.isFinite(usd) || usd < 0) return "—";
    if (usd === 0) return "$0.00";
    if (usd < 0.01) return "< $0.01";
    return `≈ $${usd.toFixed(2)}`;
};

/** 18:06:34, in UTC: the Run log's clock, the same for every reader. */
export const formatUtcClock = (at?: string) => {
    if (!at) return "--:--:--";
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return "--:--:--";
    return d.toISOString().slice(11, 19);
};
