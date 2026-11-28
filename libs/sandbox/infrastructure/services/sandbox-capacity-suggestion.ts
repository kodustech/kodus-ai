/** Memory a Run may claim on the cell (docs/runtime/self-hosted.md): leave room for one. */
export const RUN_CLAIM_MEMORY_MB = 12 * 1024;

export interface CellSandboxFacts {
    allocatableMemoryMb: number | null;
    sandboxMemoryMb: number | null;
    sandboxCpus: number | null;
    poolReady: number | null;
    poolTarget: number | null;
}

/**
 * Sandboxes that fit the cell's memory, minus room for one 12 GB Run claim.
 * null when the cell's memory or the sandbox size is not known.
 */
export function suggestMaxConcurrent(
    cell: Pick<CellSandboxFacts, 'allocatableMemoryMb' | 'sandboxMemoryMb'> | null,
): number | null {
    if (!cell?.allocatableMemoryMb || !cell.sandboxMemoryMb) return null;
    const withRun = Math.floor(
        (cell.allocatableMemoryMb - RUN_CLAIM_MEMORY_MB) / cell.sandboxMemoryMb,
    );
    const whole = Math.floor(cell.allocatableMemoryMb / cell.sandboxMemoryMb);
    return Math.max(1, withRun >= 1 ? withRun : whole);
}

export interface LiveCellFacts {
    allocatableMb: number | null;
    sandboxMemoryMb: number | null;
    sandboxCpus: number | null;
    /** The warm pool the cell's heartbeat reported; null for a cell older than the field or without a pool. */
    poolReady?: number | null;
    poolTarget?: number | null;
}

/**
 * One CellSandboxFacts for the install's live cells: allocatable memory is the SUM over the cells that reported
 * it; the sandbox size is the LARGEST any cell runs (so the suggestion never over-promises on a mixed fleet).
 * poolReady and poolTarget are the SUM over the cells that reported a pool, null when none did (older cells).
 * null when there is no live cell.
 */
export function aggregateCellFacts(cells: readonly LiveCellFacts[]): CellSandboxFacts | null {
    if (cells.length === 0) return null;
    const reported = cells.filter((c) => c.allocatableMb != null && c.allocatableMb > 0);
    const biggest = cells.reduce<LiveCellFacts | null>(
        (best, c) => (c.sandboxMemoryMb != null && (!best || c.sandboxMemoryMb > (best.sandboxMemoryMb ?? 0)) ? c : best),
        null,
    );
    return {
        allocatableMemoryMb: reported.length ? reported.reduce((n, c) => n + (c.allocatableMb as number), 0) : null,
        sandboxMemoryMb: biggest?.sandboxMemoryMb ?? null,
        sandboxCpus: biggest?.sandboxCpus ?? null,
        poolReady: sumReported(cells.map((c) => c.poolReady)),
        poolTarget: sumReported(cells.map((c) => c.poolTarget)),
    };
}

function sumReported(values: readonly (number | null | undefined)[]): number | null {
    const reported = values.filter((v): v is number => v != null);
    return reported.length ? reported.reduce((n, v) => n + v, 0) : null;
}
