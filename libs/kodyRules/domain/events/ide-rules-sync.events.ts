import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export const IDE_RULES_SYNC_DISABLED_EVENT = 'ide-rules-sync.disabled';

/**
 * What should happen to the imported IDE-sync rules when the user toggles
 * `ideRulesSyncEnabled` from `true` to `false`. The user picks one of these
 * via the toggle-off confirmation modal in the web UI.
 *
 *   - keep:   no-op. Rules stay ACTIVE and continue to be enforced. The user
 *             only stopped automatic re-imports from source files.
 *             (default — the least destructive choice)
 *   - pause:  rules flip to status PAUSED. They stay in the user's list and
 *             in audit history but are skipped by the enforcement filter,
 *             so PRs are no longer reviewed against them. Reversible via
 *             `resume` from the same management endpoint.
 *   - delete: rules flip to status DELETED. Hidden from the user's list,
 *             never enforced, but kept in the underlying record for audit.
 *             Re-enabling auto-sync re-imports them from source files.
 */
export type IdeSyncDisableAction = 'keep' | 'pause' | 'delete';

export interface IdeRulesSyncDisabledEvent {
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId: string;
    action: IdeSyncDisableAction;
}
