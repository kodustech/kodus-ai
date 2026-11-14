import { EnvironmentRuntime, isEnvError } from '@libs/runtime/environment';
import type { EvidenceRef } from '@libs/runtime/probe';

import type { PlannedTest } from '../agent/runtime-agent';
import { Canary, CanaryLeakError, containsCanary } from '../canary/canary';
import { checkClaimLease, type ClaimLeaseFailed, throwClaimLeaseFailure } from '../env/claim-liveness';
import type { StepRunner } from '../run/ports';
import { checkUploadedRefs, evidenceRequestOf, type RunEvidence } from '../run/run-evidence';
import { isSecurityViolation, SecurityViolationError } from '../run/security-violation';
import { stableStepId } from '../run/step-id';

// The repository tests the agent named, run inside the VM on base and PR
// (exit 0 = pass). They are internal evidence (ADR-053): they never decide a
// verdict, they only feed the intent classifier, which can only downgrade.

export type TestOutcome = 'pass' | 'fail' | 'not_run';

export interface TestRun {
    testId: string;
    path: string;
    entryPoint: string;
    base: TestOutcome;
    pr: TestOutcome;
    /** Each side's exec step: its cast, when the cell recorded one, is at {orgId}/{runId}/{side}/{stepId}/cast. */
    stepIds?: { base: string; pr: string };
    /** The casts the cells uploaded and the worker read back (ADR-043), by side; absent: not recorded. */
    casts?: Partial<Record<'base' | 'pr', EvidenceRef>>;
}

export const TEST_TIMEOUT_MS = 300_000;

export async function runPlannedTests(args: {
    run: { runId: string; attempt: number };
    tests: PlannedTest[];
    claims: { base: string; pr: string };
    env: EnvironmentRuntime;
    /** The concrete image shared by the Run's acquired claims. */
    pinnedImageId?: string;
    step: StepRunner;
    securityOf?: (claimId: string) => Promise<string | undefined>;
    /** The Run's canaries: one in a test's output stops the Run (ADR-043). */
    canaries?: Canary[];
    /**
     * Where the cell uploads each test's output as a cast (execCast), with one
     * grant per step. Absent: nothing is recorded.
     */
    evidence?: RunEvidence;
}): Promise<TestRun[]> {
    const { run, env, step } = args;
    const out: TestRun[] = [];
    for (const [i, t] of args.tests.entries()) {
        const stepIds = { base: stableStepId(run.runId, run.attempt, `test:${i}:${t.id}:base`), pr: stableStepId(run.runId, run.attempt, `test:${i}:${t.id}:pr`) };
        const casts: Partial<Record<'base' | 'pr', EvidenceRef>> = {};
        const side = async (s: 'base' | 'pr'): Promise<TestOutcome> => {
            const name = `test:${i}:${t.id}:${s}`;
            const stepId = stepIds[s];
            // Only the outcome (and the cast's ref) is checkpointed; the output never leaves the step.
            const r = await step(name, async (): Promise<ClaimLeaseFailed | { outcome: TestOutcome; leaked: boolean; violation?: string; cast?: EvidenceRef }> => {
                const claimFailure = await checkClaimLease(env, args.claims[s], 'runtime', { side: s, securityOf: args.securityOf });
                if (claimFailure) return { claimFailure };
                // Same start state on both sides, like a probe round.
                const reset = await env.reset(args.claims[s], args.pinnedImageId);
                if (isSecurityViolation(reset)) return { outcome: 'not_run', leaked: false, violation: reset.signature };
                if (reset && 'code' in reset) return { outcome: 'not_run', leaked: false };
                // The grant is signed right before the exec, so it lives the test's timeout and not the reset's.
                const at = { runId: run.runId, side: s, stepId };
                const evidence = args.evidence ? evidenceRequestOf(args.evidence, at, ['cast'], TEST_TIMEOUT_MS) : undefined;
                const res = await env.exec(args.claims[s], { stepId, command: t.command, timeoutMs: TEST_TIMEOUT_MS, ...(evidence ? { evidence } : {}) });
                if (isSecurityViolation(res)) return { outcome: 'not_run', leaked: false, violation: res.signature };
                if (isEnvError(res)) return { outcome: 'not_run', leaked: false };
                let leaked = !!args.canaries?.length && containsCanary(`${res.stdout}\n${res.stderr}`, args.canaries);
                // The cast is read back for canaries before anyone can open it, as a probe round's artifacts are.
                const checked = await checkUploadedRefs(args.evidence, at, res.refs, args.canaries);
                leaked ||= checked.leaked;
                const cast = checked.refs.find((ref) => ref.type === 'cast');
                if (res.transport !== 'ok') return { outcome: 'not_run', leaked, ...(cast ? { cast } : {}) };
                return { outcome: res.exitCode === 0 ? 'pass' : 'fail', leaked, ...(cast ? { cast } : {}) };
            });
            if ('claimFailure' in r) throwClaimLeaseFailure(r.claimFailure);
            if (r.cast) casts[s] = r.cast;
            if (r.violation) throw new SecurityViolationError(s, r.violation);
            if (r.leaked) throw new CanaryLeakError('exec_output');
            return r.outcome;
        };
        const base = await side('base');
        const pr = await side('pr');
        out.push({ testId: t.id, path: t.path, entryPoint: t.entryPoint, base, pr, stepIds, ...(casts.base || casts.pr ? { casts } : {}) });
    }
    return out;
}
