// The runner drives the loop through LLM.run, which resolves the model via
// resolveModelConfig: mock it to inject a scripted model (no key, no network).
jest.mock('@libs/llm/model-invocation', () => ({ resolveModelConfig: jest.fn() }));

import { BadGatewayException, ConflictException, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { MockLanguageModelV3 } from 'ai/test';

import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { resolveModelConfig } from '@libs/llm/model-invocation';

import { SUBMIT_PLAN_TOOL } from '../application/test-planner/test-planner.agent';
import { RuntimeTestPlannerUseCase, TEST_PLANNER_TASK } from '../application/use-cases/test-planner.use-case';
import type { RuntimeGitPort } from '../domain/ports';
import { signRunToken, signSetupToken } from '../domain/run-token';
import { BASE_SHA, clock, config, InMemoryLlmUsage, NOW, ORG, REPO, run, SECRET, SHA, storeWith, TEAM } from './fixtures';

// Kody plans a Run's probes, product side (ADR-069): the Run token, the Run it
// names, the base commit read through the Git integration, and the budget.

const BUDGET = { perRun: 500_000, perPullRequest: 1_000_000, perOrgPerDay: 5_000_000 };
const FILES: Record<string, string> = {
    'pkg/api/api.go': 'r.Get("/api/health", hs.apiHealthHandler)\n',
    'pkg/api/health.go': 'func (hs *HTTPServer) apiHealthHandler() {}\n',
};

const tokenFor = (r: ReturnType<typeof run>, patch: Record<string, unknown> = {}) =>
    `Bearer ${signRunToken(
        { runId: r.runId, attempt: r.attempt, organizationId: r.organizationId, teamId: r.teamId, repositoryId: r.repositoryId, prNumber: r.prNumber, exp: NOW.getTime() / 1000 + 3_600, ...patch } as any,
        SECRET,
    )}`;

const body = (runId: string) => ({
    runId,
    round: 0,
    entryPoints: [{ id: 'unmapped:pkg/api/health.go', kind: 'unmapped' }],
    changedPaths: ['pkg/api/health.go'],
    diff: '--- pkg/api/health.go\n+x',
    targets: [{ service: 'grafana', port: 3000, kind: 'http' }],
    execLeft: 5,
    observations: [],
});

const probe = {
    entryPoint: 'GET /api/health',
    via: 'pkg/api/health.go',
    probe: {
        id: 'health',
        purpose: 'health answers',
        expected: '200',
        compare: ['status'],
        spec: { kind: 'http', target: { service: 'grafana', port: 3000 }, method: 'GET', path: '/api/health', timeoutMs: 30_000 },
    },
};

function scripted(turns: Array<{ tool: string; input: unknown } | 'throw'>) {
    let i = 0;
    const model = new MockLanguageModelV3({
        doGenerate: (async () => {
            const t = turns[Math.min(i++, turns.length - 1)];
            if (t === 'throw') throw new Error('provider down');
            return {
                content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: t.tool, input: JSON.stringify(t.input) }],
                finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                usage: { inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 50, text: 50, reasoning: 0 } },
                warnings: [],
            };
        }) as any,
    });
    (resolveModelConfig as jest.Mock).mockReturnValue({ model, callOptions: {}, providerOptions: {}, modelName: 'mock', usageIdentity: {} });
}

async function make(r = run({ state: 'testing' }), usage = new InMemoryLlmUsage(), budget = BUDGET) {
    const calls: string[] = [];
    const git: Pick<RuntimeGitPort, 'readFileAtCommit' | 'listFilesAtCommit'> = {
        listFilesAtCommit: async (i) => {
            calls.push(`list@${i.sha.slice(0, 1)}`);
            return Object.keys(FILES);
        },
        readFileAtCommit: async (i) => {
            calls.push(`read ${i.path}@${i.sha.slice(0, 1)}`);
            return FILES[i.path] ?? null;
        },
    };
    const runners = { forOrganization: async () => ({ runner: new AiSdkAgentRunner(undefined), model: 'mock-model' }) };
    const uc = new RuntimeTestPlannerUseCase(config({ llmBudget: budget }), clock, await storeWith(r), usage, git as RuntimeGitPort, runners);
    return { uc, usage, calls, r };
}

describe('POST /internal/runtime/plan', () => {
    it('plans on the base commit, reads changed files at the head, and counts the round on the Run budget', async () => {
        scripted([
            { tool: 'search_code', input: { text: 'apiHealthHandler' } },
            { tool: 'read_file', input: { path: 'pkg/api/health.go', at: 'head' } },
            { tool: SUBMIT_PLAN_TOOL, input: { probes: [probe] } },
        ]);
        const t = await make();
        const out = await t.uc.execute({ authorization: tokenFor(t.r), body: body(t.r.runId) });
        expect(out).toMatchObject({ status: 'planned', usage: { inputTokens: 3_000, outputTokens: 150 } });
        expect(t.calls).toContain(`read pkg/api/api.go@${BASE_SHA[0]}`);
        expect(t.calls).toContain(`read pkg/api/health.go@${SHA[0]}`);
        expect(t.usage.rows).toEqual([
            expect.objectContaining({ runId: t.r.runId, organizationId: ORG, repositoryId: REPO, prNumber: 7, task: TEST_PLANNER_TASK, inputTokens: 3_000, outputTokens: 150, pending: false }),
        ]);
    });

    it('plans nothing, with no model call and no tokens, when the diff has no entry point (a recipe or lockfile only)', async () => {
        scripted(['throw']);
        const t = await make();
        const out = await t.uc.execute({ authorization: tokenFor(t.r), body: { ...body(t.r.runId), entryPoints: [], changedPaths: ['.kodus/compose.yaml'] } });
        expect(out).toEqual({ status: 'planned', plan: { probes: [], tests: [], claims: [], cannotProve: [] }, rejected: [], usage: { inputTokens: 0, outputTokens: 0 }, steps: 0 });
        expect(t.usage.rows).toEqual([]);
        expect(t.calls).toEqual([]);
    });

    it('plans a dependency bump with no model call: the manifest in cannotProve, no tokens', async () => {
        scripted(['throw']);
        const t = await make();
        const out = await t.uc.execute({
            authorization: tokenFor(t.r),
            body: {
                ...body(t.r.runId),
                entryPoints: [{ id: 'unmapped:go.mod', kind: 'unmapped' }, { id: 'dependency_surface:go.sum', kind: 'dependency_surface' }],
                changedPaths: ['go.mod', 'go.sum'],
                diff: '--- go.mod\n@@ -5 +5 @@\n-\tgithub.com/Masterminds/semver/v3 v3.3.1\n+\tgithub.com/Masterminds/semver/v3 v3.4.0',
            },
        });
        expect(out).toMatchObject({ status: 'planned', plan: { probes: [], cannotProve: [expect.stringMatching(/^go\.mod: only dependency versions change/)] }, usage: { inputTokens: 0, outputTokens: 0 }, steps: 0 });
        expect(t.usage.rows).toEqual([]);
        expect(t.calls).toEqual([]);
    });

    it('takes only a Run token for a live Run of its own', async () => {
        scripted([{ tool: SUBMIT_PLAN_TOOL, input: { probes: [probe] } }]);
        const t = await make();
        await expect(t.uc.execute({ authorization: undefined, body: body(t.r.runId) })).rejects.toBeInstanceOf(UnauthorizedException);
        const setup = `Bearer ${signSetupToken({ setupKey: 'k', environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, exp: NOW.getTime() / 1000 + 3_600 } as any, SECRET)}`;
        await expect(t.uc.execute({ authorization: setup, body: body(t.r.runId) })).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(t.uc.execute({ authorization: tokenFor(t.r, { attempt: 2 }), body: body(t.r.runId) })).rejects.toBeInstanceOf(ForbiddenException);
        const done = await make(run({ state: 'regression' }));
        await expect(done.uc.execute({ authorization: tokenFor(done.r), body: body(done.r.runId) })).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 429 when the Run budget cannot pay for a round', async () => {
        scripted([{ tool: SUBMIT_PLAN_TOOL, input: { probes: [probe] } }]);
        const usage = new InMemoryLlmUsage();
        const r = run({ state: 'testing' });
        await usage.record({ runId: r.runId, organizationId: ORG, repositoryId: REPO, prNumber: 7, task: 'runtime.plan', inputTokens: 495_000, outputTokens: 0, at: NOW });
        const t = await make(r, usage);
        const err = await t.uc.execute({ authorization: tokenFor(r), body: body(r.runId) }).catch((e) => e);
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(429);
        expect(err.getResponse()).toMatchObject({ code: 'llm_budget_exceeded' });
    });

    it('answers 502 when the model fails before any submission, and keeps the reservation counted', async () => {
        scripted(['throw']);
        const t = await make();
        await expect(t.uc.execute({ authorization: tokenFor(t.r), body: body(t.r.runId) })).rejects.toBeInstanceOf(BadGatewayException);
        expect(t.usage.rows.every((row) => !row.pending)).toBe(true);
        expect(t.usage.rows.reduce((n, row) => n + row.inputTokens + row.outputTokens, 0)).toBeGreaterThan(0);
    });
});
