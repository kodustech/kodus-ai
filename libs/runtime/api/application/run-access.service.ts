import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { TEAM_CLI_KEY_CAPABILITIES } from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';
import type { RuntimeRunProjection } from '@libs/runtime/run';

import { RUNTIME_RUN_PROJECTION_STORE, type RunProjectionReader } from '../domain/ports';

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
        private readonly runs: RunProjectionReader,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
    ) {}

    async load(principal: RuntimePrincipal, runId: string, action: Action = Action.Read): Promise<RuntimeRunProjection> {
        const organizationId = principalOrganizationId(principal);
        const run = organizationId && typeof runId === 'string' && runId.length <= 128 ? await this.runs.get(runId, { organizationId }) : null;
        if (!organizationId || !run || run.organizationId !== organizationId) {
            throw new NotFoundException('Run not found');
        }

        if (principal.kind === 'user') {
            await this.authorization.ensure({
                user: principal.user,
                action,
                resource: ResourceType.RuntimeRun,
                repoIds: [run.repositoryId],
            });
            return run;
        }

        if (run.teamId !== principal.teamId) throw new NotFoundException('Run not found');
        if (action !== Action.Read || !principal.capabilities.includes(TEAM_CLI_KEY_CAPABILITIES.RUNS_READ)) {
            throw new ForbiddenException('This team key cannot read Runtime runs');
        }
        if (!principal.repositoryIds.includes(run.repositoryId)) {
            throw new ForbiddenException('This team key does not reach this repository');
        }
        return run;
    }
}
