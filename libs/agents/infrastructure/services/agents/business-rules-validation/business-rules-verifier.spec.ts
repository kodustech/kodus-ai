import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import { VERIFY_DONE_TOOL } from '@libs/agent-harness/infrastructure/verify/llm-verdict';
import {
    applyBusinessRulesVerdict,
    BusinessRulesVerifier,
    shouldVerifyValidationResult,
} from './business-rules-verifier';
import type { ValidationResult } from './types';

function runStateWithVerdict(keep: boolean, rationale = 'r'): RunState {
    return {
        runId: 'r',
        agentId: 'business-rules-verifier',
        steps: [],
        artifacts: [{ type: VERIFY_DONE_TOOL, payload: { keep, rationale } }],
        messages: [],
        usage: {},
    } as unknown as RunState;
}

const claim: ValidationResult = {
    needsMoreInfo: false,
    summary: 'PR never revokes sessions on soft-delete',
    reason: 'missing_logic' as any,
    confidence: 'high',
};

describe('BusinessRulesVerifier.verify', () => {
    const ctx = { runId: 'x', signal: new AbortController().signal } as any;

    it('returns keep=false when the verifier refutes the claim', async () => {
        const runner = { run: jest.fn(async () => runStateWithVerdict(false, 'diff covers it')) };
        const verifier = new BusinessRulesVerifier(runner as any, {
            modelId: 'resolved',
            diff: '+ revokeSessions(userId)',
            taskContext: 'on soft-delete, revoke sessions',
        });
        const verdict = await verifier.verify(claim, ctx);
        expect(verdict.keep).toBe(false);
        expect(verdict.rationale).toContain('covers');
    });

    it('passes the diff, task, and analyzer claim into the verify prompt', async () => {
        const runner = { run: jest.fn(async () => runStateWithVerdict(true)) };
        const verifier = new BusinessRulesVerifier(runner as any, {
            modelId: 'resolved',
            diff: 'DIFF_MARKER',
            taskContext: 'TASK_MARKER',
        });
        await verifier.verify(claim, ctx);
        const prompt = runner.run.mock.calls[0][1].prompt as string;
        expect(prompt).toContain('DIFF_MARKER');
        expect(prompt).toContain('TASK_MARKER');
        expect(prompt).toContain('PR never revokes sessions'); // the claim summary
    });

    it('instructs the rationale to be written in the configured language', async () => {
        const runner = { run: jest.fn(async () => runStateWithVerdict(true)) };
        const verifier = new BusinessRulesVerifier(runner as any, {
            modelId: 'resolved',
            diff: 'd',
            taskContext: 't',
            userLanguage: 'pt-BR',
        });
        await verifier.verify(claim, ctx);
        expect(runner.run.mock.calls[0][0].systemPrompt).toContain('pt-BR');
    });

    it('fails open (keep=true) when the run produces no verdict', async () => {
        const emptyState = { ...runStateWithVerdict(true), artifacts: [] } as RunState;
        const runner = { run: jest.fn(async () => emptyState) };
        const verifier = new BusinessRulesVerifier(runner as any, {
            modelId: 'resolved',
            diff: 'd',
            taskContext: 't',
        });
        const verdict = await verifier.verify(claim, ctx);
        expect(verdict.keep).toBe(true);
    });
});

describe('shouldVerifyValidationResult (opt-in gate)', () => {
    const ready: ValidationResult = {
        needsMoreInfo: false,
        summary: 's',
        reason: 'analysis_ready' as any,
    };

    it('is false when the flag is off (default)', () => {
        expect(shouldVerifyValidationResult(ready, {})).toBe(false);
        expect(
            shouldVerifyValidationResult(ready, { verifyAnalyzerResult: false }),
        ).toBe(false);
    });

    it('is true for a completed analysis when opted in', () => {
        expect(
            shouldVerifyValidationResult(ready, { verifyAnalyzerResult: true }),
        ).toBe(true);
    });

    it('skips gating/failure states (needsMoreInfo or non-analysis_ready)', () => {
        const policy = { verifyAnalyzerResult: true };
        expect(
            shouldVerifyValidationResult(
                { ...ready, needsMoreInfo: true },
                policy,
            ),
        ).toBe(false);
        expect(
            shouldVerifyValidationResult(
                { ...ready, reason: 'parser_fallback' as any },
                policy,
            ),
        ).toBe(false);
        expect(
            shouldVerifyValidationResult(
                { ...ready, reason: 'task_context_missing' as any },
                policy,
            ),
        ).toBe(false);
    });
});

describe('applyBusinessRulesVerdict (refute-to-drop)', () => {
    it('leaves the result untouched when keep=true', () => {
        const out = applyBusinessRulesVerdict(claim, { keep: true });
        expect(out).toEqual(claim);
    });

    it('drops the violation when refuted (keep=false): clears reason, marks verified', () => {
        const out = applyBusinessRulesVerdict(claim, {
            keep: false,
            rationale: 'diff implements it',
            confidence: 'medium',
        });
        expect(out.reason).toBeUndefined();
        expect(out.needsMoreInfo).toBe(false);
        expect(out.confidence).toBe('medium');
        // Summary = the verifier's rationale verbatim (written in the configured
        // language), NOT an English prefix that would mix languages.
        expect(out.summary).toBe('diff implements it');
    });

    it('falls back to the original summary when the verdict has no rationale', () => {
        const out = applyBusinessRulesVerdict(claim, { keep: false });
        expect(out.summary).toBe(claim.summary);
    });
});
