import {
    BadRequestException,
    ForbiddenException,
    Inject,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { environment } from '@libs/ee/configs/environment';
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
 * sandboxes never leave through Kodus's network (self-hosted installs), so
 * the card is not shown there.
 */
export type FixedEgressIpView = FixedEgressIpSetting & { available: boolean };

const scopeOf = ({ organizationId, teamId }: OrganizationAndTeamData) => ({
    organizationId,
    teamId,
});

@Injectable()
export class GetFixedEgressIpUseCase {
    constructor(
        @Inject(SANDBOX_EGRESS_POLICY_TOKEN)
        private readonly egressPolicy: ISandboxEgressPolicy,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<FixedEgressIpView> {
        if (!environment.API_CLOUD_MODE) {
            return { available: false, allowedByPlan: false, enabled: false };
        }
        const setting = await this.egressPolicy.getFixedIpSetting(
            scopeOf(params.organizationAndTeamData),
        );
        return { available: true, ...setting };
    }
}

@Injectable()
export class SetFixedEgressIpUseCase {
    constructor(
        @Inject(SANDBOX_EGRESS_POLICY_TOKEN)
        private readonly egressPolicy: ISandboxEgressPolicy,
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
        try {
            const setting = await this.egressPolicy.setFixedIp(
                scopeOf(params.organizationAndTeamData),
                params.enabled,
                params.actorUserId,
            );
            return { available: true, ...setting };
        } catch (error) {
            if (error instanceof FixedEgressIpPlanRequiredError) {
                throw new ForbiddenException(error.message);
            }
            if (error instanceof FixedEgressIpPlanUnconfirmedError) {
                throw new ServiceUnavailableException(error.message);
            }
            if (error instanceof FixedEgressIpNoIntegrationError) {
                throw new BadRequestException(error.message);
            }
            throw error;
        }
    }
}
