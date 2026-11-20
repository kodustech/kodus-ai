import type { SandboxCapacityView } from "../contracts";

/** A Run claim of this size must still fit when the sandboxes are idle (docs/runtime/self-hosted.md). */
export const RUN_CLAIM_MEMORY_MB = 12 * 1024;

export const MAX_CONCURRENT_LIMIT = 100;

/** Queue waits offered; the saved value is added when it is not one of them. */
export const WAIT_CHOICES_MINUTES = [1, 2, 5, 10, 15, 30, 60] as const;

export const CELL_HOST_HINT =
    "Set on the cell host (-sandbox-memory-mb, -sandbox-cpus, -sandbox-pool); not editable here.";

/** 72_000 -> "1m12s"; 45_000 -> "45s"; 0 -> "0s". */
export function formatWait(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

export const waitLabel = (minutes: number) =>
    minutes === 60 ? "1 hour" : `${minutes} min`;

/** "" = no cap; otherwise an integer 1..100. */
export function parseMaxConcurrent(
    text: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
    const t = text.trim();
    if (t === "") return { ok: true, value: null };
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENT_LIMIT) {
        return {
            ok: false,
            error: `Use a whole number from 1 to ${MAX_CONCURRENT_LIMIT}, or leave it empty for no limit.`,
        };
    }
    return { ok: true, value: n };
}

/**
 * The cap against the cell's memory: null when it fits (or when the cell is
 * not known, or there is no cap), a sentence when it does not.
 */
export function capacityWarning(
    maxConcurrent: number | null,
    cell: SandboxCapacityView["cell"],
): string | null {
    if (maxConcurrent === null || !cell) return null;
    const { allocatableMemoryMb: total, sandboxMemoryMb: each } = cell;
    if (!total || !each) return null;
    const needed = maxConcurrent * each;
    if (needed > total) {
        return `${maxConcurrent} sandboxes of ${each} MB need ${needed} MB, more than the ${total} MB the cell can commit. Reviews would be refused instead of waiting.`;
    }
    if (total - needed < RUN_CLAIM_MEMORY_MB) {
        return `With ${maxConcurrent} sandboxes in use, only ${total - needed} MB stay free: a 12 GB Run would not fit and would be refused.`;
    }
    return null;
}

export const sizeLabel = (mb: number, cpus: number | null) =>
    `${mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`}${cpus ? ` · ${cpus} CPU` : ""}`;
