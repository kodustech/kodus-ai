import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import {
    ITeamCliKeyService,
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';

import { RUNTIME_TEAM_REPOSITORIES, type RuntimeTeamRepositories } from '../../domain/ports';

const MAX_REPOSITORIES = 500;

/**
 * PUT /team-keys/:id/repositories — the repos a team key reaches (ADR-057).
 * The key must belong to a team of the caller's org (else 404), and every repo
 * must be configured for that team.
 */
@Injectable()
export class SetTeamKeyRepositoriesUseCase {
    constructor(
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly keys: Pick<ITeamCliKeyService, 'findById' | 'update'>,
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teams: Pick<ITeamService, 'findOneOrganizationIdByTeamId'>,
        @Inject(RUNTIME_TEAM_REPOSITORIES)
        private readonly teamRepositories: RuntimeTeamRepositories,
    ) {}

    async execute(input: { user: Partial<IUser>; keyId: string; repositoryIds: unknown }) {
        const organizationId = input.user?.organization?.uuid;
        const key = typeof input.keyId === 'string' && input.keyId.length <= 128 ? await this.keys.findById(input.keyId) : null;
        const teamId = key?.team?.uuid;
        const keyOrganizationId = teamId ? await this.teams.findOneOrganizationIdByTeamId(teamId) : undefined;
        if (!organizationId || !key || !teamId || keyOrganizationId !== organizationId) {
            throw new NotFoundException('Team key not found');
        }

        const ids = input.repositoryIds;
        if (!Array.isArray(ids) || ids.length > MAX_REPOSITORIES || !ids.every((r) => typeof r === 'string' && r.length > 0 && r.length <= 128)) {
            throw new BadRequestException(`repositoryIds must be a list of at most ${MAX_REPOSITORIES} repository ids`);
        }
        const repositoryIds = [...new Set(ids as string[])];
        const known = new Set(await this.teamRepositories.listRepositoryIds({ organizationId, teamId }));
        const unknown = repositoryIds.filter((r) => !known.has(r));
        if (unknown.length > 0) {
            throw new BadRequestException(`Repositories not configured for this team: ${unknown.join(', ')}`);
        }

        const updated = await this.keys.update({ uuid: key.uuid }, { config: { ...(key.config ?? {}), repositoryIds } });
        return { uuid: key.uuid, repositoryIds: updated?.config?.repositoryIds ?? repositoryIds };
    }
}
