/**
 * CompletionGatePolicy unit tests — ZERO LLM, fully deterministic.
 *
 * This is the whole point of the new architecture: the H-STOP logic that
 * previously could only be tested by running a full (noisy, ±6 goldens)
 * benchmark is now a pure function over (StepView, ProgressLedger). We assert
 * the gate behavior directly, in milliseconds.
 */
import type {
    ProgressLedger,
    ProgressSummary,
} from '../../domain/contracts/progress.contract';
import type { StepView } from '../../domain/contracts/policy.contract';
import type { RunStep } from '../../domain/contracts/run-state.contract';
import { CompletionGatePolicy } from './completion-gate.policy';

const DONE = 'submitResult';

function fakeLedger(
    summary: ProgressSummary,
    debt: string | null = null,
): ProgressLedger & { marked: Array<[string, unknown]> } {
    const marked: Array<[string, unknown]> = [];
    return {
        marked,
        markFromToolCall: (name, input) => marked.push([name, input]),
        summary: () => summary,
        debtNote: () => debt,
    };
}

function viewWithLastTool(toolName: string | null): StepView {
    const steps: RunStep[] = [
        {
            index: 0,
            message: {
                role: 'assistant',
                content: '',
                toolCalls: toolName
                    ? [{ id: '1', name: toolName, input: {} }]
                    : [],
            },
        },
    ];
    return {
        runId: 'r',
        agentId: 'finder',
        stepNumber: 1,
        maxSteps: 20,
        steps,
        messages: [],
        activeTools: [],
    };
}

const summary = (criticalTotal: number, criticalPending: number): ProgressSummary => ({
    totalTargets: 10,
    pendingTargets: criticalPending,
    criticalTotal,
    criticalPending,
});

describe('CompletionGatePolicy (H-STOP as a policy)', () => {
    it('honors done when no critical hunk is pending', () => {
        const p = new CompletionGatePolicy(fakeLedger(summary(3, 0)), {
            doneToolName: DONE,
        });
        expect(p.shouldStop(viewWithLastTool(DONE))).toBe(true);
    });

    it('VETOES done while a critical hunk is still pending', () => {
        const p = new CompletionGatePolicy(fakeLedger(summary(3, 2)), {
            doneToolName: DONE,
        });
        expect(p.shouldStop(viewWithLastTool(DONE))).toBe(false);
    });

    it('does not gate steps where done was not called', () => {
        const p = new CompletionGatePolicy(fakeLedger(summary(3, 2)), {
            doneToolName: DONE,
        });
        expect(p.shouldStop(viewWithLastTool('readFile'))).toBe(false);
    });

    it('#5-safe: never requires 100% — honors done when no critical tier exists', () => {
        // criticalTotal=0 means tiering inactive; must NOT block on pending.
        const p = new CompletionGatePolicy(fakeLedger(summary(0, 0)), {
            doneToolName: DONE,
        });
        expect(p.shouldStop(viewWithLastTool(DONE))).toBe(true);
    });

    it('injects progress debt note when debt exists, with trace event', () => {
        const p = new CompletionGatePolicy(
            fakeLedger(summary(3, 2), 'UNCOVERED: foo.ts:119'),
            { doneToolName: DONE },
        );
        const d = p.prepareStep(viewWithLastTool(null));
        expect(d.injectNote?.content).toContain('UNCOVERED: foo.ts:119');
        expect(d.emit?.[0].kind).toBe('progress.debt');
        expect(d.emit?.[0].detail?.criticalPending).toBe(2);
    });

    it('injects nothing when there is no debt', () => {
        const p = new CompletionGatePolicy(fakeLedger(summary(3, 0), null), {
            doneToolName: DONE,
        });
        expect(p.prepareStep(viewWithLastTool(null))).toEqual({});
    });

    it('marks coverage from the last step tool calls', () => {
        const ledger = fakeLedger(summary(3, 1));
        const p = new CompletionGatePolicy(ledger, { doneToolName: DONE });
        p.onStepFinish(viewWithLastTool('readFile'));
        expect(ledger.marked).toEqual([['readFile', {}]]);
    });
});
