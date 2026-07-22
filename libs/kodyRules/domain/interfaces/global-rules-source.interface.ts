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
