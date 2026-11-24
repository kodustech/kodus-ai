import {
    Controller,
    Get,
    Inject,
    NotFoundException,
    Param,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { PrDecisionRecordRepository } from '@libs/code-review/infrastructure/adapters/repositories/prDecisionRecord.repository';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';

interface RequestWithOrg {
    user: { organization: { uuid: string } };
}

/**
 * Read endpoint for the per-PR reconciler's source-of-truth row.
 * Powers the in-app Decision tab. The body shape is the duck type the
 * `@/pull-requests/[repoId]/[prNumber]/_components/decision-tab.tsx` reads.
 *
 * Spec scenario covered:
 *   WHEN an authorized tenant reads this endpoint
 *   THEN the read-shaped projection of the per-PR record is returned
 *
 * Spec scenario covered (negative):
 *   WHEN an unauthorized tenant reads this endpoint
 *   THEN 403 is returned — the handler carries the project's standard RBAC
 *   guard (`@UseGuards(PolicyGuard)` + `@CheckPolicies` for
 *   `Action.Read` on `ResourceType.PullRequests`, the same pair
 *   `pullRequest.controller.ts` uses), and reads
 *   `request.user.organization.uuid` for tenancy scoping consistent with
 *   `CodeBaseController`.
 */
@ApiTags('Pull Requests')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('pull-requests')
export class PrDecisionController {
    constructor(
        @Inject(REQUEST)
        private readonly request: RequestWithOrg,
        private readonly repository: PrDecisionRecordRepository,
    ) {}

    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    @Get(':repoId/:prNumber/decision')
    async readDecision(
        @Param('repoId') repoId: string,
        @Param('prNumber') prNumber: string,
        @Query('headSha') headSha?: string,
    ): Promise<{
        organizationId: string;
        repositoryId: string;
        prNumber: number;
        headSha: string;
        baseSha: string;
        configurationKey: string;
        gateVerdictsSnapshot: unknown;
        lastApplyOutcome: unknown;
        lastReconciledAt: string;
        consecutiveFailures: number;
        inFlightTriggerKind: string | null;
    }> {
        const orgId = this.request?.user?.organization?.uuid;
        if (!orgId) {
            // Belt-and-suspenders: the RBAC guard above already rejects
            // unauthenticated callers; a request without an organization
            // context cannot address any tenant's row.
            throw new NotFoundException('organization context missing');
        }

        const parsedPrNumber = Number(prNumber);
        if (!Number.isFinite(parsedPrNumber) || parsedPrNumber <= 0) {
            throw new NotFoundException('prNumber must be a positive integer');
        }

        if (!headSha) {
            throw new NotFoundException('headSha query parameter required');
        }

        const record = await this.repository.findByRecordKey({
            organizationId: orgId,
            repositoryId: repoId,
            prNumber: parsedPrNumber,
            headSha,
        });

        if (!record) {
            throw new NotFoundException(
                `No pr_decision_records row for ${repoId}#${parsedPrNumber}@${headSha}`,
            );
        }

        return {
            organizationId: record.organizationId,
            repositoryId: record.repositoryId,
            prNumber: record.prNumber,
            headSha: record.headSha,
            baseSha: record.baseSha,
            configurationKey: record.configurationKey,
            gateVerdictsSnapshot: record.gateVerdictsSnapshot,
            lastApplyOutcome: record.lastApplyOutcome,
            lastReconciledAt: record.lastReconciledAt.toISOString(),
            consecutiveFailures: record.consecutiveFailures,
            inFlightTriggerKind: record.inFlightTriggerKind,
        };
    }
}
