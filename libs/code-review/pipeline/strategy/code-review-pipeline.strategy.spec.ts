import { PipelineStage } from '@libs/core/infrastructure/pipeline/interfaces/pipeline.interface';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { CodeReviewPipelineStrategy } from './code-review-pipeline.strategy';

type Stage = PipelineStage<CodeReviewPipelineContext>;

const mockStage = (stageName: string): Stage =>
    ({ stageName, execute: jest.fn() }) as unknown as Stage;

// Agent is the only engine now — the pipeline is linear (no EE branch, no
// engine-selection gate). Constructor order must match the strategy's.
const buildStrategy = (): CodeReviewPipelineStrategy =>
    new CodeReviewPipelineStrategy(
        mockStage('ValidatePrerequisitesStage') as any,
        mockStage('ValidateNewCommitsStage') as any,
        mockStage('ResolveConfigStage') as any,
        mockStage('ValidateConfigStage') as any,
        mockStage('FetchChangedFilesStage') as any,
        mockStage('LoadExternalContextStage') as any,
        mockStage('InitialCommentStage') as any,
        mockStage('BusinessLogicValidationStage') as any,
        mockStage('CreateSandboxStage') as any,
        mockStage('AgentReviewStage') as any,
        mockStage('CreatePrLevelCommentsStage') as any,
        mockStage('ValidateSuggestionsStage') as any,
        mockStage('CreateFileCommentsStage') as any,
        mockStage('AggregateResultsStage') as any,
        mockStage('UpdateCommentsAndGenerateSummaryStage') as any,
        mockStage('RequestChangesOrApproveStage') as any,
    );

const EXPECTED_ORDER = [
    // shared early
    'ValidatePrerequisitesStage',
    'ValidateNewCommitsStage',
    'ResolveConfigStage',
    'ValidateConfigStage',
    'FetchChangedFilesStage',
    'LoadExternalContextStage',
    'InitialCommentStage',
    // agent engine (the only engine)
    'BusinessLogicValidationStage',
    'CreateSandboxStage',
    'AgentReviewStage',
    // shared post
    'CreatePrLevelCommentsStage',
    'ValidateSuggestionsStage',
    'CreateFileCommentsStage',
    'AggregateResultsStage',
    'UpdateCommentsAndGenerateSummaryStage',
    'RequestChangesOrApproveStage',
];

const REMOVED_EE_STAGES = [
    'CollectCrossFileContextStage',
    'KodyFineTuningStage',
    'PRLevelReviewStage',
    'FileAnalysisStage',
];

describe('CodeReviewPipelineStrategy', () => {
    it('assembles a single linear agent pipeline in the expected order', () => {
        const names = buildStrategy()
            .configureStages()
            .map((s) => s.stageName);
        expect(names).toEqual(EXPECTED_ORDER);
    });

    it('contains no EE-engine stages', () => {
        const names = buildStrategy()
            .configureStages()
            .map((s) => s.stageName);
        for (const ee of REMOVED_EE_STAGES) {
            expect(names).not.toContain(ee);
        }
    });
});
