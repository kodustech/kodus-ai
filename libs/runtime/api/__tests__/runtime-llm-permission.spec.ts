import { ServiceUnavailableException } from '@nestjs/common';

import { LLM } from '@libs/llm/llm';
import { LLM_TASK } from '@libs/llm/llm-tasks';

import { LlmProviderUnavailableError } from '../domain/ports';
import { ByokRuntimeAgentRunnerFactory, ByokRuntimeLlmProvider, permissionSlotResolver } from '../infrastructure/byok-runtime-llm.provider';
import { ByokRuntimeModelTurnProvider } from '../infrastructure/byok-model-turn.provider';
import { ORG, TEAM } from './fixtures';

jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));
const llmRun = LLM.run as jest.Mock;

// The Runtime's model calls pass the code review's own gate (license, plan,
// BYOK, credits, broken credential) for LLM_TASK.runtime before any slot is
// read, so the managed key is never used where the review would refuse it.
describe("the Runtime's LLM permission", () => {
    const orgTeam = { organizationId: ORG, teamId: TEAM };
    const SLOT = { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'enc', maxOutputTokens: 8_000 } as any;

    const service = (verdict: Record<string, unknown>) => ({
        validateExecutionPermissions: jest.fn(async () => verdict),
        resolveTaskSlot: jest.fn(async () => undefined as any),
    });

    beforeEach(() => {
        llmRun.mockReset();
        llmRun.mockResolvedValue({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, content: [], finishReason: 'stop' });
    });

    it('asks the gate for the runtime task without a seat, then reads the slot', async () => {
        const svc = service({ allowed: true });
        svc.resolveTaskSlot.mockResolvedValue(SLOT);
        await expect(permissionSlotResolver(svc as any).resolveTaskSlot(orgTeam, LLM_TASK.runtime)).resolves.toBe(SLOT);
        expect(svc.validateExecutionPermissions).toHaveBeenCalledWith(orgTeam, undefined, expect.any(String), { task: LLM_TASK.runtime, requireUserSeat: false });
    });

    it.each([
        [{ allowed: false, errorType: 'BYOK_REQUIRED' }, /own LLM key/],
        [{ allowed: false, errorType: 'BYOK_REQUIRED', metadata: { byokModelUnresolvable: true } }, /credential is incomplete/],
        [{ allowed: false, errorType: 'INVALID_LICENSE' }, /no valid license/],
        [{ allowed: false, errorType: 'CREDITS_EXHAUSTED' }, /credits/],
        [{ allowed: false, errorType: 'PLAN_LIMIT_EXCEEDED' }, /trial/],
    ])('a refused org gets no model, managed or its own (%o)', async (verdict, reason) => {
        const svc = service(verdict);
        const resolver = permissionSlotResolver(svc as any);

        const gateway = await new ByokRuntimeLlmProvider(resolver, () => true)
            .complete({ ...orgTeam, runId: 'r', repositoryId: 'repo', prNumber: 1, task: 'runtime.plan', messages: [{ role: 'user', content: 'x' }] })
            .catch((e) => e);
        expect(gateway).toBeInstanceOf(LlmProviderUnavailableError);
        expect(gateway.message).toMatch(reason);

        const turn = await new ByokRuntimeModelTurnProvider(resolver, () => true)
            .complete({ ...orgTeam, runId: 'r', repositoryId: 'repo', prNumber: 1, maxOutputTokens: 10, request: { call: { tools: [], prompt: [] } } } as any)
            .catch((e) => e);
        expect(turn).toBeInstanceOf(LlmProviderUnavailableError);

        const agent = await new ByokRuntimeAgentRunnerFactory(resolver, () => true).forOrganization(orgTeam).catch((e) => e);
        expect(agent).toBeInstanceOf(ServiceUnavailableException);
        expect(agent.message).toMatch(reason);

        expect(svc.resolveTaskSlot).not.toHaveBeenCalled();
        expect(llmRun).not.toHaveBeenCalled();
    });

    it('a failed gate refuses too (the gate itself denies on its own error)', async () => {
        const svc = service({});
        svc.validateExecutionPermissions.mockRejectedValue(new Error('billing down'));
        await expect(permissionSlotResolver(svc as any).resolveTaskSlot(orgTeam, LLM_TASK.runtime)).rejects.toBeInstanceOf(LlmProviderUnavailableError);
    });

    it('an allowed verdict is kept for a minute, a refusal is asked again', async () => {
        let now = 0;
        const svc = service({ allowed: true });
        const resolver = permissionSlotResolver(svc as any, () => now);
        await resolver.resolveTaskSlot(orgTeam, LLM_TASK.runtime);
        now = 59_000;
        await resolver.resolveTaskSlot(orgTeam, LLM_TASK.runtime);
        expect(svc.validateExecutionPermissions).toHaveBeenCalledTimes(1);
        now = 61_000;
        await resolver.resolveTaskSlot(orgTeam, LLM_TASK.runtime);
        expect(svc.validateExecutionPermissions).toHaveBeenCalledTimes(2);

        svc.validateExecutionPermissions.mockResolvedValue({ allowed: false, errorType: 'INVALID_LICENSE' } as any);
        now = 200_000;
        await resolver.resolveTaskSlot(orgTeam, LLM_TASK.runtime).catch(() => undefined);
        await resolver.resolveTaskSlot(orgTeam, LLM_TASK.runtime).catch(() => undefined);
        expect(svc.validateExecutionPermissions).toHaveBeenCalledTimes(4);
    });
});
