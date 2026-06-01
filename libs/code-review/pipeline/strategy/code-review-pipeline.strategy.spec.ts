import { PipelineStage } from '@libs/core/infrastructure/pipeline/interfaces/pipeline.interface';

import { AgentReviewStage } from '../stages/agent-review.stage';
import { BusinessLogicValidationStage } from '../stages/business-logic-validation.stage';
import { CollectCrossFileContextStage } from '../stages/collect-cross-file-context.stage';
import { CreateSandboxStage } from '../stages/create-sandbox.stage';
import { FileContextGateStage } from '../stages/file-context-gate.stage';
import { ProcessFilesPrLevelReviewStage } from '../stages/process-files-pr-level-review.stage';
import { ProcessFilesReview } from '../stages/process-files-review.stage';
import { KodyFineTuningStage } from '@libs/ee/codeReview/stages/kody-fine-tuning.stage';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { CodeReviewPipelineStrategy } from './code-review-pipeline.strategy';
import {
    AGENT_BRANCH_STAGE_NAMES,
    EE_BRANCH_STAGE_NAMES,
} from './engine-branches.const';

type Stage = PipelineStage<CodeReviewPipelineContext>;

const mockStage = (stageName: string): Stage =>
    ({ stageName, execute: jest.fn() }) as unknown as Stage;

/**
 * Construct a stage class without touching its DI deps. Proxies every
 * argument so the constructor's `private readonly x = arg` assignments
 * work without throwing — gets us a usable instance whose own
 * `stageName` field initializer has run. Used to verify our constants
 * match the real classes' stageName, since class-fields aren't on the
 * prototype and require instantiation to read.
 */
const instantiateForName = <T>(
    StageClass: new (...args: any[]) => T,
): T => {
    const noopProxy: any = new Proxy(() => noopProxy, {
        get: () => noopProxy,
        apply: () => noopProxy,
    });
    return Reflect.construct(StageClass, new Array(20).fill(noopProxy)) as T;
};

/**
 * Build the strategy with stub stage instances whose names match the
 * production stages' `stageName` literals (NOT the class names — the
 * two differ for ProcessFilesReview → 'FileAnalysisStage' and
 * ProcessFilesPrLevelReviewStage → 'PRLevelReviewStage'). The strategy
 * doesn't execute them — we only care about the names returned by the
 * branch grouping methods.
 */
const buildStrategy = (): CodeReviewPipelineStrategy =>
    new CodeReviewPipelineStrategy(
        mockStage('ValidatePrerequisitesStage') as any,
        mockStage('ValidateNewCommitsStage') as any,
        mockStage('ResolveConfigStage') as any,
        mockStage('SelectReviewEngineStage') as any,
        mockStage('ValidateConfigStage') as any,
        mockStage('FetchChangedFilesStage') as any,
        mockStage('LoadExternalContextStage') as any,
        mockStage('InitialCommentStage') as any,
        mockStage('FileContextGateStage') as any,
        mockStage('CollectCrossFileContextStage') as any,
        mockStage('KodyFineTuningStage') as any,
        mockStage('PRLevelReviewStage') as any,
        mockStage('FileAnalysisStage') as any,
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

describe('CodeReviewPipelineStrategy', () => {
    // Catches the class-name-vs-stageName drift that silently broke the
    // skipStages bypass — we instantiate each real branch class (with
    // its DI deps proxied to no-ops) and assert the live `stageName`
    // matches what the constants advertise. If a stage rename ever
    // breaks the contract, this test fails before the gate goes silent.
    describe('constants vs real classes', () => {
        it('EE_BRANCH_STAGE_NAMES matches every EE branch class’s stageName', () => {
            const liveNames = [
                instantiateForName(FileContextGateStage),
                instantiateForName(CollectCrossFileContextStage),
                instantiateForName(KodyFineTuningStage),
                instantiateForName(ProcessFilesPrLevelReviewStage),
                instantiateForName(ProcessFilesReview),
            ].map((s) => (s as { stageName: string }).stageName);
            expect(liveNames).toEqual([...EE_BRANCH_STAGE_NAMES]);
        });

        it('AGENT_BRANCH_STAGE_NAMES matches every agent branch class’s stageName', () => {
            const liveNames = [
                instantiateForName(BusinessLogicValidationStage),
                instantiateForName(CreateSandboxStage),
                instantiateForName(AgentReviewStage),
            ].map((s) => (s as { stageName: string }).stageName);
            expect(liveNames).toEqual([...AGENT_BRANCH_STAGE_NAMES]);
        });
    });

    it('eeBranchStages() returns stages whose names match EE_BRANCH_STAGE_NAMES', () => {
        const strategy = buildStrategy();
        const names = strategy.eeBranchStages().map((s) => s.stageName);
        expect(names).toEqual([...EE_BRANCH_STAGE_NAMES]);
    });

    it('agentBranchStages() returns stages whose names match AGENT_BRANCH_STAGE_NAMES', () => {
        const strategy = buildStrategy();
        const names = strategy.agentBranchStages().map((s) => s.stageName);
        expect(names).toEqual([...AGENT_BRANCH_STAGE_NAMES]);
    });

    describe('configureStages()', () => {
        let names: string[];
        beforeEach(() => {
            names = buildStrategy()
                .configureStages()
                .map((s) => s.stageName);
        });

        it('places SelectReviewEngineStage AFTER ResolveConfigStage so config + preliminaryFiles are populated', () => {
            const resolveIdx = names.indexOf('ResolveConfigStage');
            const selectIdx = names.indexOf('SelectReviewEngineStage');
            expect(resolveIdx).toBeGreaterThanOrEqual(0);
            expect(selectIdx).toBeGreaterThan(resolveIdx);
        });

        it('places SelectReviewEngineStage BEFORE FetchChangedFilesStage so useAgentEngine is set before the size-limit check', () => {
            const selectIdx = names.indexOf('SelectReviewEngineStage');
            const fetchIdx = names.indexOf('FetchChangedFilesStage');
            expect(fetchIdx).toBeGreaterThan(selectIdx);
        });

        it('places the EE branch contiguously', () => {
            const indices = [...EE_BRANCH_STAGE_NAMES].map((name) =>
                names.indexOf(name),
            );
            for (let i = 1; i < indices.length; i++) {
                expect(indices[i]).toBe(indices[i - 1] + 1);
            }
        });

        it('places the agent branch contiguously', () => {
            const indices = [...AGENT_BRANCH_STAGE_NAMES].map((name) =>
                names.indexOf(name),
            );
            for (let i = 1; i < indices.length; i++) {
                expect(indices[i]).toBe(indices[i - 1] + 1);
            }
        });

        it('places shared post-processing stages after both branches', () => {
            const lastBranchIdx = Math.max(
                ...[...EE_BRANCH_STAGE_NAMES, ...AGENT_BRANCH_STAGE_NAMES].map(
                    (name) => names.indexOf(name),
                ),
            );
            const firstPostIdx = names.indexOf('CreatePrLevelCommentsStage');
            expect(firstPostIdx).toBeGreaterThan(lastBranchIdx);
        });
    });
});
