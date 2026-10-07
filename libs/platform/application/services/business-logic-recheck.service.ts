import { Injectable } from '@nestjs/common';

import { BusinessValidationService } from '@libs/agents/business-validation/business-validation.service';
import type { BusinessValidationRequest } from '@libs/agents/business-validation/business-validation.types';
import { formatPullRequestDiff } from '@libs/agents/business-validation/pull-request-diff';
import {
    type ValidationRunRecord,
    ValidationRunRepository,
} from '@libs/agents/business-validation/runs/validation-run.repository';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { createLogger } from '@libs/core/log/logger';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

import { BusinessLogicPublisher } from './business-logic-publisher.service';

const MIN_AGE_MS = 15 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_PER_TICK = 20;

/**
 * Re-checks the PRs that were skipped because the task tracker was down,
 * once it answers again (UC-22). A tracker still down skips them again, and
 * they wait for the next tick; after a day they are left alone.
 */
@Injectable()
export class BusinessLogicRecheckService {
    private readonly logger = createLogger(BusinessLogicRecheckService.name);

    constructor(
        private readonly runs: ValidationRunRepository,
        private readonly businessValidationService: BusinessValidationService,
        private readonly publisher: BusinessLogicPublisher,
        private readonly codeManagementService: CodeManagementService,
    ) {}

    async recheckPending(now = new Date()): Promise<number> {
        let rechecked = 0;
        for (let i = 0; i < MAX_PER_TICK; i++) {
            const run = await this.runs.claimPendingRecheck({
                notBefore: new Date(now.getTime() - MAX_AGE_MS),
                notAfter: new Date(now.getTime() - MIN_AGE_MS),
            });
            if (!run) {
                break;
            }
            try {
                if (await this.recheck(run)) {
                    rechecked += 1;
                }
            } catch (error) {
                this.logger.warn({
                    message: 'Business logic re-check failed',
                    context: BusinessLogicRecheckService.name,
                    error,
                    metadata: {
                        organizationId: run.organizationId,
                        pullRequest: run.pullRequestNumber,
                    },
                });
            }
        }
        return rechecked;
    }

    private async recheck(run: ValidationRunRecord): Promise<boolean> {
        if (
            !run.repositoryId ||
            !run.repositoryName ||
            !run.pullRequestNumber
        ) {
            return false;
        }
        const scope = {
            organizationId: run.organizationId,
            repositoryId: run.repositoryId,
            pullRequestNumber: run.pullRequestNumber,
        };
        // A later run (a push, a command) already answered for this PR.
        const latest = await this.runs.latestForPullRequest(scope);
        if (latest && latest.id !== run.id) {
            return false;
        }
        const organizationAndTeamData = {
            organizationId: run.organizationId,
            teamId: run.teamId,
        };
        const repository = { id: run.repositoryId, name: run.repositoryName };
        const platformType = run.platformType as PlatformType | undefined;
        const pr = (await this.codeManagementService.getPullRequest(
            {
                organizationAndTeamData,
                repository,
                prNumber: run.pullRequestNumber,
            },
            platformType,
        )) as {
            title?: string;
            body?: string;
            state?: string;
            head?: { ref?: string; sha?: string };
            base?: { ref?: string };
        } | null;
        if (!pr || (pr.state && !/open/i.test(pr.state))) {
            return false;
        }

        const settings = await this.publisher.settingsFor(
            organizationAndTeamData,
            run.repositoryId,
        );
        const request: BusinessValidationRequest = {
            door: 'auto',
            organizationAndTeamData,
            repository,
            pullRequest: {
                number: run.pullRequestNumber,
                title: pr.title,
                body: pr.body,
                headRef: pr.head?.ref,
                baseRef: pr.base?.ref,
            },
            platformType,
            settings,
            diff: async () =>
                formatPullRequestDiff(
                    await this.codeManagementService.getFilesByPullRequestId({
                        organizationAndTeamData,
                        repository,
                        prNumber: run.pullRequestNumber!,
                    }),
                ),
        };
        const result = await this.businessValidationService.validate(request);
        await this.publisher.publish({
            request,
            result,
            settings,
            trigger: 'recheck',
            headSha: pr.head?.sha,
        });
        return true;
    }
}
