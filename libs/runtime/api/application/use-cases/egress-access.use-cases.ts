import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';

import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { EGRESS_WHO_MAY_ADD, type EgressWhoMayAdd, ORG_EGRESS_SCOPE } from '@libs/runtime/contracts/egress';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '@libs/runtime/contracts/runtime-commands';
import { RECOMMENDED_EGRESS, RECOMMENDED_EGRESS_VERSION } from '@libs/runtime/protocol/egress-catalog';

import { InvalidEgressHostError, normalizeEgressHost } from '../../domain/egress';
import {
    RUNTIME_CLOCK,
    RUNTIME_EGRESS_READER,
    RUNTIME_ENVIRONMENT_READER,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    type Clock,
    type ProductEnvironmentStore,
    type RuntimeEgressReader,
    type RuntimeEnvironmentReader,
} from '../../domain/ports';
import { RuntimeEgressAccess } from '../egress-access.service';
import { environmentRepositoryIds, RuntimeEnvironmentMembers } from '../environment-members.service';
import type { RuntimeAuthorization } from '../run-access.service';
import { resolveEgressScope } from './approve-egress.use-case';

const actorOf = (user: Partial<IUser>) => ({ userId: user.uuid!, ...(user.email ? { email: user.email } : {}) });

/**
 * DELETE /runtime/environments/:id/egress-approvals/:host — revokes an approval (G3). The scope's live claims get the
 * list without the host, which cuts their connections to it; the next claims never resolve it (S-55). Same who-may
 * as approving it (D3).
 */
@Injectable()
export class RevokeEgressUseCase {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly productEnvironments: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(RUNTIME_ENVIRONMENT_READER)
        private readonly environments: RuntimeEnvironmentReader,
        @Inject(RuntimeEgressAccess)
        private readonly access: RuntimeEgressAccess,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: IOutboxMessageRepository,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        @Optional()
        @Inject(RuntimeEnvironmentMembers)
        private readonly members?: RuntimeEnvironmentMembers,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string; host: string; reason?: string }) {
        const organizationId = input.user?.organization?.uuid;
        const scope = await resolveEgressScope(input, organizationId, this.productEnvironments, this.environments);
        if (scope.org) await this.access.ensureOrgAdmin(input.user);
        else await this.access.ensureMayChangeEnvironment(input.user, organizationId!, await environmentRepositoryIds(this.members, scope.environment!));
        let host: string;
        try {
            host = normalizeEgressHost(input.host);
        } catch (e) {
            if (e instanceof InvalidEgressHostError) throw new BadRequestException(e.message);
            throw e;
        }
        const revokedAt = this.now().toISOString();
        const key = `${scope.environmentId}:${host}`;
        const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 500) : undefined;
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.EgressRevoked,
                { environmentId: scope.environmentId, organizationId: organizationId!, host, revokedBy: actorOf(input.user), revokedAt, ...(reason ? { reason } : {}), key },
                `${key}@revoke@${revokedAt}`,
            ),
        );
        return { environmentId: scope.environmentId, host, revokedAt };
    }
}

/**
 * GET/PUT /runtime/egress — the org's outbound access (docs/runtime/egress-allowlist.md §9): the Kodus recommended
 * list (its version and entries, on unless the org turned it off, D2), the org list, who may add hosts to an
 * environment (D3) and the audit. Anyone who reads environments reads it; only an owner changes it.
 */
@Injectable()
export class OrgEgressUseCases {
    constructor(
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        @Inject(RuntimeEgressAccess)
        private readonly access: RuntimeEgressAccess,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: IOutboxMessageRepository,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        @Optional()
        @Inject(RUNTIME_EGRESS_READER)
        private readonly egress?: RuntimeEgressReader,
    ) {}

    async get(user: Partial<IUser>) {
        const organizationId = user?.organization?.uuid;
        await this.authorization.ensure({ user, action: Action.Read, resource: ResourceType.RuntimeEnvironment });
        // A read that fails fails the page: an empty org list or audit would read as nothing approved. The reader already
        // answers [] for a table the Runtime's migrations have not made yet.
        const [settings, orgList, audit] = await Promise.all([
            this.access.settings(organizationId!),
            this.egress ? this.egress.approvals(organizationId!, ORG_EGRESS_SCOPE) : [],
            this.egress?.audit ? this.egress.audit(organizationId!) : [],
        ]);
        return {
            settings,
            recommended: { version: RECOMMENDED_EGRESS_VERSION, entries: RECOMMENDED_EGRESS.map((e) => ({ host: e.host, ecosystem: e.ecosystem, tier: e.tier, paths: e.paths, why: e.why, doc: e.doc })) },
            orgList,
            audit,
        };
    }

    /** D2 and D3. Turning the recommended list off is allowed; the screen warns that installs then fail (registries and download hosts leave every claim). */
    async update(user: Partial<IUser>, body: { recommendedEnabled?: unknown; whoMayAdd?: unknown }) {
        const organizationId = user?.organization?.uuid;
        await this.access.ensureOrgAdmin(user);
        const current = await this.access.settings(organizationId!);
        const recommendedEnabled = body.recommendedEnabled === undefined ? current.recommendedEnabled : body.recommendedEnabled;
        const whoMayAdd = body.whoMayAdd === undefined ? current.whoMayAdd : body.whoMayAdd;
        if (typeof recommendedEnabled !== 'boolean') throw new BadRequestException('recommendedEnabled: true or false');
        if (typeof whoMayAdd !== 'string' || !(EGRESS_WHO_MAY_ADD as readonly string[]).includes(whoMayAdd)) {
            throw new BadRequestException(`whoMayAdd: one of ${EGRESS_WHO_MAY_ADD.join(', ')}`);
        }
        const changedAt = this.now().toISOString();
        const key = `egress-settings:${organizationId}:${changedAt}`;
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.EgressSettingsChanged,
                { organizationId: organizationId!, recommendedEnabled, whoMayAdd: whoMayAdd as EgressWhoMayAdd, changedBy: actorOf(user), changedAt, key },
                key,
            ),
        );
        return { recommendedEnabled, whoMayAdd, changedAt };
    }
}
