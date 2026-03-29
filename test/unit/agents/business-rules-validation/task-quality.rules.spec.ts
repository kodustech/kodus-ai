import {
    buildBusinessLogicEligibility,
    canProceedWithBusinessRulesAnalysis,
    getTaskContextMissingInfoMessage,
    normalizeTaskQuality,
    TASK_QUALITY_ANALYZER_POLICY,
} from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/task-quality.rules';

describe('task-quality.rules', () => {
    it('allows analysis only for PARTIAL and COMPLETE', () => {
        expect(canProceedWithBusinessRulesAnalysis('PARTIAL')).toBe(true);
        expect(canProceedWithBusinessRulesAnalysis('COMPLETE')).toBe(true);
        expect(canProceedWithBusinessRulesAnalysis('EMPTY')).toBe(false);
        expect(canProceedWithBusinessRulesAnalysis('MINIMAL')).toBe(false);
    });

    it('normalizes unknown values to EMPTY', () => {
        expect(normalizeTaskQuality('COMPLETE')).toBe('COMPLETE');
        expect(normalizeTaskQuality('invalid')).toBe('EMPTY');
        expect(normalizeTaskQuality(undefined)).toBe('EMPTY');
    });

    it('returns specific missing-info message based on task quality', () => {
        expect(getTaskContextMissingInfoMessage('EMPTY')).toContain(
            '## 🤔 Need Task Information',
        );
        expect(getTaskContextMissingInfoMessage('MINIMAL')).toContain(
            '## 🤔 Insufficient Task Context',
        );
    });

    it('exposes a canonical analyzer policy for task quality behavior', () => {
        expect(TASK_QUALITY_ANALYZER_POLICY).toContain(
            'EMPTY => needsMoreInfo = true',
        );
        expect(TASK_QUALITY_ANALYZER_POLICY).toContain(
            'PARTIAL => proceed with full gap analysis',
        );
    });

    it('builds limitation eligibility when task context is weak', () => {
        expect(
            buildBusinessLogicEligibility({
                taskQuality: 'MINIMAL',
                prDiff: 'diff --git a/file.ts b/file.ts',
                taskContext: 'KC-1441',
            }),
        ).toEqual(
            expect.objectContaining({
                mode: 'limitation_response',
                reason: 'task_context_weak',
                taskContextStatus: 'weak',
                prDiffStatus: 'usable',
            }),
        );
    });

    it('treats fetch-failure task payloads as weak context', () => {
        expect(
            buildBusinessLogicEligibility({
                taskQuality: 'PARTIAL',
                prDiff: 'diff --git a/file.ts b/file.ts',
                taskContext:
                    '{"error":true,"message":"Failed to fetch tenant info for cloud ID: abc Status: 404"}',
            }),
        ).toEqual(
            expect.objectContaining({
                mode: 'limitation_response',
                reason: 'task_context_weak',
                taskContextStatus: 'weak',
                prDiffStatus: 'usable',
            }),
        );
    });

    it('builds full-analysis eligibility when task context and diff are usable', () => {
        expect(
            buildBusinessLogicEligibility({
                taskQuality: 'COMPLETE',
                prDiff: 'diff --git a/file.ts b/file.ts',
                taskContext:
                    'Task with description and acceptance criteria for checkout flow.',
            }),
        ).toEqual(
            expect.objectContaining({
                mode: 'full_analysis',
                reason: 'analysis_ready',
                taskContextStatus: 'usable',
                prDiffStatus: 'usable',
            }),
        );
    });
});
