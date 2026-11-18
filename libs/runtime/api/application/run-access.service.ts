import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { TEAM_CLI_KEY_CAPABILITIES } from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';
import type { RuntimeRunProjection } from '@libs/runtime/run';

import { RUNTIME_RUN_PROJECTION_STORE, type RunSummaryReader } from '../domain/ports';
import { environmentRepositoryIds, RuntimeEnvironmentMembers } from './environment-members.service';

/** Who is asking: a dashboard user, or a team key (ADR-057: capability + repo list). */
export type RuntimePrincipal =
    | { kind: 'user'; user: Partial<IUser> }
    | {
          kind: 'team_key';
          keyId: string;
          organizationId: string;
          teamId: string;
          capabilities: string[];
          repositoryIds: string[];
      };

export type RuntimeAuthorization = Pick<AuthorizationService, 'ensure' | 'getRepositoryScope'>;

export const principalOrganizationId = (p: RuntimePrincipal): string | undefined =>
    p.kind === 'user' ? p.user?.organization?.uuid : p.organizationId;

/**
 * Object-level check of every Run route (§7): load the Run, then org, team and
 * repo of the caller. A Run of another org (or another team, for a team key)
 * answers 404, never 403, so ids cannot be probed across tenants.
 */
@Injectable()
export class RuntimeRunAccessService {
    constructor(
        @Inject(RUNTIME_RUN_PROJECTION_STORE)
        private readonly runs: RunSummaryReader,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        // Required by Nest; a service made without it (the older tests) checks the Run's own repository only.
        @Inject(RuntimeEnvironmentMembers)
        private readonly members?: RuntimeEnvironmentMembers,
    ) {}

    /**
     * Every repository a Run's machine held: its own and every other one of
     * its environment. Reading or acting on the Run needs access to all of
     * them (docs/runtime/multi-repo.md, Access).
     */
    repositoryIdsOf(run: Pick<RuntimeRunProjection, 'organizationId' | 'environmentId' | 'repositoryId'>): Promise<string[]> {
        return environmentRepositoryIds(this.members, run);
    }

    /**
     * `resource` is what the caller acts on through the Run: the Run itself by
     * default, or its preview (RuntimePreview, repo-scoped for every role but
     * owner). A team key reaches only the Run.
     */
    async load(
        principal: RuntimePrincipal,
        runId: string,
        action: Action = Action.Read,
        resource: ResourceType.RuntimeRun | ResourceType.RuntimePreview = ResourceType.RuntimeRun,
        /** Only the Run's columns (ids, state, times): a caller that reads nothing of the report skips moving it. */
        read: 'whole' | 'columns' = 'whole',
    ): Promise<RuntimeRunProjection> {
        const organizationId = principalOrganizationId(principal);
        const valid = !!organizationId && typeof runId === 'string' && runId.length <= 128;
        const run = !valid
            ? null
            : read === 'columns' && this.runs.getSummary
              ? await this.runs.getSummary(runId, { organizationId: organizationId! }, [])
              : await this.runs.get(runId, { organizationId: organizationId! });
        if (!organizationId || !run || run.organizationId !== organizationId) {
            throw new NotFoundException('Run not found');
        }

        const repoIds = await this.repositoryIdsOf(run);
        if (principal.kind === 'user') {
            await this.authorization.ensure({
                user: principal.user,
                action,
                resource,
                repoIds,
            });
            return run;
        }

        if (run.teamId !== principal.teamId) throw new NotFoundException('Run not found');
        if (resource !== ResourceType.RuntimeRun) throw new ForbiddenException('A team key cannot open a Runtime preview');
        if (action !== Action.Read || !principal.capabilities.includes(TEAM_CLI_KEY_CAPABILITIES.RUNS_READ)) {
            throw new ForbiddenException('This team key cannot read Runtime runs');
        }
        if (!repoIds.every((id) => principal.repositoryIds.includes(id))) {
            throw new ForbiddenException('This team key does not reach this repository');
        }
        return run;
    }
}
