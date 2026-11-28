import { RunPlanRequestSchema, type RunPlanRequest, type RunPlanResponse } from '@libs/runtime/contracts/run-plan';

import { CanaryLeakError, HmacCanaryVault } from '../canary/canary';
import { stableStepId } from '../run/step-id';
import { CanaryGuardedRunPlanClient, HttpRunPlanClient, type RunPlanCall, type RunPlanClient } from './http-run-plan';
import { LlmBudgetExceededError, type LlmGateway } from './llm-gateway';
import { changedPathsOf, noPlanReason, RuntimeAgent, spentTokensOf } from './runtime-agent';

// The worker's side of the test planner on the harness (ADR-069): it drives
// the product's rounds inside the one agent:plan step, runs the commands the
// planner asks for on the base claim with stable step ids, and checks the
// plan it receives again.

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const usage = { inputTokens: 10, outputTokens: 2 };

const probe = (over: Record<string, unknown> = {}) => ({
    id: 'health',
    purpose: 'the health check reports the branch',
    expected: '200 without a branch field',
    compare: ['status', 'json'],
    spec: { kind: 'http', target: { service: 'grafana', port: 3000 }, method: 'GET', path: '/api/health', timeoutMs: 30_000 },
    ...over,
});

const input = {
    runId: RUN_ID,
    attempt: 1,
    organizationId: 'o',
    runToken: 'sealed-token',
    entryPoints: [{ id: 'unmapped:pkg/api/health.go', kind: 'unmapped' as const, match: { file: 'pkg/api/health.go' } }],
    diffSummary: '--- pkg/api/health.go\n@@ -1 +1,2 @@\n+\tdata.Set("branch", hs.Cfg.BuildBranch)',
    files: [{ path: 'pkg/api/health.go', content: 'package api' }],
    baseClaimId: 'base',
    targets: [{ service: 'grafana', port: 3000, kind: 'http' }],
};

const noLlm: LlmGateway = { complete: async () => Promise.reject(new Error('the 2-turn loop must not run')) };

function planner(answers: RunPlanResponse[]) {
    const calls: RunPlanCall[] = [];
    const client: RunPlanClient = {
        plan: async (call) => {
            calls.push(JSON.parse(JSON.stringify(call)));
            const a = answers.shift();
            if (!a) throw new Error('no more rounds scripted');
            return a;
        },
    };
    return { client, calls };
}

/** What base answers to a probe sent before the replay (the reconnaissance pass): a JSON 200 by default. */
type Answer = { status: number; contentType?: string; body: string };
function env(stdout = 'bin\nconf\npublic', answer: (path: string) => Answer = () => ({ status: 200, contentType: 'application/json', body: '{"ok":true}' })) {
    const execs: { claimId: string; stepId: string; command: string }[] = [];
    const probes: { claimId: string; stepId: string; path: string }[] = [];
    return {
        execs,
        probes,
        probe: async (claimId: string, p: any, stepId: string) => {
            probes.push({ claimId, stepId, path: p.spec.path });
            const a = answer(p.spec.path);
            return { stepId, executor: 'observer', imageId: 'img', transport: 'ok', vmHealth: 'ok', http: { status: a.status, headers: a.contentType ? { 'Content-Type': a.contentType } : {}, body: a.body } };
        },
        exec: async (claimId: string, req: { stepId: string; command: string }) => {
            execs.push({ claimId, stepId: req.stepId, command: req.command });
            return { stepId: req.stepId, exitCode: 0, stdout, stderr: '', durationMs: 5, transport: 'ok' };
        },
    } as any;
}

describe('RuntimeAgent on the product planner', () => {
    it('explores only the capable base claim, shares the round budget and returns redacted browser data to the planner', async () => {
        const request = { steps: [{ goto: '/' }, { click: '#cart' }], viewport: { width: 1280, height: 720 }, timeoutMs: 30000 };
        const result = { status: 'observed', snapshot: 'button ghp_abcdefghijklmnopqrstuvwxyz0123456789', candidates: [{ ref: 'e1', selector: '#cart' }], actionsCompleted: 2, durationMs: 3, cliCalls: 4, truncated: false };
        const p = planner([
            { status: 'explore_browser', request, usage, steps: 1 } as any,
            { status: 'explore', commands: ['ls'], usage, steps: 1 },
            { status: 'no_plan', reason: 'done', rejected: [], usage, steps: 1 },
        ]);
        const e = env(); e.exploreBrowser = jest.fn(async () => result);
        const plan = await new RuntimeAgent(noLlm, e, p.client).plan({ ...input, baseCapabilities: { browserExplore: 'v1' } } as any);
        expect(e.exploreBrowser).toHaveBeenCalledWith('base', request, stableStepId(RUN_ID, 1, 'agent:plan:browser-explore:0'));
        expect(p.calls[0].body).toMatchObject({ browserExploration: { v: 1, left: 2 } });
        expect(p.calls[1].body).toMatchObject({ browserExploration: { v: 1, left: 1 }, browserObservations: [{ request, result: { snapshot: expect.not.stringContaining('ghp_') } }] });
        expect(p.calls[2].body).toMatchObject({ browserExploration: { v: 1, left: 0 } });
        expect(plan.probes).toEqual([]);
        expect(plan.browserExploration).toEqual([{ status: 'observed', durationMs: 3, cliCalls: 4, actionsCompleted: 2 }]);
        expect(JSON.stringify(plan)).not.toContain('snapshot');
    });

    it('does not infer browser capability from a method or execute an unsolicited browser request', async () => {
        const p = planner([{ status: 'explore_browser', request: { steps: [{ goto: '/' }], viewport: { width: 800, height: 600 }, timeoutMs: 1000 }, usage, steps: 1 } as any]);
        const e = env(); e.exploreBrowser = jest.fn();
        const plan = await new RuntimeAgent(noLlm, e, p.client).plan(input);
        expect(p.calls[0].body).not.toHaveProperty('browserExploration');
        expect(e.exploreBrowser).not.toHaveBeenCalled();
        expect(plan.rejected.length).toBeGreaterThan(0);
    });

    // Behavior: a plan that fails after a round answered still reports what that round spent, so the Run's tokens are not under-counted.
    it('carries the tokens of the rounds that answered on the error of a later round that fails', async () => {
        const answers: RunPlanResponse[] = [{ status: 'explore', commands: ['ls /'], usage: { inputTokens: 40_000, outputTokens: 5_000 }, steps: 3 } as any];
        const client: RunPlanClient = {
            plan: async () => {
                const a = answers.shift();
                if (!a) throw new Error('the second round failed');
                return a;
            },
        };
        const failure = await new RuntimeAgent(noLlm, env(), client).plan(input).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(failure).toBeInstanceOf(Error);
        expect(spentTokensOf(failure)).toEqual({ inputTokens: 40_000, outputTokens: 5_000 });
    });

    it('checks canaries before retaining browser results even without an evidence store', async () => {
        const vault = new HmacCanaryVault(Buffer.alloc(32, 1));
        const canaries = vault.forRun(input);
        const request = { steps: [{ goto: '/' }], viewport: { width: 800, height: 600 }, timeoutMs: 1000 };
        const p = planner([{ status: 'explore_browser', request, usage, steps: 1 } as any]);
        const e = env(); e.exploreBrowser = async () => ({ status: 'observed', snapshot: canaries[0].value, candidates: [], actionsCompleted: 1, durationMs: 1, cliCalls: 1, truncated: false });
        await expect(new RuntimeAgent(noLlm, e, p.client).plan({ ...input, baseCapabilities: { browserExplore: 'v1' }, canaries } as any)).rejects.toBeInstanceOf(CanaryLeakError);
        expect(p.calls).toHaveLength(1);
    });

    it('checks the complete browser request as well as the result for canaries', async () => {
        const canaries = new HmacCanaryVault().forRun(input);
        const request = { steps: [{ goto: '/' }, { fill: ['#input', canaries[0].value] }], viewport: { width: 800, height: 600 }, timeoutMs: 1000 };
        const p = planner([{ status: 'explore_browser', request, usage, steps: 1 } as any]);
        const e = env(); e.exploreBrowser = jest.fn(async () => ({ status: 'observed', snapshot: '', candidates: [], actionsCompleted: 2, durationMs: 1, cliCalls: 2, truncated: false }));
        await expect(new RuntimeAgent(noLlm, e, p.client).plan({ ...input, baseCapabilities: { browserExplore: 'v1' }, canaries } as any)).rejects.toBeInstanceOf(CanaryLeakError);
        expect(e.exploreBrowser).not.toHaveBeenCalled();
    });

    it('does not execute a third exploration job and maps a lost first job to unavailable without retry', async () => {
        const request = { steps: [{ goto: '/' }], viewport: { width: 800, height: 600 }, timeoutMs: 1000 };
        const p = planner(Array.from({ length: 3 }, () => ({ status: 'explore_browser', request, usage, steps: 1 } as any)));
        const e = env(); e.exploreBrowser = jest.fn(async () => ({ code: 'transport_lost', stepId: 'lost' }));
        const plan = await new RuntimeAgent(noLlm, e, p.client).plan({ ...input, baseCapabilities: { browserExplore: 'v1' } } as any);
        expect(e.exploreBrowser).toHaveBeenCalledTimes(2);
        expect(p.calls[1].body).toMatchObject({ browserObservations: [{ result: { status: 'unavailable' } }] });
        expect(plan.probes).toEqual([]);
        expect(plan.rejected[0].reason).toContain('exhausted');
    });

    it('bounds snapshot and metadata again after redaction and discards candidates whose selector identity changed', async () => {
        const key = 'AKIAIOSFODNN7EXAMPLE';
        const request = { steps: [{ goto: '/' }], viewport: { width: 800, height: 600 }, timeoutMs: 1000 };
        const result = { status: 'observed', snapshot: `${key} `.repeat(380), candidates: [{ ref: 'e1', selector: `[data-key="${key}"]` }, { ref: 'e2', selector: '#safe', name: `${key} `.repeat(12).trim() }], actionsCompleted: 1, durationMs: 1, cliCalls: 2, truncated: false };
        const p = planner([{ status: 'explore_browser', request, usage, steps: 1 } as any, { status: 'no_plan', reason: 'done', rejected: [], usage, steps: 1 }]);
        const e = env(); e.exploreBrowser = async () => result;
        await new RuntimeAgent(noLlm, e, p.client).plan({ ...input, baseCapabilities: { browserExplore: 'v1' } } as any);
        expect(RunPlanRequestSchema.safeParse(p.calls[1].body).success).toBe(true);
        const observation = p.calls[1].body.browserObservations![0];
        expect(observation.result.snapshot.length).toBe(8000);
        expect(observation.result.truncated).toBe(true);
        expect(observation.result.candidates).toEqual([{ ref: 'e2', selector: '#safe', name: expect.any(String) }]);
        expect(observation.result.candidates[0].name!.length).toBeLessThanOrEqual(256);
        expect(JSON.stringify(observation)).not.toContain(key);
    });

    it('passes the page content to the planner, bounded again after redaction under its own truncation flag', async () => {
        const key = 'AKIAIOSFODNN7EXAMPLE';
        const request = { steps: [{ goto: '/' }], viewport: { width: 800, height: 600 }, timeoutMs: 1000 };
        const result = { status: 'observed', snapshot: '- button "Place order" [ref=e1]', candidates: [], content: { text: `Order for widget placed ${`${key} `.repeat(379)}`, truncated: false }, actionsCompleted: 1, durationMs: 1, cliCalls: 2, truncated: false };
        const p = planner([{ status: 'explore_browser', request, usage, steps: 1 } as any, { status: 'no_plan', reason: 'done', rejected: [], usage, steps: 1 }]);
        const e = env(); e.exploreBrowser = async () => result;
        await new RuntimeAgent(noLlm, e, p.client).plan({ ...input, baseCapabilities: { browserExplore: 'v1' } } as any);
        expect(RunPlanRequestSchema.safeParse(p.calls[1].body).success).toBe(true);
        const observation = p.calls[1].body.browserObservations![0];
        expect(observation.result.content!.text).toContain('Order for widget placed');
        expect(observation.result.content!.text.length).toBe(8000);
        expect(observation.result.content!.truncated).toBe(true);
        expect(observation.result.truncated).toBe(false);
        expect(JSON.stringify(observation)).not.toContain(key);
    });

    it('withholds a changed request after redaction without storing original input or inventing a replacement prefix', async () => {
        const key = 'AKIAIOSFODNN7EXAMPLE';
        const fill = `${key} `.repeat(390) + 'xx';
        expect(fill).toHaveLength(8192);
        const request = { steps: [{ goto: '/' }, { fill: ['#input', fill] }], viewport: { width: 800, height: 600 }, timeoutMs: 1000 };
        const p = planner([{ status: 'explore_browser', request, notes: 'untrusted previous notes', usage, steps: 1 } as any, { status: 'no_plan', reason: 'done', rejected: [], usage, steps: 1 }]);
        const e = env(); e.exploreBrowser = async () => ({ status: 'observed', snapshot: 'done', candidates: [], actionsCompleted: 2, durationMs: 1, cliCalls: 2, truncated: false });
        const plan = await new RuntimeAgent(noLlm, e, p.client).plan({ ...input, baseCapabilities: { browserExplore: 'v1' } } as any);
        const next = p.calls[1].body;
        expect(RunPlanRequestSchema.safeParse(next).success).toBe(true);
        expect(next.browserObservations).toEqual([]);
        expect(next.notes).toBe('browser observation withheld after redaction');
        expect(next.browserExploration).toEqual({ v: 1, left: 1 });
        expect(plan.browserExploration).toEqual([{ status: 'observed', durationMs: 1, cliCalls: 2, actionsCompleted: 2 }]);
        expect(JSON.stringify(next)).not.toContain(key);
    });

    it('returns a durable security marker immediately when browser exploration reports compromise, without another planner call', async () => {
        const request = { steps: [{ goto: '/' }], viewport: { width: 800, height: 600 }, timeoutMs: 1000 };
        const p = planner([{ status: 'explore_browser', request, usage, steps: 1 } as any, { status: 'no_plan', reason: 'should not reach this', rejected: [], usage, steps: 1 }]);
        const e = env(); e.exploreBrowser = jest.fn(async () => ({ code: 'security_violation', claimId: 'base', signature: 'credential_exfiltration' }));
        const plan = await new RuntimeAgent(noLlm, e, p.client).plan({ ...input, baseCapabilities: { browserExplore: 'v1' } } as any);
        expect(p.calls).toHaveLength(1);
        expect(JSON.parse(JSON.stringify(plan))).toMatchObject({ probes: [], securityViolation: { side: 'base', signature: 'credential_exfiltration' } });
        expect(e.exploreBrowser).toHaveBeenCalledTimes(1);
    });

    it('runs the commands a round asks for on the base claim, with stable step ids, and returns the checked plan', async () => {
        const p = planner([
            { status: 'explore', commands: ['ls /usr/share/grafana'], notes: 'route in pkg/api/api.go', usage, steps: 3 },
            {
                status: 'planned',
                plan: { probes: [{ entryPoint: 'GET /api/health', via: 'pkg/api/health.go', probe: probe() }], tests: [], claims: [], cannotProve: [] },
                rejected: [],
                usage,
                steps: 2,
            },
        ]);
        const e = env();
        const plan = await new RuntimeAgent(noLlm, e, p.client).plan(input);

        expect(e.execs).toEqual([{ claimId: 'base', stepId: stableStepId(RUN_ID, 1, 'agent:plan:explore:0'), command: 'ls /usr/share/grafana' }]);
        const second = p.calls[1].body as RunPlanRequest;
        expect(second).toMatchObject({ round: 1, execLeft: 4, notes: 'route in pkg/api/api.go', observations: [{ command: 'ls /usr/share/grafana', exitCode: 0, stdout: 'bin\nconf\npublic' }] });
        expect(second.changedPaths).toEqual(['pkg/api/health.go']);
        expect(plan.probes.map((x) => [x.entryPoint, x.via])).toEqual([['GET /api/health', 'pkg/api/health.go']]);
        expect(plan).toMatchObject({ explored: 1, rejected: [], usage: { inputTokens: 20, outputTokens: 4 } });
        expect(plan.exploration?.[0]).toMatchObject({ index: 0, command: 'ls /usr/share/grafana' });
    });

    it('numbers the commands of a later round after the earlier ones', async () => {
        const p = planner([
            { status: 'explore', commands: ['a', 'b'], usage, steps: 1 },
            { status: 'explore', commands: ['c', 'd', 'e', 'f'], usage, steps: 1 },
            { status: 'no_plan', reason: 'the step budget ran out', rejected: [], usage, steps: 20 },
        ]);
        const e = env();
        await new RuntimeAgent(noLlm, e, p.client).plan(input);
        // Five commands at most over the whole plan: the second round gets three.
        expect(e.execs.map((x: any) => x.stepId)).toEqual([0, 1, 2, 3, 4].map((i) => stableStepId(RUN_ID, 1, `agent:plan:explore:${i}`)));
        expect((p.calls[2].body as RunPlanRequest).execLeft).toBe(0);
    });

    it('records a plan that never came as a rejected reason, never as nothing to test', async () => {
        const p = planner([{ status: 'no_plan', reason: 'the step budget ran out', rejected: [], usage, steps: 20 }]);
        const plan = await new RuntimeAgent(noLlm, env(), p.client).plan(input);
        expect(plan.probes).toEqual([]);
        expect(plan.rejected[0].reason).toBe(noPlanReason('the step budget ran out'));
    });

    it('checks the plan again: a probe the checks refuse never reaches replay', async () => {
        const p = planner([
            {
                status: 'planned',
                plan: {
                    probes: [
                        { entryPoint: 'GET /api/health', via: 'pkg/api/health.go', probe: probe({ id: 'sh', spec: { kind: 'shell', command: 'true', timeoutMs: 30_000 } }) },
                        { entryPoint: 'GET /api/health', via: 'pkg/api/health.go', probe: probe() },
                    ],
                    tests: [],
                    claims: [],
                    cannotProve: [],
                },
                rejected: [],
                usage,
                steps: 1,
            },
        ]);
        const plan = await new RuntimeAgent(noLlm, env(), p.client).plan(input);
        expect(plan.probes.map((x) => x.probe.id)).toEqual(['health']);
        expect(plan.rejected.map((r) => r.reason)).toEqual(['probe sh: shell is internal evidence and cannot decide']);
    });

    it('refuses to send a round whose command output carries a canary (ADR-043)', async () => {
        const vault = new HmacCanaryVault(Buffer.alloc(32, 1));
        const canary = vault.forRun({ runId: RUN_ID, runToken: input.runToken })[1].value;
        const p = planner([{ status: 'explore', commands: ['cat /etc/app.ini'], usage, steps: 1 }]);
        const agent = new RuntimeAgent(noLlm, env(`token=${canary}`), new CanaryGuardedRunPlanClient(p.client, vault));
        await expect(agent.plan(input)).rejects.toBeInstanceOf(CanaryLeakError);
        expect(p.calls).toHaveLength(1);
    });

    it('reads the changed paths from the files, the entry points and the diff headers', () => {
        expect(
            changedPathsOf({
                files: [{ path: 'a.go', content: '' }],
                entryPoints: [{ id: 'unmapped:b.go', kind: 'unmapped', match: { file: 'b.go' } }],
                diffSummary: '--- c.go\n@@\n--- a/old.go\n--- .kodus-runtime/diff-truncated\n',
            }),
        ).toEqual(['a.go', 'b.go', 'c.go']);
    });
});

describe('HttpRunPlanClient', () => {
    const secrets = { open: (sealed: string) => `plain-${sealed}` };
    const call: RunPlanCall = { runId: RUN_ID, organizationId: 'o', runToken: 's', body: { runId: RUN_ID } as any };

    it('posts with the opened Run token and reads the wrapped answer', async () => {
        const seen: any[] = [];
        const fetch = async (url: string, init: any) => {
            seen.push({ url, init });
            return { status: 200, ok: true, json: async () => ({ statusCode: 200, type: 'ok', data: { status: 'no_plan', reason: 'x', rejected: [], usage, steps: 1 } }) };
        };
        const out = await new HttpRunPlanClient('http://api.test/', { secrets, fetch }).plan(call);
        expect(out.status).toBe('no_plan');
        expect(seen[0].url).toBe('http://api.test/internal/runtime/plan');
        expect(seen[0].init.headers.authorization).toBe('Bearer plain-s');
    });

    it('maps a spent budget to LlmBudgetExceededError', async () => {
        const fetch = async () => ({ status: 429, ok: false, json: async () => ({ code: 'llm_budget_exceeded', scope: 'run' }) });
        await expect(new HttpRunPlanClient('http://api.test', { secrets, fetch }).plan(call)).rejects.toBeInstanceOf(LlmBudgetExceededError);
    });
});

describe('RuntimeAgent: the reconnaissance pass before the replay (planner-eval.md fix 2)', () => {
    const planned = (path: string, status = 200): RunPlanResponse => ({
        status: 'planned',
        plan: {
            probes: [{ entryPoint: 'GET /api/health', via: 'pkg/api/health.go', assertions: { kind: 'http', status }, probe: probe({ spec: { kind: 'http', target: { service: 'grafana', port: 3000 }, method: 'GET', path, timeoutMs: 30_000 } }) }],
            tests: [],
            claims: [],
            cannotProve: [],
        },
        rejected: [],
        usage,
        steps: 2,
    });

    it('sends each http probe to base before the replay and keeps a plan with no doubt as it is, with no other round', async () => {
        const p = planner([planned('/api/health')]);
        const e = env();
        const plan = await new RuntimeAgent(noLlm, e, p.client).plan(input);
        // A GET goes twice, to see whether the body varies; both on the base claim, with stable step ids.
        expect(e.probes).toEqual([0, 1].map((n) => ({ claimId: 'base', stepId: stableStepId(RUN_ID, 1, `agent:plan:recon:0:0:${n}`), path: '/api/health' })));
        expect(p.calls).toHaveLength(1);
        expect(plan.recon).toEqual({ probes: 1, doubts: 0, revised: false });
    });

    it('a path the app does not serve (the web app answers its HTML page) gets one revision round, with what base answered and no exploration left', async () => {
        const p = planner([planned('/server/ping'), planned('/api/server/ping', 401)]);
        const e = env('', (path) => (path.startsWith('/api/') ? { status: 200, contentType: 'application/json', body: '{"res":"pong"}' } : { status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Immich</title>' }));
        const plan = await new RuntimeAgent(noLlm, e, p.client).plan(input);
        expect(p.calls).toHaveLength(2);
        const second = RunPlanRequestSchema.parse(p.calls[1].body);
        expect(second).toMatchObject({ round: 1, execLeft: 0 });
        expect(second.recon!.answers).toEqual([
            expect.objectContaining({ probeId: 'health', request: 'GET /server/ping', status: 200, contentType: 'text/html; charset=utf-8', doubts: [expect.stringContaining('HTML page')] }),
        ]);
        expect(plan.probes.map((x) => x.probe.spec.kind === 'http' && x.probe.spec.path)).toEqual(['/api/server/ping']);
        // The revision moved the path; the status stays the one first predicted, never base's.
        expect(plan.probes[0].assertions).toEqual({ kind: 'http', status: 200 });
        expect(plan.recon).toEqual({ probes: 1, doubts: 1, revised: true });
        expect(plan.usage).toEqual({ inputTokens: 20, outputTokens: 4 });
    });

    it('a revision round that does not plan leaves the first plan', async () => {
        const p = planner([planned('/missing'), { status: 'no_plan', reason: 'the token budget ran out', rejected: [], usage, steps: 3 }]);
        const e = env('', () => ({ status: 404, contentType: 'text/plain', body: 'Not Found' }));
        const plan = await new RuntimeAgent(noLlm, e, p.client).plan(input);
        expect(plan.probes.map((x) => x.probe.spec.kind === 'http' && x.probe.spec.path)).toEqual(['/missing']);
        expect(plan.rejected).toEqual([]);
        expect(plan.recon).toEqual({ probes: 1, doubts: 1, revised: false });
    });

    it("a canary in base's answer stops the plan, as it would stop a replay (ADR-043)", async () => {
        const vault = new HmacCanaryVault(Buffer.alloc(32, 1));
        const canaries = vault.forRun({ runId: RUN_ID, runToken: input.runToken });
        const p = planner([planned('/api/health')]);
        const e = env('', () => ({ status: 200, contentType: 'application/json', body: `{"t":"${canaries[1].value}"}` }));
        await expect(new RuntimeAgent(noLlm, e, p.client).plan({ ...input, canaries } as any)).rejects.toBeInstanceOf(CanaryLeakError);
        expect(p.calls).toHaveLength(1);
    });
});
