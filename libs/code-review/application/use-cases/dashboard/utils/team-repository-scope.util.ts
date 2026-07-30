import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IIntegrationConfigService } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

// Repository ids configured for the selected team (via the REPOSITORIES
// integration config, which is team-scoped). Returns `undefined` — never an
// empty array — when there is no teamId or the config can't be resolved, so
// callers cleanly fall back to the assigned scope instead of misreading
// "unresolved" as "team has zero repos". A config-fetch failure degrades to
// `undefined` (fall back) rather than breaking the whole dashboard segment.
export async function resolveTeamRepositoryIds(
    integrationConfigService: IIntegrationConfigService,
    organizationAndTeamData: OrganizationAndTeamData,
    onError?: (error: unknown) => void,
): Promise<string[] | undefined> {
    if (!organizationAndTeamData.teamId) {
        return undefined;
    }

    try {
        const repositories =
            await integrationConfigService.findIntegrationConfigFormatted<
                Repositories[]
            >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);

        if (!repositories?.length) {
            return undefined;
        }

        const ids = Array.from(
            new Set(
                repositories
                    .map((repo) =>
                        repo?.id != null ? String(repo.id) : undefined,
                    )
                    .filter((id): id is string => Boolean(id)),
            ),
        );

        return ids.length ? ids : undefined;
    } catch (error) {
        onError?.(error);
        return undefined;
    }
}

// Combine the caller's assigned repository scope (null = unrestricted) with the
// team's repositories into the single scope every dashboard segment should
// count against:
//   - both present            → intersection (team ∩ assigned)
//   - only team               → team
//   - only assigned           → assigned
//   - neither                 → undefined (org-wide)
// An empty array is a meaningful result (team and assigned scopes don't
// overlap → caller sees none of the team's PRs); callers must guard it because
// the Mongo helpers treat an empty array as "no repository filter" (org-wide).
export function intersectAssignedAndTeamScope(
    assignedRepositoryIds: string[] | null,
    teamRepositoryIds: string[] | undefined,
): string[] | undefined {
    if (assignedRepositoryIds != null && teamRepositoryIds != null) {
        return teamRepositoryIds.filter((id) =>
            assignedRepositoryIds.includes(id),
        );
    }

    return teamRepositoryIds ?? assignedRepositoryIds ?? undefined;
}

// Single source of truth for "which repositories should this dashboard segment
// count/list against". Every dashboard use-case (facets, digest, awaiting,
// authors, …) MUST resolve scope through here so the count and the list can't
// drift apart — the awaiting list once scoped by RBAC only while its facet
// count scoped by team, so they disagreed on multi-team orgs. Steps:
//   1. RBAC repository scope for the caller (null = unrestricted).
//   2. Team's configured repositories.
//   3. Intersection (see intersectAssignedAndTeamScope).
// Returns `null` when the caller should short-circuit to an empty result:
//   - the caller has access to zero repositories, or
//   - the team's repos and the caller's scope don't overlap.
export async function resolveDashboardRepositoryScope(params: {
    authorizationService: AuthorizationService;
    integrationConfigService: IIntegrationConfigService;
    user: UserRequest['user'];
    organizationAndTeamData: OrganizationAndTeamData;
    onError?: (error: unknown) => void;
}): Promise<{ repositoryIds: string[] | undefined } | null> {
    const {
        authorizationService,
        integrationConfigService,
        user,
        organizationAndTeamData,
        onError,
    } = params;

    const assignedRepositoryIds =
        await authorizationService.getRepositoryScope({
            user,
            action: Action.Read,
            resource: ResourceType.PullRequests,
        });

    // Explicit empty (not null) → the caller can read no repositories at all.
    if (assignedRepositoryIds !== null && assignedRepositoryIds.length === 0) {
        return null;
    }

    const teamRepositoryIds = await resolveTeamRepositoryIds(
        integrationConfigService,
        organizationAndTeamData,
        onError,
    );

    const repositoryIds = intersectAssignedAndTeamScope(
        assignedRepositoryIds,
        teamRepositoryIds,
    );

    // Empty array (not undefined) → team repos and assigned scope don't overlap.
    if (Array.isArray(repositoryIds) && repositoryIds.length === 0) {
        return null;
    }

    return { repositoryIds };
}
