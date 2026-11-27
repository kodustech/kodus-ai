/**
 * Named readings of what a process keeps in memory outside a job (a cache,
 * a pool), read once per window by the worker's memory line. A component
 * registers a reader when it is built; the reader must be cheap and must
 * never throw into the caller.
 */
export type MemoryGauge = () => Record<string, number>;

const gauges = new Map<string, MemoryGauge>();

/** Registers (or replaces) the reader for `name`. */
export function registerMemoryGauge(name: string, read: MemoryGauge): void {
    gauges.set(name, read);
}

/** Every gauge's reading; a reader that throws is reported as an error. */
export function readMemoryGauges(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [name, read] of gauges) {
        try {
            out[name] = read();
        } catch {
            out[name] = { error: 1 };
        }
    }
    return out;
}

/** Test seam. */
export function clearMemoryGauges(): void {
    gauges.clear();
}
