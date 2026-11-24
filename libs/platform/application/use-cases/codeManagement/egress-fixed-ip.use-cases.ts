import {
    BadRequestException,
    ForbiddenException,
    Inject,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';

import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { environment } from '@libs/ee/configs/environment';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import {
    FixedEgressIpNoIntegrationError,
    FixedEgressIpPlanRequiredError,
    FixedEgressIpPlanUnconfirmedError,
} from '@libs/sandbox/domain/egress-plan';
import {
    FixedEgressIpSetting,
    ISandboxEgressPolicy,
    SANDBOX_EGRESS_POLICY_TOKEN,
} from '@libs/sandbox/infrastructure/services/sandbox-egress-policy.service';

/**
 * The fixed outbound IP card in Git settings. `available` is false where
 * the setting changes nothing: a self-hosted install (it reaches Git from
 * its own network), or an organization direct egress is not rolled out to
 * yet (every team still leaves from the fixed IP).
 */
export type FixedEgressIpView = Partial<FixedEgressIpSetting> &
    Pick<FixedEgressIpSetting, 'allowedByPlan' | 'enabled'> & {
        available: boolean;
    };

const NOT_AVAILABLE: FixedEgressIpView = {
    available: false,
    allowedByPlan: false,
    enabled: false,
};

const scopeOf = ({ organizationId, teamId }: OrganizationAndTeamData) => ({
    organizationId,
    teamId,
});

/**
 * The team's active code management integration, looked up inside the
 * caller's organization: a team uuid from another organization finds none,
 * so its setting is neither read nor written. A missing team is refused
 * before any lookup (an unfiltered query would match any tenant's row).
 * `undefined` when the team has no active integration: a definite answer
 * (nothing to hold the setting), not a failed read.
 */
async function teamIntegrationId(
    integrationService: Pick<IIntegrationService, 'findOne'>,
    { organizationId, teamId }: OrganizationAndTeamData,
): Promise<string | undefined> {
    if (!organizationId || !teamId) {
        throw new BadRequestException('`teamId` is required.');
    }
    const integration = await integrationService.findOne({
        organization: { uuid: organizationId },
        team: { uuid: teamId },
        integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
        status: true,
    });
    return integration?.uuid || undefined;
}

@Injectable()
export class GetFixedEgressIpUseCase {
    constructor(
        @Inject(SANDBOX_EGRESS_POLICY_TOKEN)
        private readonly egressPolicy: ISandboxEgressPolicy,
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: Pick<
            IIntegrationService,
            'findOne'
        >,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<FixedEgressIpView> {
        if (!environment.API_CLOUD_MODE) return NOT_AVAILABLE;
        const integrationId = await teamIntegrationId(
            this.integrationService,
            params.organizationAndTeamData,
        );
        // No active integration in the caller's organization (another
        // organization's team included): nothing to show or change.
        if (!integrationId) return NOT_AVAILABLE;
        const setting = await this.egressPolicy.getFixedIpSetting(
            scopeOf(params.organizationAndTeamData),
            integrationId,
        );
        if (!setting.inRollout) return NOT_AVAILABLE;
        return { available: true, ...setting };
    }
}

@Injectable()
export class SetFixedEgressIpUseCase {
    constructor(
        @Inject(SANDBOX_EGRESS_POLICY_TOKEN)
        private readonly egressPolicy: ISandboxEgressPolicy,
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: Pick<
            IIntegrationService,
            'findOne'
        >,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        enabled: boolean;
        actorUserId?: string;
    }): Promise<FixedEgressIpView> {
        if (!environment.API_CLOUD_MODE) {
            throw new BadRequestException(
                'A self-hosted install reaches your Git host from its own network.',
            );
        }
        if (typeof params.enabled !== 'boolean') {
            throw new BadRequestException('`enabled` must be true or false.');
        }
        const integrationId = await teamIntegrationId(
            this.integrationService,
            params.organizationAndTeamData,
        );
        if (!integrationId) {
            throw new BadRequestException(
                new FixedEgressIpNoIntegrationError().message,
            );
        }
        try {
            const setting = await this.egressPolicy.setFixedIp(
                scopeOf(params.organizationAndTeamData),
                params.enabled,
                { integrationId, actorUserId: params.actorUserId },
            );
            return { available: setting.inRollout, ...setting };
        } catch (error) {
            if (error instanceof FixedEgressIpPlanRequiredError) {
                throw new ForbiddenException(error.message);
            }
            if (error instanceof FixedEgressIpPlanUnconfirmedError) {
                throw new ServiceUnavailableException(error.message);
            }
            throw error;
        }
    }
}
