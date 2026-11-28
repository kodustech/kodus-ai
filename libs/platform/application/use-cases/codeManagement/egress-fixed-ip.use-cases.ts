import {
    BadRequestException,
    ForbiddenException,
    Inject,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';

import { environment } from '@libs/ee/configs/environment';
import {
    FixedEgressIpPlanRequiredError,
    FixedEgressIpPlanUnconfirmedError,
} from '@libs/sandbox/domain/egress-plan';
import {
    FixedEgressIpSetting,
    ISandboxEgressPolicy,
    SANDBOX_EGRESS_POLICY_TOKEN,
} from '@libs/sandbox/infrastructure/services/sandbox-egress-policy.service';

/**
 * The fixed outbound IP card in Organization settings. `available` is false
 * where the setting changes nothing: a self-hosted install (it reaches Git
 * from its own network), or an organization direct egress is not rolled out
 * to yet (every sandbox still leaves from the fixed IP).
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

/** The caller's organization, from the session; never from the request. */
function requireOrganizationId(organizationId: string | undefined): string {
    if (!organizationId) {
        throw new BadRequestException('No organization in the session.');
    }
    return organizationId;
}

@Injectable()
export class GetFixedEgressIpUseCase {
    constructor(
        @Inject(SANDBOX_EGRESS_POLICY_TOKEN)
        private readonly egressPolicy: ISandboxEgressPolicy,
    ) {}

    async execute(params: {
        organizationId: string | undefined;
    }): Promise<FixedEgressIpView> {
        if (!environment.API_CLOUD_MODE) return NOT_AVAILABLE;
        const setting = await this.egressPolicy.getFixedIpSetting(
            requireOrganizationId(params.organizationId),
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
    ) {}

    async execute(params: {
        organizationId: string | undefined;
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
        const organizationId = requireOrganizationId(params.organizationId);
        try {
            const setting = await this.egressPolicy.setFixedIp(
                organizationId,
                params.enabled,
                { actorUserId: params.actorUserId },
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
