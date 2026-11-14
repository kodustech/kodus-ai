import { randomUUID } from 'crypto';

import { ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import { LlmProviderUnavailableError, RuntimeLlmGatewayUseCase } from '../application/use-cases/llm-gateway.use-case';
import { signRunToken } from '../domain/run-token';
import { LlmBudgetBusyError, type RuntimeLlmProvider } from '../domain/ports';
import { clock, config, InMemoryLlmUsage, NOW, ORG, OTHER_ORG, REPO, run, SECRET, storeWith, TEAM } from './fixtures';

class FakeProvider implements RuntimeLlmProvider {
    calls: any[] = [];
    usage: { inputTokens: number; outputTokens: number } | undefined = { inputTokens: 300, outputTokens: 100 };
    fail?: Error;
    async complete(input: any) {
        this.calls.push(input);
        if (this.fail) throw this.fail;
        return { text: 'plan', ...(this.usage ? { usage: this.usage } : {}) };
    }
}

const tokenFor = (r: ReturnType<typeof run>, patch: Record<string, unknown> = {}) =>
    `Bearer ${signRunToken(
        {
            runId: r.runId,
            attempt: r.attempt,
            organizationId: r.organizationId,
            teamId: r.teamId,
            repositoryId: r.repositoryId,
            prNumber: r.prNumber,
            exp: NOW.getTime() / 1000 + 3_600,
            ...patch,
        } as any,
        SECRET,
    )}`;

const body = (runId: string) => ({ runId, task: 'runtime.plan', messages: [{ role: 'user', content: 'explore' }] });

async function setup(runs = [run({ state: 'testing' })], usage = new InMemoryLlmUsage()) {
    const provider = new FakeProvider();
    const uc = new RuntimeLlmGatewayUseCase(await storeWith(...runs), usage, provider, config(), clock);
    return { uc, provider, usage, r: runs[0] };
}

describe('Runtime LLM gateway', () => {
    it('calls the provider for the Run of the token and records the usage', async () => {
        const { uc, provider, usage, r } = await setup();
        const res = await uc.execute({ authorization: tokenFor(r), body: body(r.runId) });
        expect(res).toEqual({ text: 'plan', usage: { inputTokens: 300, outputTokens: 100 }, budget: { remaining: 600 }, redactions: 0 });
        expect(provider.calls[0]).toMatchObject({ organizationId: ORG, teamId: TEAM, runId: r.runId, repositoryId: REPO, prNumber: 7, task: 'runtime.plan' });
        expect(usage.rows).toHaveLength(1);
        expect(usage.rows[0]).toMatchObject({ runId: r.runId, repositoryId: REPO, prNumber: 7, inputTokens: 300, outputTokens: 100 });
    });

    it('S-47: a provider that reports no usage keeps the whole reservation counted, never a free call', async () => {
        const { uc, provider, usage, r } = await setup();
        provider.usage = undefined;
        await uc.execute({ authorization: tokenFor(r), body: body(r.runId) });
        expect(usage.rows).toHaveLength(1);
        expect(usage.rows[0].inputTokens + usage.rows[0].outputTokens).toBeGreaterThan(0);
        expect(await usage.totalForRun(r.runId)).toBe(usage.rows[0].inputTokens);
    });

    it('S-51: runs the token-pattern pass on every message before the provider call', async () => {
        const { uc, provider, r } = await setup();
        const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
        const res = await uc.execute({
            authorization: tokenFor(r),
            body: {
                runId: r.runId,
                task: 'runtime.plan',
                messages: [
                    { role: 'system', content: 'you are the runtime agent' },
                    { role: 'user', content: `step output:\napp: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\napp: session ${jwt} issued` },
                ],
            },
        });
        const sent = JSON.stringify(provider.calls[0].messages);
        expect(sent).not.toContain('AKIAIOSFODNN7EXAMPLE');
        expect(sent).not.toContain(jwt);
        expect(provider.calls[0].messages[1].content).toBe('step output:\napp: AWS_ACCESS_KEY_ID=[redacted:aws-access-token]\napp: session [redacted:jwt] issued');
        expect(provider.calls[0].messages[0].content).toBe('you are the runtime agent');
        expect(res.redactions).toBe(2);
    });

    it('needs a valid Run token for that Run and attempt', async () => {
        const { uc, provider, r } = await setup();
        await expect(uc.execute({ authorization: undefined, body: body(r.runId) })).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(uc.execute({ authorization: 'Bearer krt1.x.y', body: body(r.runId) })).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(uc.execute({ authorization: tokenFor(r, { exp: NOW.getTime() / 1000 - 1 }), body: body(r.runId) })).rejects.toThrow('expired');
        await expect(uc.execute({ authorization: tokenFor(r), body: body(randomUUID()) })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(uc.execute({ authorization: tokenFor(r, { attempt: 2 }), body: body(r.runId) })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(uc.execute({ authorization: tokenFor(r, { organizationId: OTHER_ORG }), body: body(r.runId) })).rejects.toBeInstanceOf(NotFoundException);
        await expect(uc.execute({ authorization: tokenFor(r), body: { ...body(r.runId), extra: 1 } })).rejects.toThrow();
        expect(provider.calls).toHaveLength(0);
    });

    it('refuses a finished Run', async () => {
        const { uc, r } = await setup([run({ state: 'no_regressions' })]);
        await expect(uc.execute({ authorization: tokenFor(r), body: body(r.runId) })).rejects.toBeInstanceOf(ConflictException);
    });

    it('stops at the Run budget, the lower of the gateway limit and the token ceiling', async () => {
        const { uc, provider, r } = await setup();
        await uc.execute({ authorization: tokenFor(r), body: body(r.runId) });
        await uc.execute({ authorization: tokenFor(r), body: body(r.runId) });
        await uc.execute({ authorization: tokenFor(r), body: body(r.runId) }); // 1200 >= 1000 after this one
        const err = await uc.execute({ authorization: tokenFor(r), body: body(r.runId) }).catch((e) => e);
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(429);
        expect(err.getResponse()).toMatchObject({ code: 'llm_budget_exceeded', scope: 'run' });
        expect(provider.calls).toHaveLength(3);

        const capped = await setup();
        await capped.uc.execute({ authorization: tokenFor(capped.r, { maxTokens: 400 }), body: body(capped.r.runId) });
        await expect(capped.uc.execute({ authorization: tokenFor(capped.r, { maxTokens: 400 }), body: body(capped.r.runId) })).rejects.toMatchObject({
            response: { scope: 'run' },
        });
    });

    it('stops at the PR budget across attempts and at the org budget for the day', async () => {
        const usage = new InMemoryLlmUsage();
        await usage.record({ runId: 'old-attempt', organizationId: ORG, repositoryId: REPO, prNumber: 7, task: 'runtime.plan', inputTokens: 2_500, outputTokens: 0, at: NOW });
        const pr = await setup([run({ state: 'testing' })], usage);
        await expect(pr.uc.execute({ authorization: tokenFor(pr.r), body: body(pr.r.runId) })).rejects.toMatchObject({ response: { scope: 'pull_request' } });

        const day = new InMemoryLlmUsage();
        await day.record({ runId: 'x', organizationId: ORG, repositoryId: 'repo-9', prNumber: 1, task: 'runtime.plan', inputTokens: 10_000, outputTokens: 0, at: new Date('2026-10-29T00:00:01Z') });
        await day.record({ runId: 'y', organizationId: ORG, repositoryId: 'repo-9', prNumber: 2, task: 'runtime.plan', inputTokens: 99_999, outputTokens: 0, at: new Date('2026-10-28T23:59:59Z') });
        const org = await setup([run({ state: 'testing' })], day);
        await expect(org.uc.execute({ authorization: tokenFor(org.r), body: body(org.r.runId) })).rejects.toMatchObject({ response: { scope: 'org_day' } });

        const yesterdayOnly = new InMemoryLlmUsage();
        await yesterdayOnly.record({ runId: 'y', organizationId: ORG, repositoryId: 'repo-9', prNumber: 2, task: 'runtime.plan', inputTokens: 99_999, outputTokens: 0, at: new Date('2026-10-28T23:59:59Z') });
        const fresh = await setup([run({ state: 'testing' })], yesterdayOnly);
        await expect(fresh.uc.execute({ authorization: tokenFor(fresh.r), body: body(fresh.r.runId) })).resolves.toBeDefined();
    });

    it("applies the org's own daily budget from Settings when it is lower than the gateway's", async () => {
        const usage = new InMemoryLlmUsage();
        await usage.record({ runId: 'x', organizationId: ORG, repositoryId: 'repo-9', prNumber: 1, task: 'runtime.plan', inputTokens: 500, outputTokens: 0, at: NOW });
        const r = run({ state: 'testing' });
        const provider = new FakeProvider();
        const settings = { getOrganization: async () => ({ tokenBudgetPerDay: 500 }) };
        const uc = new RuntimeLlmGatewayUseCase(await storeWith(r), usage, provider, config(), clock, settings);
        await expect(uc.execute({ authorization: tokenFor(r), body: body(r.runId) })).rejects.toMatchObject({ response: { scope: 'org_day', limit: 500 } });
        expect(provider.calls).toHaveLength(0);

        const higher = new RuntimeLlmGatewayUseCase(await storeWith(r), usage, provider, config(), clock, { getOrganization: async () => ({ tokenBudgetPerDay: 999_999 }) });
        await expect(higher.execute({ authorization: tokenFor(r), body: body(r.runId) })).resolves.toBeDefined();
    });

    it('S-47: parallel calls reserve before the provider, so together they never pass the Run budget', async () => {
        const r = run({ state: 'testing' });
        const usage = new InMemoryLlmUsage();
        let release!: () => void;
        const gate = new Promise<void>((res) => (release = res));
        const provider = {
            calls: [] as any[],
            async complete(input: any) {
                this.calls.push(input);
                await gate;
                return { text: 'ok', usage: { inputTokens: 3, outputTokens: input.maxOutputTokens } };
            },
        };
        const uc = new RuntimeLlmGatewayUseCase(await storeWith(r), usage, provider, config(), clock);
        const req = { ...body(r.runId), maxOutputTokens: 300 };
        const pending = Array.from({ length: 6 }, () => uc.execute({ authorization: tokenFor(r), body: req }).catch((e) => e));
        await new Promise((res) => setImmediate(res));
        release();
        const results = await Promise.all(pending);
        const refused = results.filter((x) => x instanceof HttpException);
        expect(refused.length).toBeGreaterThan(0);
        expect(refused[0].getResponse()).toMatchObject({ code: 'llm_budget_exceeded', scope: 'run' });
        expect(await usage.totalForRun(r.runId)).toBeLessThanOrEqual(1_000);
        for (const c of provider.calls) expect(c.maxOutputTokens).toBeLessThanOrEqual(300);
    });

    it('S-47: a budget too contended to reserve is 503 llm_budget_busy, and the provider is never called', async () => {
        const usage = new InMemoryLlmUsage();
        usage.reserve = async () => {
            throw new LlmBudgetBusyError();
        };
        const { uc, provider, r } = await setup(undefined, usage);
        const err = await uc.execute({ authorization: tokenFor(r), body: body(r.runId) }).catch((e) => e);
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        expect(err.getResponse()).toMatchObject({ code: 'llm_budget_busy' });
        expect(provider.calls).toHaveLength(0);
    });

    it('refuses a prompt bigger than what is left, and always bounds the output it asks for', async () => {
        const { uc, provider, r } = await setup();
        const huge = { runId: r.runId, task: 'runtime.plan', messages: [{ role: 'user', content: 'x'.repeat(3_100) }] };
        await expect(uc.execute({ authorization: tokenFor(r), body: huge })).rejects.toMatchObject({ response: { code: 'llm_budget_exceeded' } });
        expect(provider.calls).toHaveLength(0);

        await uc.execute({ authorization: tokenFor(r), body: body(r.runId) });
        expect(provider.calls[0].maxOutputTokens).toBe(1_000 - 3);
    });

    it('resolves the BYOK slot with the team the product signed, not the projection', async () => {
        const { uc, provider, r } = await setup();
        await uc.execute({ authorization: tokenFor(r, { teamId: 'team-signed' }), body: body(r.runId) });
        expect(provider.calls[0].teamId).toBe('team-signed');
    });

    it('maps provider failures to 503 (not wired) and 502 (call failed) without recording usage', async () => {
        const { uc, provider, usage, r } = await setup();
        provider.fail = new LlmProviderUnavailableError('not wired');
        await expect(uc.execute({ authorization: tokenFor(r), body: body(r.runId) })).rejects.toMatchObject({ status: 503 });
        provider.fail = new Error('boom');
        await expect(uc.execute({ authorization: tokenFor(r), body: body(r.runId) })).rejects.toMatchObject({ status: 502 });
        expect(usage.rows).toHaveLength(0);
    });
});
