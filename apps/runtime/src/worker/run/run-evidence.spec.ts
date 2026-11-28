import type { StepResult } from '@libs/runtime/environment';

import { HmacCanaryVault } from '../canary/canary';
import { boundedText, envErrorEvidence, EXPLORED_COMMAND_MAX, EXPLORED_OUTPUT_MAX, explorationEvidence, exploredCommand } from './run-evidence';
import { ESTIMATE_RUNS, median, phaseEstimates } from './run-estimates';

const STEP = '7d0f3c1e-5b8a-4c2e-9f1d-2a3b4c5d6e7f';
const ok = (patch: Partial<StepResult> = {}): StepResult => ({ stepId: STEP, exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 7, transport: 'ok', ...patch });
const [canary] = new HmacCanaryVault('test-key').forRun({ runId: 'r1', runToken: 't1' });

describe('exploration evidence', () => {
    it('redacts token patterns and the Run canaries from what the machine printed, then bounds it', () => {
        const out = boundedText(`token ghp_EXAMPLE0EXAMPLE0EXAMPLE0EXAMPLE0EXAM\nnpm ${canary.value}\n${'x'.repeat(100)}`, 60, [canary]);
        expect(out.text).not.toContain('ghp_');
        expect(out.text).not.toContain(canary.core);
        expect(out.text).toContain('[redacted:github-pat]');
        expect(out.text.length).toBe(60);
        expect(out).toMatchObject({ truncated: true, redactions: 1 });
    });

    it('keeps exit, duration and both streams of a command that ran', () => {
        const body = explorationEvidence(2, STEP, 'ls /grafana', ok({ exitCode: 127, stderr: 'sh: ls: not found', redactions: 1 }));
        expect(body).toEqual({
            kind: 'exploration',
            index: 2,
            stepId: STEP,
            command: 'ls /grafana',
            exitCode: 127,
            durationMs: 7,
            stdout: '',
            stderr: 'sh: ls: not found',
            truncated: false,
            redactions: 1,
        });
    });

    it('a long output is cut at the bound and says so', () => {
        const body = explorationEvidence(0, STEP, 'cat big', ok({ stdout: 'y'.repeat(EXPLORED_OUTPUT_MAX + 10) })) as { stdout: string; truncated: boolean };
        expect(body.stdout.length).toBe(EXPLORED_OUTPUT_MAX);
        expect(body.truncated).toBe(true);
    });

    it('a command that never ran says why, without internal ids', () => {
        expect(explorationEvidence(0, STEP, 'id', { code: 'cell_unavailable', cellId: 'cell-7' })).toEqual({
            kind: 'exploration',
            index: 0,
            stepId: STEP,
            command: 'id',
            error: { code: 'cell_unavailable', reason: 'the cell that holds the machine was not connected' },
        });
    });

    it('the Run lists a command with how it ended, never its output', () => {
        expect(exploredCommand(0, STEP, 'cat x', ok({ stdout: 'secret source' }))).toEqual({ index: 0, stepId: STEP, command: 'cat x', exitCode: 0, durationMs: 7, failed: false });
        expect(exploredCommand(1, STEP, 'cat x', ok({ transport: 'lost' })).failed).toBe(true);
        expect(exploredCommand(2, STEP, 'cat x', { code: 'lease_expired' })).toEqual({ index: 2, stepId: STEP, command: 'cat x', error: 'lease_expired', failed: true });
        expect(exploredCommand(3, STEP, `echo ${canary.value} ${'z'.repeat(400)}`, ok(), [canary]).command).toMatch(/^echo \[redacted\] z+$/);
        expect(exploredCommand(3, STEP, 'z'.repeat(400), ok()).command.length).toBe(EXPLORED_COMMAND_MAX);
    });

    it('every environment error has a reason', () => {
        expect(envErrorEvidence({ code: 'transport_lost', stepId: STEP }).reason).toMatch(/connection/);
        expect(envErrorEvidence({ code: 'security_violation', claimId: 'c', signature: 's' })).toEqual({ code: 'security_violation', reason: expect.stringMatching(/exfiltrate/) });
    });
});

describe('phase estimates', () => {
    const run = (runId: string, environmentId: string, phaseMs?: { boot: number; apply: number }) =>
        ({ runId, organizationId: 'o', environmentId, ...(phaseMs ? { phaseMs } : {}) }) as any;

    it('is the median, rounded', () => {
        expect(median([])).toBeUndefined();
        expect(median([3, 1, 2])).toBe(2);
        expect(median([1, 2])).toBe(2);
        expect(median([10, 20, 30, 41])).toBe(25);
    });

    it("reads the environment's last Runs that booted both sides, never this Run", async () => {
        const list = jest.fn(async () => [
            run('this', 'env', { boot: 1, apply: 1 }),
            run('no-boot', 'env'),
            ...[10, 20, 30, 40, 50, 60].map((n) => run(`r${n}`, 'env', { boot: n * 1_000, apply: n * 10_000 })),
        ]);
        const got = await phaseEstimates({ list }, { runId: 'this', organizationId: 'o', environmentId: 'env' });
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'o', environmentId: 'env' }));
        // The newest ESTIMATE_RUNS of them: 10..50, not 60.
        expect(ESTIMATE_RUNS).toBe(5);
        expect(got).toEqual({ bootMs: 30_000, applyMs: 300_000 });
    });

    it('none without an earlier Run, and none from another org or environment', async () => {
        expect(await phaseEstimates({ list: async () => [] }, { runId: 'x', organizationId: 'o', environmentId: 'env' })).toBeUndefined();
        const others = [{ ...run('a', 'other', { boot: 5, apply: 5 }) }, { ...run('b', 'env', { boot: 5, apply: 5 }), organizationId: 'o2' }];
        expect(await phaseEstimates({ list: async () => others }, { runId: 'x', organizationId: 'o', environmentId: 'env' })).toBeUndefined();
    });

    it('stays inside the progress schema', async () => {
        const got = await phaseEstimates({ list: async () => [run('a', 'env', { boot: 1e12, apply: -5 })] }, { runId: 'x', organizationId: 'o', environmentId: 'env' });
        expect(got).toEqual({ bootMs: 86_400_000 });
    });
});
