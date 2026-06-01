import { Test, TestingModule } from '@nestjs/testing';
import { ValidateNewCommitsStage } from './validate-new-commits.stage';
import { AUTOMATION_EXECUTION_SERVICE_TOKEN } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PipelineReasons } from '@libs/core/infrastructure/pipeline/constants/pipeline-reasons.const';
import { StageMessageHelper } from '@libs/core/infrastructure/pipeline/utils/stage-message.helper';

describe('ValidateNewCommitsStage', () => {
    let stage: ValidateNewCommitsStage;
    let mockAutomationExecutionService: any;
    let mockPullRequestManagerService: any;
    let context: CodeReviewPipelineContext;

    beforeEach(async () => {
        mockAutomationExecutionService = {
            findLatestExecutionByFilters: jest.fn(),
            hasStageWithStatus: jest.fn(),
        };

        mockPullRequestManagerService = {
            getNewCommitsSinceLastExecution: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ValidateNewCommitsStage,
                {
                    provide: AUTOMATION_EXECUTION_SERVICE_TOKEN,
                    useValue: mockAutomationExecutionService,
                },
                {
                    provide: PULL_REQUEST_MANAGER_SERVICE_TOKEN,
                    useValue: mockPullRequestManagerService,
                },
            ],
        }).compile();

        stage = module.get<ValidateNewCommitsStage>(ValidateNewCommitsStage);

        context = {
            pullRequest: { number: 1, head: { sha: 'head-sha' } } as any,
            repository: { id: 'repo-1', name: 'repo' } as any,
            organizationAndTeamData: {} as any,
            teamAutomationId: 'team-automation-id',
        } as CodeReviewPipelineContext;
    });

    it('should skip if PR has 0 commits (using PipelineReasons)', async () => {
        // Mock no last execution
        mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            null,
        );
        // Mock 0 commits found
        mockPullRequestManagerService.getNewCommitsSinceLastExecution.mockResolvedValue(
            [],
        );

        const result = await stage.execute(context);

        expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);

        const expectedMessage = StageMessageHelper.skippedWithReason(
            PipelineReasons.COMMITS.NO_NEW,
            'PR has 0 commits',
        );

        expect(result.statusInfo.message).toBe(expectedMessage);
        expect(result.pipelineMetadata?.forceFullRerun).toBe(false);
    });

    it('should skip if no NEW commits are found (using PipelineReasons)', async () => {
        // Mock last execution exists
        mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            {
                dataExecution: { lastAnalyzedCommit: 'sha-1' },
            },
        );

        const oldCommit = { sha: 'sha-1' };
        // Mock returns existing commit, but logic filters it out
        mockPullRequestManagerService.getNewCommitsSinceLastExecution.mockResolvedValue(
            [oldCommit],
        );

        const result = await stage.execute(context);

        expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);

        const expectedMessage = StageMessageHelper.skippedWithReason(
            PipelineReasons.COMMITS.NO_NEW,
            'No changes detected since last review',
        );

        expect(result.statusInfo.message).toBe(expectedMessage);
        expect(result.pipelineMetadata?.forceFullRerun).toBe(false);
    });

    it('should skip if only merge commits are found (using PipelineReasons)', async () => {
        // Mock no last execution
        mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            null,
        );

        const mergeCommit = {
            sha: 'merge-sha',
            parents: [{ sha: 'p1' }, { sha: 'p2' }],
            message: 'Merge pull request',
        };
        // Mock only merge commits
        mockPullRequestManagerService.getNewCommitsSinceLastExecution.mockResolvedValue(
            [mergeCommit],
        );

        const result = await stage.execute(context);

        expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);

        // logic returns "Only Merge Commits" with no tech detail in my implementation of stage,
        // OR it might have tech detail if I passed one.
        // Let's check my implementation:
        // message: StageMessageHelper.skippedWithReason(PipelineReasons.COMMITS.ONLY_MERGE),
        // No second arg. So no tech detail in parens.
        // But `StageMessageHelper` might append tech detail if I passed it to `skippedWithReason`.
        // I didn't pass it.
        // HOWEVER, the `ValidateNewCommitsStage.ts` logic at the top (lines 110+) does:
        // draft.statusInfo.message = details?.technicalReason ? `${message} (${details.technicalReason})` : message;
        // Wait!
        // In lines 110+, `message` is retrieved from `details.message`.
        // If I set `details.message` using `skippedWithReason`, it already contains the formatted string.
        // Then lines 151-153 append `(${details.technicalReason})` AGAIN?

        // Let's look at lines 151-153 in `ValidateNewCommitsStage.ts`:
        // draft.statusInfo.message = details?.technicalReason ? `${message} (${details.technicalReason})` : message;

        // In my implementation of `validateCommits`:
        // details: {
        //    message: StageMessageHelper.skippedWithReason(PipelineReasons.COMMITS.ONLY_MERGE),
        //    technicalReason: 'All new commits identified as merge commits',
        // }

        // So `message` = "Only Merge Commits — Merge commits are skipped to avoid noise"
        // Then `draft.statusInfo.message` becomes:
        // "Only Merge Commits — Merge commits are skipped to avoid noise (All new commits identified as merge commits)"

        // This seems redundant or double-wrapping if `skippedWithReason` was supposed to handle it.
        // But `skippedWithReason` was called WITHOUT tech detail.
        // So the "outer" wrapping adds the tech detail.
        // Ideally I should remove the outer wrapping in `executeStage` and let `validateCommits` handle full formatting using `skippedWithReason(reason, techDetail)`.

        // IF I do that, I need to update `executeStage` logic.
        // Currently `executeStage` forces the append.

        // Let's fix `executeStage` to NOT double-wrap if `message` already looks formatted? No, that's hacky.
        // Better: Update `executeStage` to just use `details.message` if available.
        // AND ensure `validateCommits` returns the FULLY formatted message in `details.message`.

        // Let's check `executeStage` again.

        const expectedMessage = `${PipelineReasons.COMMITS.ONLY_MERGE.message}`;
        expect(result.statusInfo.message).toContain(expectedMessage);
    });

    it('should force full rerun for manual command when previous execution had partial/error analysis', async () => {
        context.origin = 'command';

        mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            {
                uuid: 'exec-1',
                dataExecution: { lastAnalyzedCommit: 'sha-1' },
            },
        );
        mockAutomationExecutionService.hasStageWithStatus.mockResolvedValue(
            true,
        );

        const oldCommit = { sha: 'sha-1' };
        mockPullRequestManagerService.getNewCommitsSinceLastExecution.mockResolvedValue(
            [oldCommit],
        );

        const result = await stage.execute(context);

        expect(result.statusInfo?.status).not.toBe(AutomationStatus.SKIPPED);
        expect(result.pipelineMetadata?.forceFullRerun).toBe(true);
        expect(
            mockAutomationExecutionService.hasStageWithStatus,
        ).toHaveBeenCalledWith(
            'exec-1',
            ['PRLevelReviewStage', 'FileAnalysisStage'],
            [AutomationStatus.PARTIAL_ERROR, AutomationStatus.ERROR],
        );
    });

    describe('orphaned baseCommit detection (rebase / force-push)', () => {
        it('should force full rerun when lastAnalyzedCommit is not in PR commits (orphan)', async () => {
            mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                {
                    uuid: 'exec-prev',
                    dataExecution: {
                        lastAnalyzedCommit: { sha: 'OLD_ORPHAN_SHA' },
                    },
                },
            );

            // PR head was rebased — orphan SHA is gone, only new SHAs remain.
            mockPullRequestManagerService.getNewCommitsSinceLastExecution.mockResolvedValue(
                [{ sha: 'NEW_HEAD_SHA', parents: [{ sha: 'BASE_SHA' }] }],
            );

            const result = await stage.execute(context);

            expect(result.statusInfo?.status).not.toBe(
                AutomationStatus.SKIPPED,
            );
            expect(result.pipelineMetadata?.forceFullRerun).toBe(true);
        });

        it('should clear lastAnalyzedCommit from pipeline context when orphan detected', async () => {
            mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                {
                    uuid: 'exec-prev',
                    dataExecution: {
                        lastAnalyzedCommit: { sha: 'OLD_ORPHAN_SHA' },
                        commentId: 'c1',
                        noteId: 'n1',
                        threadId: 't1',
                    },
                },
            );

            mockPullRequestManagerService.getNewCommitsSinceLastExecution.mockResolvedValue(
                [{ sha: 'NEW_HEAD_SHA', parents: [{ sha: 'BASE_SHA' }] }],
            );

            const result = await stage.execute(context);

            expect(result.lastExecution?.lastAnalyzedCommit).toBeUndefined();
            // Other lastExecution fields must be preserved (we only zero the SHA).
            expect(result.lastExecution?.commentId).toBe('c1');
            expect(result.lastExecution?.noteId).toBe('n1');
            expect(result.lastExecution?.threadId).toBe('t1');
        });

        it('should set orphanedBaseCommit on context when orphan detected (for persistence)', async () => {
            mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                {
                    uuid: 'exec-prev',
                    dataExecution: {
                        lastAnalyzedCommit: { sha: 'OLD_ORPHAN_SHA' },
                    },
                },
            );

            const allCommits = [
                { sha: 'NEW_A', parents: [{ sha: 'BASE_SHA' }] },
                { sha: 'NEW_B', parents: [{ sha: 'NEW_A' }] },
            ];
            mockPullRequestManagerService.getNewCommitsSinceLastExecution.mockResolvedValue(
                allCommits,
            );

            const result = await stage.execute(context);

            expect(result.orphanedBaseCommit).toEqual({
                previousSha: 'OLD_ORPHAN_SHA',
                currentHeadSha: 'head-sha',
                totalCommits: 2,
            });
        });

        it('should pass all PR commits as prCommits when orphan detected (full rerun input)', async () => {
            mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                {
                    uuid: 'exec-prev',
                    dataExecution: {
                        lastAnalyzedCommit: { sha: 'OLD_ORPHAN_SHA' },
                    },
                },
            );

            const allCommits = [
                { sha: 'NEW_A', parents: [{ sha: 'BASE_SHA' }] },
                { sha: 'NEW_B', parents: [{ sha: 'NEW_A' }] },
            ];
            mockPullRequestManagerService.getNewCommitsSinceLastExecution.mockResolvedValue(
                allCommits,
            );

            const result = await stage.execute(context);

            expect(result.prAllCommits).toEqual(allCommits);
            expect(result.prCommits).toEqual(allCommits);
        });

        it('should emit warn log with reason "orphaned_base_commit" when orphan detected', async () => {
            mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                {
                    uuid: 'exec-prev',
                    dataExecution: {
                        lastAnalyzedCommit: { sha: 'OLD_ORPHAN_SHA' },
                    },
                },
            );
            mockPullRequestManagerService.getNewCommitsSinceLastExecution.mockResolvedValue(
                [{ sha: 'NEW_HEAD_SHA', parents: [{ sha: 'BASE_SHA' }] }],
            );

            const warnSpy = jest
                .spyOn((stage as any).logger, 'warn')
                .mockImplementation(() => {});

            await stage.execute(context);

            const warnCalls = warnSpy.mock.calls.map((c) => c[0] as any);
            const orphanWarn = warnCalls.find(
                (call) => call?.metadata?.reason === 'orphaned_base_commit',
            );

            expect(orphanWarn).toBeDefined();
            expect(orphanWarn?.metadata).toEqual(
                expect.objectContaining({
                    reason: 'orphaned_base_commit',
                    orphanedSha: 'OLD_ORPHAN_SHA',
                    pullRequestNumber: 1,
                }),
            );

            warnSpy.mockRestore();
        });

        it('should preserve incremental flow when lastAnalyzedCommit IS in PR commits (regression guard)', async () => {
            mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                {
                    uuid: 'exec-prev',
                    dataExecution: {
                        lastAnalyzedCommit: { sha: 'KNOWN_SHA' },
                    },
                },
            );

            const allCommits = [
                { sha: 'KNOWN_SHA', parents: [{ sha: 'BASE' }] },
                { sha: 'NEW_1', parents: [{ sha: 'KNOWN_SHA' }] },
                { sha: 'NEW_2', parents: [{ sha: 'NEW_1' }] },
            ];
            mockPullRequestManagerService.getNewCommitsSinceLastExecution.mockResolvedValue(
                allCommits,
            );

            const result = await stage.execute(context);

            expect(result.pipelineMetadata?.forceFullRerun).toBe(false);
            expect(result.lastExecution?.lastAnalyzedCommit).toEqual({
                sha: 'KNOWN_SHA',
            });
            expect(result.prCommits).toEqual([
                { sha: 'NEW_1', parents: [{ sha: 'KNOWN_SHA' }] },
                { sha: 'NEW_2', parents: [{ sha: 'NEW_1' }] },
            ]);
            expect(result.prAllCommits).toEqual(allCommits);
            // Field must remain absent on normal flow — _buildExecutionData
            // only persists when present, so undefined keeps DB clean.
            expect(result.orphanedBaseCommit).toBeUndefined();
        });
    });
});
