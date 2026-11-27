// A template build runs inside one fleet process (template-trigger.ts `start`): a restart or deploy drops it with
// the row left `building` and nobody to finish it, and the row then holds its fingerprint for 3 hours
// (template-store.ts `holds`, `begin`), so Runs boot cold meanwhile. This is the pure rule the rebuild pass uses to
// tell a dead build from a live one (docs/runtime/host-providers.md §8.2).

/** Failure prefix of a build the watchdog ended: the rebuild pass starts it again at once, with no failure backoff. */
export const WATCHDOG_FAILURE_PREFIX = 'watchdog:';
/** A build is not judged by its host before this: the row is written before the setup host exists and the host takes minutes to boot. */
export const BUILD_BOOT_GRACE_MS = 15 * 60_000;
/** The longest a live build can take: the bake wait (1 h), the seal (30 min) and the save poll fit under it, and under the 3 h hold. */
export const BUILD_CEILING_MS = 150 * 60_000;

export type StaleBuildReason = 'cell_base_changed' | 'setup_host_gone' | 'build_timeout';

export interface BuildingTemplateFacts {
    setupHostId: string | null;
    cellBase: string;
    /** ms since the row was last touched. */
    idleMs: number;
}

/**
 * Why a `building` row is dead, or null while it may still be alive.
 * - `cell_base_changed`: the pool moved to another cell base, so what this build makes would serve nothing; ends at once.
 * - `setup_host_gone`: past the boot grace, the provider lists no live host with the row's setup host id (null: the
 *   provider could not be asked, which says nothing).
 * - `build_timeout`: no row can build for longer than the ceiling.
 */
export function staleBuild(row: BuildingTemplateFacts, now: { poolCellBase: string; liveSetupHosts: ReadonlySet<string> | null }): StaleBuildReason | null {
    if (row.cellBase !== now.poolCellBase) return 'cell_base_changed';
    if (row.idleMs > BUILD_CEILING_MS) return 'build_timeout';
    if (row.idleMs > BUILD_BOOT_GRACE_MS && now.liveSetupHosts && (!row.setupHostId || !now.liveSetupHosts.has(row.setupHostId))) return 'setup_host_gone';
    return null;
}
