import { existsSync } from 'fs';
import { join } from 'path';
import { createHmac, randomUUID } from 'crypto';
import {
    ConflictException,
    ForbiddenException,
    HttpException,
    UnauthorizedException,
} from '@nestjs/common';
import { sealSecret, sealingKeyFrom } from '@libs/runtime/run';
import { HmacCanaryVault } from '../../../../apps/runtime/src/worker/canary/canary';
import { signRunToken } from '../domain/run-token';
import {
    clock,
    config,
    InMemoryLlmUsage,
    NOW,
    run,
    SECRET,
    SEAL_KEY,
    storeWith,
} from './fixtures';

const load = () => {
    const path = join(
        __dirname,
        '../application/use-cases/model-turn-gateway.use-case.ts',
    );
    expect(existsSync(path)).toBe(true);
    return require(path).RuntimeModelTurnGatewayUseCase;
};
const request = (runId: string) => ({
    v: 1,
    scope: { runId, attempt: 1, turnId: randomUUID() },
    task: 'runtime.plan',
    toolset: 'runtime-planner-v1',
    call: {
        prompt: [
            { role: 'user', content: [{ type: 'text', text: 'data only' }] },
        ],
        tools: [
            {
                type: 'function',
                name: 'submit_plan',
                inputSchema: { type: 'object' },
            },
        ],
        maxOutputTokens: 200,
    },
});
const generation = () => ({
    content: [{ type: 'text', text: 'bounded answer' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
        reported: true,
        inputTokens: { total: 30, cacheRead: 10 },
        outputTokens: { total: 5 },
    },
    warnings: [],
});
class Receipts {
    rows = new Map<string, any>();
    async claim(key: string, fingerprint: string, _expiresAt: Date) {
        const old = this.rows.get(key);
        if (old) return { fresh: false, ...old };
        this.rows.set(key, { fingerprint });
        return { fresh: true };
    }
    async complete(key: string, fingerprint: string, response: unknown) {
        const old = this.rows.get(key);
        if (!old || old.fingerprint !== fingerprint)
            throw Error('receipt conflict');
        old.response = response;
    }
}
async function setup(perRun = 20_000) {
    const r = run({ state: 'testing' });
    const plain = signRunToken(
        {
            runId: r.runId,
            attempt: r.attempt,
            organizationId: r.organizationId,
            teamId: r.teamId,
            repositoryId: r.repositoryId,
            prNumber: r.prNumber,
            maxTokens: 20_000,
            exp: NOW.getTime() / 1000 + 3600,
        },
        SECRET,
    );
    const sealedToken = sealSecret(plain, sealingKeyFrom(SEAL_KEY), r.runId);
    const usage = new InMemoryLlmUsage(),
        receipts = new Receipts();
    const provider = {
        complete: jest.fn(async (input: any) => {
            const lease = await input.modelCallBudget.before({
                prompt: input.request.call.prompt,
                tools: input.request.call.tools,
                maxOutputTokens: input.maxOutputTokens,
            });
            const out = generation();
            await lease.finish({
                outcome: 'completed',
                usage: {
                    inputTokens: out.usage.inputTokens,
                    outputTokens: out.usage.outputTokens,
                },
            });
            return { generation: out, model: 'trusted-slot-model' };
        }),
    };
    const uc = new (load())(
        config({
            llmBudget: { perRun, perPullRequest: 30_000, perOrgPerDay: 40_000 },
        }),
        clock,
        await storeWith(r),
        usage,
        provider,
        receipts,
    );
    const input = {
        authorization: `Bearer ${plain}`,
        sealedToken,
        body: request(r.runId),
    };
    return { uc, r, plain, sealedToken, usage, receipts, provider, input };
}
describe('fixed Runtime model-turn gateway', () => {
    it('resolves scope from a signed token, budgets one turn and replays its persisted receipt', async () => {
        const h = await setup();
        const out = await h.uc.execute(h.input);
        expect(out.scope).toEqual(h.input.body.scope);
        expect(out.generation).toEqual(generation());
        expect(out.budget.usageBasis).toBe('provider_reported');
        expect(h.provider.complete).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: h.r.organizationId,
                teamId: h.r.teamId,
                repositoryId: h.r.repositoryId,
                runId: h.r.runId,
            }),
        );
        expect(h.usage.rows).toHaveLength(1);
        expect(await h.usage.totalForRun(h.r.runId)).toBe(35);
        expect(await h.uc.execute(h.input)).toEqual(out);
        expect(h.provider.complete).toHaveBeenCalledTimes(1);
        expect(h.usage.rows).toHaveLength(1);
        expect(JSON.stringify([...h.receipts.rows])).not.toContain(h.plain);
        expect(JSON.stringify([...h.receipts.rows])).not.toContain(
            h.sealedToken,
        );
    });
    it('rejects invalid authentication, wrong attempt/scope, extra model routing and missing sealed context before calling a provider', async () => {
        const h = await setup();
        await expect(
            h.uc.execute({ ...h.input, authorization: undefined }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(
            h.uc.execute({ ...h.input, sealedToken: undefined }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(
            h.uc.execute({
                ...h.input,
                sealedToken: sealSecret(
                    h.plain,
                    sealingKeyFrom(SEAL_KEY),
                    'other',
                ),
            }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(
            h.uc.execute({
                ...h.input,
                body: {
                    ...h.input.body,
                    scope: { ...h.input.body.scope, attempt: 2 },
                },
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            h.uc.execute({
                ...h.input,
                body: { ...h.input.body, provider: 'untrusted' },
            }),
        ).rejects.toThrow();
        const wrongTeam = signRunToken(
            {
                runId: h.r.runId,
                attempt: 1,
                organizationId: h.r.organizationId,
                teamId: 'other-team',
                repositoryId: h.r.repositoryId,
                prNumber: h.r.prNumber,
                exp: NOW.getTime() / 1000 + 3600,
            },
            SECRET,
        );
        await expect(
            h.uc.execute({
                ...h.input,
                authorization: `Bearer ${wrongTeam}`,
                sealedToken: sealSecret(
                    wrongTeam,
                    sealingKeyFrom(SEAL_KEY),
                    h.r.runId,
                ),
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            h.uc.execute({
                ...h.input,
                authorization: 'Bearer malformed',
                body: { malformed: true },
            }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(h.provider.complete).not.toHaveBeenCalled();
        expect(h.usage.rows).toHaveLength(0);
    });
    it('independently refuses the exact existing planted canary without changing its derivation', async () => {
        const h = await setup();
        const key = createHmac('sha256', sealingKeyFrom(SEAL_KEY))
            .update('kody-runtime/canary/v1')
            .digest();
        const bait = new HmacCanaryVault(key).forRun({
            runId: h.r.runId,
            runToken: h.sealedToken,
        })[0];
        h.input.body.call.prompt[0].content[0].text = bait.value;
        await expect(h.uc.execute(h.input)).rejects.toMatchObject({
            response: expect.objectContaining({ code: 'canary_leak' }),
        });
        expect(h.provider.complete).not.toHaveBeenCalled();
        expect(h.usage.rows).toHaveLength(0);
    });
    it('does not run a duplicate in-flight turn or a changed request under the same turn id', async () => {
        const h = await setup();
        let release!: (out: any) => void;
        h.provider.complete.mockImplementation(async (input: any) => {
            const lease = await input.modelCallBudget.before({
                prompt: input.request.call.prompt,
                tools: input.request.call.tools,
                maxOutputTokens: input.maxOutputTokens,
            });
            const out: any = await new Promise((resolve) => {
                release = resolve;
            });
            await lease.finish({
                outcome: 'completed',
                usage: {
                    inputTokens: out.generation.usage.inputTokens,
                    outputTokens: out.generation.usage.outputTokens,
                },
            });
            return out;
        });
        const pending = h.uc.execute(h.input);
        for (let n = 0; n < 100 && !release; n++) await Promise.resolve();
        expect(release).toBeDefined();
        await expect(h.uc.execute(h.input)).rejects.toBeInstanceOf(
            ConflictException,
        );
        release({ generation: generation() });
        await pending;
        h.input.body.call.prompt[0].content[0].text = 'different request';
        await expect(h.uc.execute(h.input)).rejects.toBeInstanceOf(
            ConflictException,
        );
        expect(h.provider.complete).toHaveBeenCalledTimes(1);
    });
    it('keeps uncertain failure/partial usage reserved and never repeats a possibly consumed turn', async () => {
        const h = await setup();
        h.provider.complete.mockRejectedValueOnce(
            new Error('secret provider exception'),
        );
        await expect(h.uc.execute(h.input)).rejects.toMatchObject({
            response: expect.objectContaining({ code: 'llm_unavailable' }),
        });
        expect(await h.usage.totalForRun(h.r.runId)).toBeGreaterThan(0);
        await expect(h.uc.execute(h.input)).rejects.toBeInstanceOf(
            ConflictException,
        );
        expect(h.provider.complete).toHaveBeenCalledTimes(1);
        const next = await setup();
        next.provider.complete.mockImplementationOnce(async (input: any) => {
            const lease = await input.modelCallBudget.before({
                prompt: input.request.call.prompt,
                tools: input.request.call.tools,
                maxOutputTokens: input.maxOutputTokens,
            });
            const out: any = {
                ...generation(),
                usage: {
                    reported: true,
                    inputTokens: { total: 30 },
                    outputTokens: {},
                },
            };
            await lease.finish({
                outcome: 'completed',
                usage: {
                    inputTokens: out.usage.inputTokens,
                    outputTokens: out.usage.outputTokens,
                },
            });
            return { generation: out };
        });
        const out = await next.uc.execute(next.input);
        expect(out.generation.usage).toEqual({
            reported: true,
            inputTokens: { total: 30 },
            outputTokens: {},
        });
        expect(out.budget.usageBasis).toBe('reservation');
        expect(await next.usage.totalForRun(next.r.runId)).toBeGreaterThan(30);
        expect(next.usage.rows).toEqual([
            expect.objectContaining({ pending: true }),
        ]);
    });
    it('refuses a token budget before the provider and never returns raw provider diagnostics', async () => {
        const h = await setup();
        h.input.body.call.prompt[0].content[0].text = 'x'.repeat(70_000);
        const e = await h.uc.execute(h.input).catch((err: unknown) => err);
        expect(e).toBeInstanceOf(HttpException);
        expect(e.getStatus()).toBe(429);
        expect(h.provider.complete).not.toHaveBeenCalled();
    });
    it('denies a later raw attempt before it starts when an unknown earlier attempt consumed the scope budget', async () => {
        const h = await setup(1800);
        const rawCalls: string[] = [];
        h.provider.complete.mockImplementationOnce(async (input: any) => {
            const raw = {
                prompt: input.request.call.prompt,
                tools: input.request.call.tools,
                maxOutputTokens: input.maxOutputTokens,
            };
            const first = await input.modelCallBudget.before(raw);
            rawCalls.push('first');
            await first.finish({ outcome: 'failed' });
            await input.modelCallBudget.before(raw);
            rawCalls.push('second');
            throw Error('should not reach');
        });
        await expect(h.uc.execute(h.input)).rejects.toMatchObject({
            status: 429,
        });
        expect(rawCalls).toEqual(['first']);
        expect(await h.usage.totalForRun(h.r.runId)).toBeGreaterThan(1000);
    });
});

it('retains a raw repair budget refusal even when an SDK repair helper catches it, before repair dispatch', async () => {
    const h = await setup();
    let repairDispatched = false;
    h.provider.complete.mockImplementationOnce(async (input: any) => {
        const raw = {
            prompt: input.request.call.prompt,
            tools: input.request.call.tools,
            maxOutputTokens: input.maxOutputTokens,
        };
        const first = await input.modelCallBudget.before(raw);
        await first.finish({
            outcome: 'completed',
            usage: { inputTokens: { total: 30 }, outputTokens: { total: 5 } },
        });
        try {
            await input.modelCallBudget.before({
                ...raw,
                tools: undefined,
                responseFormat: {
                    type: 'json',
                    schema: { description: 'x'.repeat(30_000) },
                },
            });
            repairDispatched = true;
        } catch {
            /* The SDK repair helper returns null on a refused repair. */
        }
        return { generation: generation() };
    });
    await expect(h.uc.execute(h.input)).rejects.toMatchObject({
        status: 429,
        response: expect.objectContaining({ code: 'llm_budget_exceeded' }),
    });
    expect(repairDispatched).toBe(false);
    expect(await h.usage.totalForRun(h.r.runId)).toBe(35);
});

it('returns current scoped budget after parallel raw repair leases settle in either order', async () => {
    const h = await setup();
    h.provider.complete.mockImplementationOnce(async (input: any) => {
        const raw = {
            prompt: input.request.call.prompt,
            tools: input.request.call.tools,
            maxOutputTokens: input.maxOutputTokens,
        };
        const [one, two] = await Promise.all([
            input.modelCallBudget.before(raw),
            input.modelCallBudget.before(raw),
        ]);
        const outcome = {
            outcome: 'completed',
            usage: { inputTokens: { total: 30 }, outputTokens: { total: 5 } },
        };
        await two.finish(outcome);
        await one.finish(outcome);
        return { generation: generation() };
    });
    const response = await h.uc.execute(h.input);
    expect(response.budget.remainingTokens).toBe(20_000 - 70);
    expect(response.generation.usage).toEqual({
        reported: true,
        inputTokens: { total: 60 },
        outputTokens: { total: 10 },
    });
});
