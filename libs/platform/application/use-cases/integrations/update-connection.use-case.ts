import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { createLogger } from '@libs/core/log/logger';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';

const MAX_NAME_LENGTH = 120;

/** Renames a Git connection or turns its reviews on or off. */
@Injectable()
export class UpdateConnectionUseCase implements IUseCase {
    private readonly logger = createLogger(UpdateConnectionUseCase.name);

    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        // HTTP-only: called from PATCH /integration/connections/:connectionId.
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    async execute(params: {
        teamId: string;
        connectionId: string;
        name?: string | null;
        reviewEnabled?: boolean;
    }): Promise<void> {
        const organizationId = this.request.user.organization.uuid;

        const changes: { name?: string | null; reviewEnabled?: boolean } = {};
        if (params.name !== undefined) {
            const name = (params.name ?? '').trim().slice(0, MAX_NAME_LENGTH);
            changes.name = name || null;
        }
        if (typeof params.reviewEnabled === 'boolean') {
            changes.reviewEnabled = params.reviewEnabled;
        }
        if (!Object.keys(changes).length) {
            throw new BadRequestException('Nothing to update.');
        }

        const scope = {
            uuid: params.connectionId,
            organization: { uuid: organizationId },
            team: { uuid: params.teamId },
        };

        const connection = await this.integrationService.findOne({
            ...scope,
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
        });
        if (!connection) {
            throw new NotFoundException('Git connection not found.');
        }

        await this.integrationService.update(scope, changes);

        this.logger.log({
            message: 'connection_updated',
            context: UpdateConnectionUseCase.name,
            metadata: {
                organizationId,
                teamId: params.teamId,
                integrationId: params.connectionId,
                changes,
                actorUserId: this.request.user.uuid,
            },
        });
    }
}
