import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { CodeManagementService } from '../../../infrastructure/adapters/services/codeManagement.service';

@Injectable()
export class GetConnectionsUseCase implements IUseCase {
    constructor(
        private readonly codeManagementService: CodeManagementService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
    ) {}

    /** Every Git connection of the workspace, each with its own status. */
    public async execute(teamId: any): Promise<any[]> {
        try {
            const organizationId = this.request.user.organization.uuid;

            const connections =
                (await this.integrationService.find({
                    organization: { uuid: organizationId },
                    team: { uuid: teamId },
                    integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
                    status: true,
                })) ?? [];

            const statuses = await Promise.allSettled(
                connections.map((connection) =>
                    this.codeManagementService.verifyConnection({
                        organizationAndTeamData: {
                            organizationId,
                            teamId,
                            integrationId: connection.uuid,
                        },
                    }),
                ),
            );

            return connections
                .map((connection, index) => {
                    const status = statuses[index];
                    if (status.status !== 'fulfilled' || !status.value) {
                        return null;
                    }
                    return {
                        ...status.value,
                        connectionId: connection.uuid,
                        connectionName: connection.name ?? null,
                        reviewEnabled: connection.reviewEnabled !== false,
                    };
                })
                .filter((connection) => connection);
        } catch (error) {
            throw new BadRequestException(error);
        }
    }
}
