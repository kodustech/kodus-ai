import { ServiceUnavailableException } from '@nestjs/common';

import { LLM } from '@libs/llm/llm';
import { LLM_TASK } from '@libs/llm/llm-tasks';

import { LlmProviderUnavailableError, RuntimeLlmGatewayUseCase } from '../application/use-cases/llm-gateway.use-case';
import { signRunToken } from '../domain/run-token';
import { ByokRuntimeLlmProvider, type RuntimeSlotResolver } from '../infrastructure/byok-runtime-llm.provider';
import { clock, config, InMemoryLlmUsage, NOW, ORG, run, SECRET, storeWith, TEAM } from './fixtures';

jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));
const llmRun = LLM.run as jest.Mock;

// A fake credential: an encrypted-looking blob that must never surface anywhere.
const KEY = 'enc:fake-key-material-0123456789';
const SLOT = { provider: 'openai_compatible', model: 'fake-model', apiKey: KEY, baseURL: 'https://llm.example.test/v1', maxOutputTokens: 8_000 } as any;

class FakeSlots implements RuntimeSlotResolver {
    calls: any[] = [];
    constructor(private readonly slot: any) {}
    async resolveTaskSlot(orgTeam: any, task: any) {
        this.calls.push({ orgTeam, task });
        return this.slot;
    }
}

const input = (patch: Record<string, unknown> = {}) => ({
    organizationId: ORG,
    teamId: TEAM,
    runId: 'run-1',
    repositoryId: 'repo-1',
    prNumber: 7,
    task: 'runtime.plan',
    messages: [
        { role: 'system' as const, content: 'You plan runs.' },
        { role: 'user' as const, content: 'explore' },
    ],
    ...patch,
});

describe('ByokRuntimeLlmProvider', () => {
    let logs: string[];
    beforeEach(() => {
        llmRun.mockReset();
        llmRun.mockResolvedValue({ text: '{"plan":[]}', usage: { inputTokens: 120, outputTokens: 30 } });
        logs = [];
        for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) {
            jest.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
        }
    });
    afterEach(() => jest.restoreAllMocks());

    it('routes LLM_TASK.runtime for the org/team of the Run and maps text + usage', async () => {
        const slots = new FakeSlots(SLOT);
        const res = await new ByokRuntimeLlmProvider(slots, () => false).complete(input({ maxOutputTokens: 500 }));

        expect(slots.calls).toEqual([{ orgTeam: { organizationId: ORG, teamId: TEAM }, task: LLM_TASK.runtime }]);
        const req = llmRun.mock.calls[0][0];
        expect(req.byokConfig).toMatchObject({ provider: 'openai_compatible', model: 'fake-model', apiKey: KEY, maxOutputTokens: 500 });
        expect(req.loop).toEqual({ tools: {}, maxSteps: 1 });
        expect(req.system).toBe('You plan runs.');
        expect(req.messages).toEqual([{ role: 'user', content: 'explore' }]);
        expect(req).toMatchObject({ runName: 'runtime.plan', organizationId: ORG, maxOutputTokens: 500 });
        // The usage span is the record of the call: it names the Run, team, repo and PR.
        expect(req.attrs).toEqual({ route: LLM_TASK.runtime, runId: 'run-1', teamId: TEAM, repositoryId: 'repo-1', prNumber: 7, task: 'runtime.plan' });
        // The model is named so the Run's cost is priced by it (§13 PR 5).
        expect(res).toEqual({ text: '{"plan":[]}', usage: { inputTokens: 120, outputTokens: 30 }, model: 'fake-model' });
        expect(JSON.stringify(res)).not.toContain(KEY);
    });

    it('never raises the slot limit with the gateway cap', async () => {
        await new ByokRuntimeLlmProvider(new FakeSlots(SLOT), () => false).complete(input({ maxOutputTokens: 64_000 }));
        expect(llmRun.mock.calls[0][0].byokConfig.maxOutputTokens).toBe(8_000);
    });

    it('uses the managed default (no slot) when the org has no BYOK and a managed key exists', async () => {
        await new ByokRuntimeLlmProvider(new FakeSlots(undefined), () => true).complete(input());
        expect(llmRun.mock.calls[0][0].byokConfig).toBeUndefined();
    });

    it('is unavailable when there is neither a BYOK slot nor a managed default', async () => {
        const err = await new ByokRuntimeLlmProvider(new FakeSlots(null), () => false).complete(input()).catch((e) => e);
        expect(err).toBeInstanceOf(LlmProviderUnavailableError);
        expect(err.message).toMatch(/No LLM is configured/);
        expect(llmRun).not.toHaveBeenCalled();
    });

    it('keeps the key out of the error and the logs when the provider call fails', async () => {
        llmRun.mockRejectedValue(new Error('upstream 500'));
        const err = await new ByokRuntimeLlmProvider(new FakeSlots(SLOT), () => false).complete(input()).catch((e) => e);
        expect(String(err?.message)).not.toContain(KEY);
        expect(logs.join('\n')).not.toContain(KEY);
    });

    describe('task effort hint (runtime.intent)', () => {
        const intent = (slot: any) => new ByokRuntimeLlmProvider(new FakeSlots(slot), () => false).complete(input({ task: 'runtime.intent' }));

        it('runs runtime.intent at low effort when the slot names no effort', async () => {
            await intent(SLOT);
            expect(llmRun.mock.calls[0][0].byokConfig).toMatchObject({ model: 'fake-model', apiKey: KEY, reasoningEffort: 'low' });
        });

        it('keeps the gateway cap with the hint', async () => {
            await new ByokRuntimeLlmProvider(new FakeSlots(SLOT), () => false).complete(input({ task: 'runtime.intent', maxOutputTokens: 500 }));
            expect(llmRun.mock.calls[0][0].byokConfig).toMatchObject({ reasoningEffort: 'low', maxOutputTokens: 500 });
        });

        it('hints the fallback slot too, unless it names its own effort', async () => {
            await intent({ ...SLOT, fallback: { provider: 'anthropic', model: 'fallback-model', apiKey: KEY } });
            expect(llmRun.mock.calls[0][0].byokConfig.fallback).toMatchObject({ model: 'fallback-model', reasoningEffort: 'low' });
            await intent({ ...SLOT, reasoningEffort: 'high', fallback: { provider: 'anthropic', model: 'fallback-model', apiKey: KEY, reasoningEffort: 'medium' } });
            expect(llmRun.mock.calls[1][0].byokConfig).toMatchObject({ reasoningEffort: 'high', fallback: { reasoningEffort: 'medium' } });
        });

        it.each([
            ['an explicit effort', { reasoningEffort: 'high' }],
            ['an explicit none', { reasoningEffort: 'none' }],
            ['a reasoning override JSON', { reasoningConfigOverride: '{"thinking":{"type":"enabled"}}' }],
        ])('keeps the org choice when the slot sets %s', async (_what, choice: Record<string, string>) => {
            await intent({ ...SLOT, ...choice });
            const sent = llmRun.mock.calls[0][0].byokConfig;
            expect(sent.reasoningEffort).toBe(choice.reasoningEffort);
            expect(sent.reasoningConfigOverride).toBe(choice.reasoningConfigOverride);
        });

        it('leaves runtime.plan at the slot default', async () => {
            await new ByokRuntimeLlmProvider(new FakeSlots(SLOT), () => false).complete(input({ task: 'runtime.plan' }));
            expect(llmRun.mock.calls[0][0].byokConfig.reasoningEffort).toBeUndefined();
        });

        it('does not invent a slot on the managed default', async () => {
            await new ByokRuntimeLlmProvider(new FakeSlots(undefined), () => true).complete(input({ task: 'runtime.intent' }));
            expect(llmRun.mock.calls[0][0].byokConfig).toBeUndefined();
        });
    });
});

describe('Runtime LLM gateway with the BYOK provider', () => {
    beforeEach(() => {
        llmRun.mockReset();
        llmRun.mockResolvedValue({ text: 'plan', usage: { inputTokens: 200, outputTokens: 50 } });
    });

    const tokenFor = (r: ReturnType<typeof run>) =>
        `Bearer ${signRunToken(
            { runId: r.runId, attempt: r.attempt, organizationId: r.organizationId, teamId: r.teamId, repositoryId: r.repositoryId, prNumber: r.prNumber, exp: NOW.getTime() / 1000 + 3_600 } as any,
            SECRET,
        )}`;

    it('records the usage LLM.run returned and answers the remaining budget', async () => {
        const r = run({ state: 'testing' });
        const usage = new InMemoryLlmUsage();
        const slots = new FakeSlots(SLOT);
        const uc = new RuntimeLlmGatewayUseCase(await storeWith(r), usage, new ByokRuntimeLlmProvider(slots, () => false), config(), clock);

        const res = await uc.execute({ authorization: tokenFor(r), body: { runId: r.runId, task: 'runtime.intent', messages: [{ role: 'user', content: 'go' }] } });

        expect(res).toEqual({ text: 'plan', usage: { inputTokens: 200, outputTokens: 50 }, budget: { remaining: 750 }, redactions: 0 });
        expect(slots.calls[0]).toEqual({ orgTeam: { organizationId: ORG, teamId: TEAM }, task: LLM_TASK.runtime });
        expect(llmRun.mock.calls[0][0]).toMatchObject({ runName: 'runtime.intent', organizationId: ORG });
        expect(usage.rows[0]).toMatchObject({ runId: r.runId, task: 'runtime.intent', inputTokens: 200, outputTokens: 50 });
        expect(JSON.stringify(res)).not.toContain(KEY);
    });

    it('answers 503 when nothing is configured', async () => {
        const r = run({ state: 'testing' });
        const uc = new RuntimeLlmGatewayUseCase(await storeWith(r), new InMemoryLlmUsage(), new ByokRuntimeLlmProvider(new FakeSlots(undefined), () => false), config(), clock);
        await expect(uc.execute({ authorization: tokenFor(r), body: { runId: r.runId, task: 'runtime.plan', messages: [{ role: 'user', content: 'go' }] } })).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
    });
});
