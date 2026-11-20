/** Memory a Run may claim on the cell (docs/runtime/self-hosted.md): leave room for one. */
export const RUN_CLAIM_MEMORY_MB = 12 * 1024;

export interface CellSandboxFacts {
    allocatableMemoryMb: number | null;
    sandboxMemoryMb: number | null;
    sandboxCpus: number | null;
    poolReady: number | null;
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
