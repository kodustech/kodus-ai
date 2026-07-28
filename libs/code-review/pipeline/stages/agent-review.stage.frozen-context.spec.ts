import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * Executes the stage against a DEEP-FROZEN context — the shape production
 * hands it (issue #1452 matrix-gaps item 3).
 *
 * This stage is where the frozen-mutation family started: #1522 stamped the
 * resolved heavy flag with a direct `context.heavy = …` on a context that an
 * earlier stage's produce() had already frozen. It threw before the
 * orchestrator ran, the stage's catch swallowed it, and every review for ~27h
 * finished "in seconds with 0 suggestions".
 *
 * The existing agent-review spec only covers two pure helpers
 * (extractValidDiffLines / snapLinesToDiff) and never runs the stage, so
 * re-introducing that exact mutation passes CI today — verified by injecting
 * it. Freezing the other stage specs' builders doesn't help here: there was no
 * context to freeze. This spec closes that.
 */
describe('AgentReviewStage — frozen context (regression #1522)', () => {
    const makeStage = () => {
        const reviewOrchestrator = {
            execute: jest.fn().mockResolvedValue({
                suggestions: [],
                overallComment: undefined,
            }),
        };
        const featureGate = {
            // heavy-review alpha gate: ON, so resolveHeavy returns true and the
            // stage reaches the write-back.
            isEnabled: jest.fn().mockResolvedValue(true),
        };
        const observabilityService = {
            runLLMInSpan: jest.fn(async ({ runFn }: any) => runFn?.()),
        };
        const stage = new AgentReviewStage(
            { findLatestExecutionByDataExecutionFilter: jest.fn() } as any,
            { findByExternalId: jest.fn().mockResolvedValue(null) } as any,
            reviewOrchestrator as any,
            observabilityService as any,
            { generateContext: jest.fn(), generateContextLegacy: jest.fn() } as any,
            featureGate as any,
            {
                getReleaseTrack: jest.fn().mockResolvedValue('stable'),
            } as any,
        );
        return { stage, reviewOrchestrator, featureGate };
    };

    const makeContext = (over: Record<string, unknown> = {}) =>
        frozenContext({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
            repository: { id: 'repo-1', name: 'repo-1' },
            pullRequest: { number: 42 },
            platformType: 'GITHUB',
            changedFiles: [
                { filename: 'src/a.ts', patch: '@@ -1 +1 @@\n+const a = 1;' },
            ],
            // heavy comes from the CONFIG and must be STAMPED onto the
            // context by the stage. Starting at false is what makes the assert
            // below meaningful: a `true` result can only come from the write-back.
            codeReviewConfig: { reviewOptions: {}, heavy: true },
            heavy: false,
            validSuggestions: [],
            discardedSuggestions: [],
            errors: [],
            dryRun: { enabled: false },
            ...over,
        }) as any as CodeReviewPipelineContext;

    it('stamps the resolved heavy flag without mutating the frozen context', async () => {
        const { stage } = makeStage();

        // The OLD code threw "Cannot assign to read only property 'heavy'"
        // right here, before the orchestrator ever ran.
        const result = await (stage as any).executeStage(makeContext());

        expect(result.heavy).toBe(true);
    });

    it('reaches the orchestrator (the heavy write-back is not swallowed)', async () => {
        const { stage, reviewOrchestrator } = makeStage();

        await (stage as any).executeStage(makeContext());

        // #1522's tell: the stage "finished" without ever calling the finder.
        expect(reviewOrchestrator.execute).toHaveBeenCalledTimes(1);
    });
});
