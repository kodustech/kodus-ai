import { LoadExternalContextStage } from './load-external-context.stage';
import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';

/**
 * `previousDecisions` (issue #1313) ships unconditionally — no alpha gate,
 * every org gets it. This locks two things: (1) it always reads and attaches
 * decisions when there are files + a resolvable PR/repo, with no feature-gate
 * call anywhere in the path; (2) it still fails open — a store/use-case error
 * degrades to "no history", it never aborts the review.
 */
describe('LoadExternalContextStage previous review decisions (issue #1313, unconditional)', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const context = {
        organizationAndTeamData,
        repository: { id: 'repo-1', name: 'repo', fullName: 'org/repo' },
        pullRequest: { head: { ref: 'feature' }, number: 42 },
        changedFiles: [{ filename: 'src/index.ts' }],
    } as any;

    const decision: PrDecisionRecord = {
        suggestionId: 'sug-1',
        relevantFile: 'src/index.ts',
        suggestionContent: 'Use const instead of let.',
        label: 'bug',
        outcome: 'implemented',
        decidedAt: '2026-01-01T00:00:00.000Z',
    };

    function makeStage(execute: jest.Mock = jest.fn().mockResolvedValue([decision])) {
        const featureGate = { isEnabled: jest.fn() };
        const buildPreviousReviewDecisionsUseCase = { execute };

        const stage = new LoadExternalContextStage(
            {} as any,
            {} as any,
            {} as any,
            { execute: jest.fn() } as any,
            featureGate as any,
            { getReleaseTrack: jest.fn() } as any,
            buildPreviousReviewDecisionsUseCase as any,
        );

        return { stage, buildPreviousReviewDecisionsUseCase, featureGate };
    }

    it('loads decisions scoped to the changed files with no feature-gate check', async () => {
        const { stage, buildPreviousReviewDecisionsUseCase, featureGate } =
            makeStage();

        const result = await (stage as any).loadPreviousReviewDecisions(
            context,
        );

        expect(result).toEqual([decision]);
        expect(buildPreviousReviewDecisionsUseCase.execute).toHaveBeenCalledWith({
            organizationId: 'org-1',
            prNumber: 42,
            repositoryFullName: 'org/repo',
            filePaths: ['src/index.ts'],
        });
        // No alpha gate for this feature — every org gets it.
        expect(featureGate.isEnabled).not.toHaveBeenCalled();
    });

    it('returns undefined (not an empty array) when there are no changed files', async () => {
        const { stage, buildPreviousReviewDecisionsUseCase } = makeStage();

        const result = await (stage as any).loadPreviousReviewDecisions({
            ...context,
            changedFiles: [],
        });

        expect(result).toBeUndefined();
        expect(buildPreviousReviewDecisionsUseCase.execute).not.toHaveBeenCalled();
    });

    it('returns undefined without querying when the repository full name cannot be resolved', async () => {
        const { stage, buildPreviousReviewDecisionsUseCase } = makeStage();

        const result = await (stage as any).loadPreviousReviewDecisions({
            ...context,
            repository: { id: 'repo-1', name: 'repo' }, // no fullName
            pullRequest: { head: { ref: 'feature' }, number: 42 }, // no base.repo.fullName fallback either
        });

        expect(result).toBeUndefined();
        expect(buildPreviousReviewDecisionsUseCase.execute).not.toHaveBeenCalled();
    });

    it('returns undefined without querying when the PR number cannot be resolved', async () => {
        const { stage, buildPreviousReviewDecisionsUseCase } = makeStage();

        const result = await (stage as any).loadPreviousReviewDecisions({
            ...context,
            pullRequest: { head: { ref: 'feature' } }, // no number
        });

        expect(result).toBeUndefined();
        expect(buildPreviousReviewDecisionsUseCase.execute).not.toHaveBeenCalled();
    });

    it('fails open when the use-case throws (Mongo unavailable, etc.) — never aborts the review', async () => {
        const { stage } = makeStage(
            jest.fn().mockRejectedValue(new Error('Mongo unavailable')),
        );

        await expect(
            (stage as any).loadPreviousReviewDecisions(context),
        ).resolves.toBeUndefined();
    });

    it('returns undefined when the use-case finds no decisions', async () => {
        const { stage } = makeStage(jest.fn().mockResolvedValue([]));

        await expect(
            (stage as any).loadPreviousReviewDecisions(context),
        ).resolves.toBeUndefined();
    });
});
