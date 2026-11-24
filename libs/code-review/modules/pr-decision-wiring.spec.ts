import { MODULE_METADATA } from '@nestjs/common/constants';

import {
    DECISION_RECORDER_TOKEN,
    HOST_DRIVER_TOKEN,
    L0_ASSESSOR_TOKEN,
    L1_ASSESSOR_TOKEN,
    L2_ASSESSOR_TOKEN,
    L3_ASSESSOR_TOKEN,
} from '../domain/contracts/pr-decision-reconciler.ports';
import { CodeReviewPipelineModule } from '../pipeline/code-review-pipeline.module';

/**
 * The wiring of the per-PR reconciler into the code review pipeline.
 *
 * Two properties matter and neither is visible from the reconciler's own
 * unit tests:
 *
 *   1. The port bindings exist and point at the concrete adapters. A missing
 *      token is a boot-time failure in every worker, not a runtime failure on
 *      one PR — so it must be caught by a test, not by the first deploy.
 *
 *   2. The pipeline shape is the SAME whether the flag is on or off. The
 *      stage is always in the stage list; the flag decides whether it acts.
 *      A flag that changed the shape would mean two different pipelines and
 *      two different behaviours to reason about during the rollout.
 */
describe('PrDecision reconciler wiring', () => {
    const providers: any[] =
        Reflect.getMetadata(
            MODULE_METADATA.PROVIDERS,
            CodeReviewPipelineModule,
        ) ?? [];

    const imports: unknown[] =
        Reflect.getMetadata(
            MODULE_METADATA.IMPORTS,
            CodeReviewPipelineModule,
        ) ?? [];

    const providedTokens = new Set(
        providers
            .filter((p) => p && typeof p === 'object' && 'provide' in p)
            .map((p: any) => p.provide),
    );

    /**
     * `imports` holds a mix of module classes and Nest's `ForwardReference`
     * objects (what `forwardRef(() => X)` produces). A `ForwardReference`
     * exposes the deferred class on its `forwardRef` property; calling the
     * property resolves the reference.
     */
    const importedNames = imports.map((entry: any) => {
        const candidate = entry?.forwardRef ?? entry?.module ?? entry;
        if (typeof candidate === 'function') {
            try {
                return candidate()?.name ?? candidate.name;
            } catch {
                return candidate.name;
            }
        }
        return candidate?.name;
    });

    it('registers the reconciler service and stage as providers', () => {
        const classNames = providers
            .filter((p) => typeof p === 'function')
            .map((p: any) => p.name);
        expect(classNames).toContain('PrDecisionReconcilerService');
        expect(classNames).toContain('PrDecisionReconcilerStage');
    });

    it('imports the module that holds the reconciler record', () => {
        expect(importedNames).toContain('PrDecisionRecordModule');
    });

    it('binds every reconciler port to a concrete provider', () => {
        // The bindings live in the pipeline module itself: it already
        // imports every adapter's dependency, and a separate module for them
        // would close a load-time cycle (adapters -> CodebaseModule ->
        // pipeline -> adapters) that `forwardRef` cannot break.
        for (const token of [
            L0_ASSESSOR_TOKEN,
            L1_ASSESSOR_TOKEN,
            L2_ASSESSOR_TOKEN,
            L3_ASSESSOR_TOKEN,
            HOST_DRIVER_TOKEN,
            DECISION_RECORDER_TOKEN,
        ]) {
            expect(providedTokens.has(token)).toBe(true);
        }
    });

    it('exports the reconciler service so other modules can use it', () => {
        const exportsList: unknown[] =
            Reflect.getMetadata(
                MODULE_METADATA.EXPORTS,
                CodeReviewPipelineModule,
            ) ?? [];
        const exportNames = exportsList.map((e: any) => e?.name);
        expect(exportNames).toContain('PrDecisionReconcilerService');
    });

    it('binds each reconciler port exactly once', () => {
        // Two bindings for the same token would make the effective adapter
        // depend on module load order.
        const bindings = providers
            .filter((p) => p && typeof p === 'object' && 'provide' in p)
            .map((p: any) => p.provide);

        for (const token of [
            L0_ASSESSOR_TOKEN,
            L1_ASSESSOR_TOKEN,
            L2_ASSESSOR_TOKEN,
            L3_ASSESSOR_TOKEN,
            HOST_DRIVER_TOKEN,
            DECISION_RECORDER_TOKEN,
        ]) {
            expect(bindings.filter((t: any) => t === token)).toHaveLength(1);
        }
    });
});
