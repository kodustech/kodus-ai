import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import {
    ITeamCliKeyService,
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import { SetTeamKeyRepositoriesUseCase } from '@libs/runtime/api/application/use-cases/set-team-key-repositories.use-case';

/**
 * PUT /teams/:teamId/cli-keys/:keyId/repositories — the repos a team CLI key
 * reaches (ADR-057), next to the other CLI key routes. The key must belong to
 * the team in the path (else 404); the Runtime use case then checks the key's
 * org against the caller's and every repo against the team's configuration.
 * Every change is written to the audit log, like the other key edits.
 */
@Injectable()
export class SetTeamCliKeyRepositoriesUseCase {
    constructor(
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly keys: Pick<ITeamCliKeyService, 'findById'>,
        private readonly setRepositories: SetTeamKeyRepositoriesUseCase,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    async execute(input: { user: Partial<IUser>; teamId: string; keyId: string; repositoryIds: string[] }) {
        const key = typeof input.keyId === 'string' && input.keyId.length <= 128 ? await this.keys.findById(input.keyId) : null;
        if (!key || key.team?.uuid !== input.teamId) {
            throw new NotFoundException('Team key not found');
        }
        const result = await this.setRepositories.execute({ user: input.user, keyId: input.keyId, repositoryIds: input.repositoryIds });
        this.eventEmitter.emit(AuditLogEvents.CLI_KEY, {
            organizationAndTeamData: { organizationId: input.user?.organization?.uuid, teamId: input.teamId },
            userInfo: { userId: input.user?.uuid, userEmail: input.user?.email },
            actionType: ActionType.EDIT,
            keyName: key.name,
        });
        return result;
    }
}
