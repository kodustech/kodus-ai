/**
 * A repository the user selected as a source of GLOBAL Kody Rules. The sync
 * engine scans each of these repos and imports their rule files into the
 * org-wide `"global"` scope (see `KodyRulesSyncService.syncRepositoryGlobal`).
 *
 * Persisted as the value of the `GLOBAL_RULES_SOURCE_REPOSITORIES` organization
 * parameter.
 */
export interface GlobalRulesSourceRepository {
    id: string;
    name: string;
    fullName?: string;
}

export interface GlobalRulesSourceConfig {
    repositories: GlobalRulesSourceRepository[];
}

/**
 * Access tier for the global-rules import feature, derived from the org's plan:
 *   - `free`  → feature blocked entirely (no import allowed).
 *   - `trial` → capped at `GLOBAL_RULES_TRIAL_IMPORT_LIMIT` imported rules total.
 *   - `paid`  → unlimited.
 */
export type GlobalRulesImportTier = 'free' | 'trial' | 'paid';

/** Max global rules a TRIAL org can import (across all source repos combined). */
export const GLOBAL_RULES_TRIAL_IMPORT_LIMIT = 5;

/**
 * Import quota status surfaced to the UI so it can gray out the control (free),
 * show a counter + confirmation (trial), or allow everything (paid).
 */
export interface GlobalRulesImportStatus {
    tier: GlobalRulesImportTier;
    /** null = unlimited (paid); a number = hard cap; 0 = blocked (free). */
    limit: number | null;
    /** Currently imported (active) global-synced rules across the org. */
    used: number;
    /** null = unlimited; otherwise max(0, limit - used). */
    remaining: number | null;
}
