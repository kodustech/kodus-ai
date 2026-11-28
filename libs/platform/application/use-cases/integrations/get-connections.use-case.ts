import pLimit from 'p-limit';
import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import { CodeManagementService } from '../../../infrastructure/adapters/services/codeManagement.service';

const VERIFICATIONS_AT_ONCE = 4;
/** The page renders on this read; past it the subscription reads as unknown. */
const OWN_SUBSCRIPTION_READ_TIMEOUT_MS = 2000;

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

        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
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

            if (!connections.length) return [];
            const verifyAtOnce = pLimit(VERIFICATIONS_AT_ONCE);

            const [statuses, licences] = await Promise.all([
                // Each check calls its provider: a few at a time.
                Promise.allSettled(
                    connections.map((connection) =>
                        verifyAtOnce(() =>
                            this.codeManagementService.verifyConnection({
                                organizationAndTeamData: {
                                    organizationId,
                                    teamId,
                                    integrationId: connection.uuid,
                                },
                            }),
                        ),
                    ),
                ),
                // A connection billed on its own subscription keeps billing
                // after a reset, so the reset says so first. Null when
                // billing could not be read in time.
                this.licenseService.getConnectionLicenses(
                    { organizationId, teamId },
                    { timeoutMs: OWN_SUBSCRIPTION_READ_TIMEOUT_MS },
                ),
            ]);
            const ownSubscriptions = licences
                ? new Set(licences.ownLicenceConnectionIds)
                : null;

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
                        ownSubscription: ownSubscriptions
                            ? ownSubscriptions.has(connection.uuid)
                            : null,
                    };
                })
                .filter((connection) => connection);
        } catch (error) {
            throw new BadRequestException(error);
        }
    }
}
