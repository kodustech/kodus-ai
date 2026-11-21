import { ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

import { RUNTIME_EGRESS_READER, type EgressSettingsRow, type RuntimeEgressReader } from '../domain/ports';
import type { RuntimeAuthorization } from './run-access.service';

export const DEFAULT_EGRESS_SETTINGS: EgressSettingsRow = { recommendedEnabled: true, whoMayAdd: 'owners' };

/**
 * Who may change an org's outbound access (docs/runtime/egress-allowlist.md §9, D3): the org list and the settings
 * are the owner's; a host for one environment is the owner's, or also the repo admins' of the environment's
 * repositories (those who may edit those repositories' settings) when the org says so, or nobody's when the org keeps
 * one list for every environment.
 */
@Injectable()
export class RuntimeEgressAccess {
    constructor(
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        @Optional()
        @Inject(RUNTIME_EGRESS_READER)
        private readonly egress?: RuntimeEgressReader,
    ) {}

    /** The org's settings; the defaults when never set or unreadable (owners only: the narrowest). */
    async settings(organizationId: string): Promise<EgressSettingsRow> {
        try {
            return (await this.egress?.settings?.(organizationId)) ?? DEFAULT_EGRESS_SETTINGS;
        } catch {
            return DEFAULT_EGRESS_SETTINGS;
        }
    }

    /** The org list and the settings: owners only. */
    async ensureOrgAdmin(user: Partial<IUser>): Promise<void> {
        await this.authorization.ensure({ user, action: Action.Update, resource: ResourceType.RuntimeEnvironment });
    }

    /** One environment's hosts: per the org's who-may-add setting (D3). */
    async ensureMayChangeEnvironment(user: Partial<IUser>, organizationId: string, repoIds: string[]): Promise<void> {
        const { whoMayAdd } = await this.settings(organizationId);
        if (whoMayAdd === 'nobody') {
            throw new ForbiddenException('This org keeps one outbound list for every environment: an owner adds hosts in Settings, Runtime, Outbound access');
        }
        try {
            await this.authorization.ensure({ user, action: Action.Update, resource: ResourceType.RuntimeEnvironment, repoIds });
            return;
        } catch (e) {
            if (whoMayAdd !== 'owners_and_repo_admins' || !(e instanceof ForbiddenException) || !repoIds.length) throw e;
        }
        // A repo admin of every repository of the environment.
        await this.authorization.ensure({ user, action: Action.Update, resource: ResourceType.CodeReviewSettings, repoIds });
    }
}
