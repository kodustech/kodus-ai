import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';

import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

import { DEFAULT_EGRESS_DENYLIST, deniedBy, InvalidEgressHostError, normalizeEgressHost } from '../../domain/egress';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '../../domain/runtime-commands';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_READER,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    type Clock,
    type ProductEnvironmentStore,
    type RuntimeApiConfig,
    type RuntimeEnvironmentReader,
} from '../../domain/ports';
import type { RuntimeAuthorization } from '../run-access.service';

/**
 * POST /runtime/environments/:id/egress-approvals — the org admin approves one
 * domain for one environment, outside the recipe. The Kodus denylist wins.
 * The environment is the product's row (it exists before any Run, so egress a
 * setup was denied can be approved); one only Runs know is the fallback.
 */
@Injectable()
export class ApproveEgressUseCase {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly productEnvironments: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(RUNTIME_ENVIRONMENT_READER)
        private readonly environments: RuntimeEnvironmentReader,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: IOutboxMessageRepository,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string; host: string }) {
        const organizationId = input.user?.organization?.uuid;
        const valid = !!organizationId && typeof input.environmentId === 'string' && input.environmentId.length <= 128;
        const environment = valid
            ? ((await this.productEnvironments.get(organizationId, input.environmentId)) ?? (await this.environments.get(organizationId, input.environmentId)))
            : null;
        if (!organizationId || !environment || environment.organizationId !== organizationId) {
            throw new NotFoundException('Environment not found');
        }
        await this.authorization.ensure({
            user: input.user,
            action: Action.Update,
            resource: ResourceType.RuntimeEnvironment,
            repoIds: [environment.repositoryId],
        });

        let host: string;
        try {
            host = normalizeEgressHost(input.host);
        } catch (e) {
            if (e instanceof InvalidEgressHostError) throw new BadRequestException(e.message);
            throw e;
        }
        const rule = deniedBy(host, [...DEFAULT_EGRESS_DENYLIST, ...this.config.egressDenylist]);
        if (rule) {
            throw new UnprocessableEntityException(`${host} is on the Kodus egress denylist (${rule}) and cannot be approved`);
        }

        const approvedAt = this.now().toISOString();
        const key = `${environment.environmentId}:${host}`;
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.EgressApproved,
                {
                    environmentId: environment.environmentId,
                    organizationId,
                    host,
                    approvedBy: { userId: input.user.uuid!, ...(input.user.email ? { email: input.user.email } : {}) },
                    approvedAt,
                    key,
                },
                key,
            ),
        );
        return { environmentId: environment.environmentId, host, approvedAt };
    }
}
