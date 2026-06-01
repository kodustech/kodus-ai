import { createLogger } from '@kodus/flow';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { IPipelineChecksService } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-checks-service.interface';
import { Injectable } from '@nestjs/common';
import {
    CheckConclusion,
    CheckStatus,
} from '../interfaces/checks-adapter.interface';
import { PipelineObserverContext } from '../interfaces/pipeline-observer.interface';
import { ChecksAdapterFactory } from './checks-adapter.factory';

export const checkStageMap = {
    _pipelineStart: {
        name: 'Code Review Started',
        title: 'Code Review Starting',
        summary: 'Kody is analyzing your code changes...',
    },

    PRLevelReviewStage: {
        name: 'PR-Level Analysis',
        title: 'Code Review In Progress',
        summary:
            'Reviewing PR-level changes: analyzing overall intent, descriptions, and cross-file impacts.',
    },
    FileAnalysisStage: {
        name: 'File-Level Analysis',
        title: 'Code Review In Progress',
        summary:
            'Reviewing file-level changes: analyzing each modified file for issues and improvement suggestions.',
    },

    _pipelineEndSuccess: {
        name: 'Code Review Completed',
        title: 'Code Review Complete',
        summary:
            'Review finished successfully. Suggestions (if any) were posted as PR/file comments.',
    },
    _pipelineEndFailure: {
        name: 'Code Review Failed',
        title: 'Code Review Failed',
        summary:
            'An error occurred during the review. Please check the logs for details.',
    },
    _pipelineEndPartial: {
        name: 'Code Review Completed with Warnings',
        title: 'Code Review Completed with Warnings',
        summary:
            'Review finished, but one or more non-critical stages failed. See details below.',
    },
    _pipelineEndSkipped: {
        name: 'Code Review Skipped',
        title: 'Code Review Skipped',
        summary: 'Review skipped.',
    },
} as const;

export type CheckStageName = keyof typeof checkStageMap;

export const CheckStageNames = Object.keys(checkStageMap).reduce(
    (acc, key) => {
        (acc as any)[key] = key;
        return acc;
    },
    {} as { [K in CheckStageName]: K },
);

@Injectable()
export class PipelineChecksService implements IPipelineChecksService {
    private readonly logger = createLogger(PipelineChecksService.name);

    constructor(private readonly checksAdapterFactory: ChecksAdapterFactory) {}

    private formatPipelineErrorDetail(
        errorItem: CodeReviewPipelineContext['errors'][number] | undefined,
    ): string | undefined {
        const message = errorItem?.error?.message?.trim();
        if (!message) {
            return undefined;
        }

        let stage = errorItem.stage;
        if (stage === 'PRLevelReviewStage') stage = 'PR Analysis';
        if (stage === 'FileAnalysisStage') stage = 'File Analysis';
        if (stage === 'FetchChangedFilesStage') stage = 'Fetch Files';

        let substage = errorItem.substage;
        if (
            substage === 'executeStage' ||
            substage === 'AnalyzeChangedFilesInBatches'
        ) {
            substage = undefined;
        }

        const location = [stage, substage].filter(Boolean).join(': ');
        return location ? `[${location}] ${message}` : message;
    }

    private isGenericFailureMessage(message: string): boolean {
        const normalized = message.trim().toLowerCase();
        return (
            normalized.includes('code review failed') ||
            normalized.includes('pipeline started') ||
            normalized.includes('code review started') ||
            normalized.includes('reviewing file level') ||
            normalized ===
                'an error occurred during the review. please check the logs for details.'
        );
    }

    private buildFailureSummaryFromContext(
        context: CodeReviewPipelineContext,
    ): string | undefined {
        const statusMessage = context.statusInfo?.message?.trim();
        const genericMessages = [
            'pipeline started',
            'code review started',
            'code review failed',
            'reviewing file level',
        ];

        const parts: string[] = [];

        // 1. Status Message (if not generic)
        if (
            statusMessage &&
            statusMessage.length > 0 &&
            !genericMessages.some((m) =>
                statusMessage.toLowerCase().includes(m),
            )
        ) {
            parts.push(`### Status\n${statusMessage}`);
        }

        // 2. Group Errors by Message
        const errorsByMessage = new Map<string, string[]>();

        (context.errors || []).forEach((item) => {
            const message = item.error?.message?.trim();
            if (!message) return;

            let stage = item.stage;
            if (stage === 'PRLevelReviewStage') stage = 'PR Analysis';
            if (stage === 'FileAnalysisStage') stage = 'File Analysis';
            if (stage === 'FetchChangedFilesStage') stage = 'Fetch Files';

            let substage = item.substage;
            if (
                substage === 'executeStage' ||
                substage === 'AnalyzeChangedFilesInBatches'
            ) {
                substage = undefined;
            }

            const location = [stage, substage].filter(Boolean).join(': ');
            const existing = errorsByMessage.get(message) || [];
            if (location) {
                existing.push(location);
            }
            errorsByMessage.set(message, existing);
        });

        if (errorsByMessage.size > 0) {
            parts.push(`### Errors`);
            const errorList: string[] = [];

            errorsByMessage.forEach((locations, message) => {
                let errorEntry = `- **${message}**`;
                if (locations.length > 0) {
                    const uniqueLocations = [...new Set(locations)];
                    const limit = 5;
                    const displayLocs = uniqueLocations.slice(0, limit);
                    const remaining = uniqueLocations.length - limit;

                    errorEntry += `\n  - Context: ${displayLocs.join(', ')}`;
                    if (remaining > 0) {
                        errorEntry += ` (+${remaining} more)`;
                    }
                }
                errorList.push(errorEntry);
            });

            parts.push(errorList.join('\n'));
        }

        // 3. Timeout-specific section
        const timeoutFiles = (context.errors || [])
            .filter((e) => e.metadata?.isTimeout && e.substage)
            .map((e) => e.substage as string);

        if (timeoutFiles.length > 0) {
            const displayFiles = timeoutFiles.slice(0, 10);
            const remaining = timeoutFiles.length - displayFiles.length;
            let timeoutSection = `### Timeouts\n- ${displayFiles.join(', ')}`;
            if (remaining > 0) {
                timeoutSection += ` (+${remaining} more)`;
            }
            parts.push(timeoutSection);
        }

        if (parts.length === 0) {
            return undefined;
        }

        return parts.join('\n\n');
    }

    private getContextData(
        observerContext: PipelineObserverContext,
        context: CodeReviewPipelineContext,
    ) {
        const {
            organizationAndTeamData,
            repository,
            pullRequest,
            platformType,
        } = context;

        const headSha = pullRequest?.head?.sha;
        if (!headSha) {
            this.logger.warn({
                message: 'No head SHA found in pull request context',
                context: PipelineChecksService.name,
            });
            return null;
        }

        const [owner, repo] = repository.fullName?.split('/') || [];
        if (!owner || !repo) {
            this.logger.warn({
                message: 'Invalid repository full name format',
                context: PipelineChecksService.name,
            });
            return null;
        }

        const { checkRunId } = observerContext;

        return {
            organizationAndTeamData,
            repository: {
                owner,
                name: repo,
            },
            headSha,
            platformType,
            checkRunId,
        };
    }

    async startCheck(
        observerContext: PipelineObserverContext,
        context: CodeReviewPipelineContext,
        stageName: string,
        status: CheckStatus = CheckStatus.IN_PROGRESS,
    ): Promise<void> {
        const data = this.getContextData(observerContext, context);
        if (!data) return;

        const {
            organizationAndTeamData,
            repository,
            headSha,
            platformType,
            checkRunId,
        } = data;

        const adapter = this.checksAdapterFactory.getAdapter(platformType);
        if (!adapter) {
            this.logger.warn({
                message: `No checks adapter found for platform type: ${platformType}`,
                context: PipelineChecksService.name,
            });
            return;
        }

        const stageData = checkStageMap[stageName];
        if (!stageData) return;

        const { name, title, summary } = stageData;

        if (checkRunId) {
            this.logger.warn({
                message:
                    'Check run already started in context, finalizing it first',
                context: PipelineChecksService.name,
            });
            await this.finalizeCheck(
                observerContext,
                context,
                CheckConclusion.SUCCESS,
            );
        }

        try {
            const checkId = await adapter.createCheckRun({
                organizationAndTeamData,
                repository,
                headSha,
                status,
                name,
                output: {
                    title,
                    summary,
                },
            });

            if (checkId) {
                observerContext.checkRunId = checkId;
            }
        } catch (e) {
            this.logger.error({
                message: 'Failed to start check',
                error: e as Error,
                context: PipelineChecksService.name,
            });
        }
    }

    async updateCheck(
        observerContext: PipelineObserverContext,
        context: CodeReviewPipelineContext,
        stageName: string,
        status: CheckStatus,
        conclusion?: CheckConclusion,
    ): Promise<void> {
        const data = this.getContextData(observerContext, context);
        if (!data) return;

        const {
            checkRunId,
            organizationAndTeamData,
            repository,
            platformType,
        } = data;
        if (!checkRunId) {
            this.logger.warn({
                message: 'No checkRunId found in context for updateCheck',
                context: PipelineChecksService.name,
            });
            return;
        }

        const adapter = this.checksAdapterFactory.getAdapter(platformType);
        if (!adapter) {
            this.logger.warn({
                message: `No checks adapter found for platform type: ${platformType}`,
                context: PipelineChecksService.name,
            });
            return;
        }

        const stageCheckInfo = checkStageMap[stageName];
        if (!stageCheckInfo) return;

        const { title, summary } = stageCheckInfo;

        try {
            await adapter.updateCheckRun({
                checkRunId,
                organizationAndTeamData,
                repository,
                status,
                output: { title, summary },
                conclusion,
            });
        } catch (e) {
            this.logger.error({
                message: 'Failed to update check',
                error: e as Error,
                context: PipelineChecksService.name,
            });
        }
    }

    async finalizeCheck(
        observerContext: PipelineObserverContext,
        context: CodeReviewPipelineContext,
        conclusion: CheckConclusion,
        stageName?: string,
        reason?: string,
    ): Promise<void> {
        const data = this.getContextData(observerContext, context);
        if (!data) return;

        const {
            checkRunId,
            organizationAndTeamData,
            repository,
            platformType,
        } = data;
        if (!checkRunId) {
            this.logger.warn({
                message: 'No checkRunId found in context for finalizeCheck',
                context: PipelineChecksService.name,
            });
            return;
        }

        const adapter = this.checksAdapterFactory.getAdapter(platformType);
        if (!adapter) {
            this.logger.warn({
                message: `No checks adapter found for platform type: ${platformType}`,
                context: PipelineChecksService.name,
            });
            return;
        }

        let name: string | undefined;
        let title: string | undefined;
        let summary: string | undefined = reason || undefined;
        if (stageName) {
            const stageCheckInfo = checkStageMap[stageName];
            if (stageCheckInfo) {
                name = stageCheckInfo.name;
                title = stageCheckInfo.title;
                summary = summary || stageCheckInfo.summary;
            }
        }

        if (
            stageName === CheckStageNames._pipelineEndFailure ||
            stageName === CheckStageNames._pipelineEndPartial
        ) {
            const shouldBuildFailureSummaryFromContext =
                !summary || this.isGenericFailureMessage(summary);

            if (shouldBuildFailureSummaryFromContext) {
                summary =
                    this.buildFailureSummaryFromContext(context) || summary;
            }
        }

        try {
            await adapter.updateCheckRun({
                checkRunId,
                organizationAndTeamData,
                repository,
                status: CheckStatus.COMPLETED,
                conclusion,
                name,
                output: summary
                    ? { title: title ?? 'Code Review', summary }
                    : undefined,
            });

            observerContext.checkRunId = undefined;
        } catch (e) {
            this.logger.error({
                message: 'Failed to finalize check',
                error: e as Error,
                context: PipelineChecksService.name,
            });
        }
    }
}
