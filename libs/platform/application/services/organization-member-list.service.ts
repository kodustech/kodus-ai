import { Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

export type OrganizationMemberSummary = {
    name: string;
    id: string | number;
};

/**
 * An `unavailable` result means we could not confirm who belongs to the git
 * organization. Callers must never read it as "the organization is empty" —
 * seat revocation in particular has to be skipped entirely in that case.
 */
export type OrganizationMemberListResult =
    | { status: 'ok'; members: OrganizationMemberSummary[] }
    | { status: 'unavailable'; members: [] };

type RawMember = {
    name?: string;
    displayName?: string;
    login?: string;
    principalName?: string;
    email?: string;
    id?: string | number;
    uuid?: string;
    descriptor?: string;
    originId?: string | number;
};

const unavailable = (): OrganizationMemberListResult => ({
    status: 'unavailable',
    members: [],
});

@Injectable()
export class OrganizationMemberListService {
    private readonly logger = createLogger(OrganizationMemberListService.name);

    constructor(private readonly codeManagementService: CodeManagementService) {}

    public async fetch(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationMemberListResult> {
        let members: RawMember[];

        try {
            members = await this.codeManagementService.getListMembers({
                organizationAndTeamData,
            });
        } catch (error) {
            this.logger.warn({
                message: 'Unable to fetch members from code integration',
                context: OrganizationMemberListService.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
                error,
            });

            return unavailable();
        }

        const normalized = this.normalize(members);

        // A missing integration and an unauthorized token both surface as an
        // empty list rather than an error, so an empty result is treated as a
        // failed lookup instead of a genuinely memberless organization.
        if (normalized.length === 0) {
            this.logger.warn({
                message:
                    'Code integration returned no usable members; treating the list as unavailable',
                context: OrganizationMemberListService.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    rawCount: Array.isArray(members) ? members.length : 0,
                },
            });

            return unavailable();
        }

        return { status: 'ok', members: normalized };
    }

    public normalize(members: RawMember[]): OrganizationMemberSummary[] {
        if (!Array.isArray(members) || members.length === 0) {
            return [];
        }

        const uniqueMembers = new Map<string, OrganizationMemberSummary>();

        for (const member of members) {
            const normalized = this.normalizeMember(member);

            if (normalized && !uniqueMembers.has(String(normalized.id))) {
                uniqueMembers.set(String(normalized.id), normalized);
            }
        }

        return Array.from(uniqueMembers.values()).sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        );
    }

    private normalizeMember(
        member: RawMember | null,
    ): OrganizationMemberSummary | null {
        if (!member) {
            return null;
        }

        const rawId =
            member.descriptor ??
            member.id ??
            member.uuid ??
            member.originId ??
            member.email ??
            member.login ??
            member.principalName;

        const rawName =
            member.name ??
            member.displayName ??
            member.login ??
            member.principalName ??
            member.email;

        if (!rawId || !rawName) {
            return null;
        }

        return { id: rawId, name: rawName };
    }
}
