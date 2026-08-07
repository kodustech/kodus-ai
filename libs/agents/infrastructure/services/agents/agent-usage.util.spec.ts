import { agentModelIdentity, agentRunUsage } from './agent-usage.util';
import type { NormalizedModel } from '@libs/llm/byok-config';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';

const slot = (over: Partial<NormalizedModel> = {}): NormalizedModel =>
    ({ provider: 'openai', apiKey: 'enc', model: 'gpt-x', ...over }) as NormalizedModel;

const state = (over: Partial<RunState> = {}): RunState =>
    ({
        runId: 'r1',
        agentId: 'a1',
        status: 'completed',
        steps: [{}, {}, {}],
        usage: { inputTokens: 10, outputTokens: 5 },
        trace: [],
        artifacts: [],
        ...over,
    }) as unknown as RunState;

describe('agentModelIdentity — the drift-prone {model, isByok} pair, derived once', () => {
    it('takes model from the slot and marks BYOK present', () => {
        expect(agentModelIdentity(slot({ model: 'kimi-k2.7-code' }))).toEqual({
            model: 'kimi-k2.7-code',
            isByok: true,
        });
    });

    it('no slot → no model, system (not byok)', () => {
        expect(agentModelIdentity(undefined)).toEqual({
            model: undefined,
            isByok: false,
            byokModelId: undefined,
            credentialId: undefined,
        });
        expect(agentModelIdentity(null)).toEqual({
            model: undefined,
            isByok: false,
            byokModelId: undefined,
            credentialId: undefined,
        });
    });

    it('carries the stable attribution ids (byokModelId + credentialId) from the slot', () => {
        expect(
            agentModelIdentity(
                slot({ byokModelId: 'm-kimi', credentialId: 'c-moonshot' }),
            ),
        ).toEqual({
            model: 'gpt-x',
            isByok: true,
            byokModelId: 'm-kimi',
            credentialId: 'c-moonshot',
        });
    });
});

describe('agentRunUsage — full cost record from slot + RunState', () => {
    it('derives model/isByok from the slot and usage/steps/finishReason from the state', () => {
        const record = agentRunUsage(slot({ model: 'gpt-x' }), state(), {
            agentName: 'ConversationalAgent',
            phase: 'conversation',
            source: 'harness',
        });

        expect(record).toMatchObject({
            agentName: 'ConversationalAgent',
            phase: 'conversation',
            source: 'harness',
            model: 'gpt-x', // NOT the 'resolved' spec sentinel
            isByok: true,
            usage: { inputTokens: 10, outputTokens: 5 },
            steps: 3,
            finishReason: 'completed', // stopReason ?? status
        });
    });

    it('flattens organizationAndTeamData to the org/team columns', () => {
        const record = agentRunUsage(slot(), state(), {
            agentName: 'X',
            phase: 'p',
            organizationAndTeamData: { organizationId: 'org-9', teamId: 'team-3' },
        });
        expect(record.organizationId).toBe('org-9');
        expect(record.teamId).toBe('team-3');
    });

    it("prefers the run's stopReason over status for finishReason", () => {
        const record = agentRunUsage(slot(), state({ stopReason: 'budget' }), {
            agentName: 'X',
            phase: 'p',
        });
        expect(record.finishReason).toBe('budget');
    });

    it('carries no BYOK flag / model when the slot is absent (managed run)', () => {
        const record = agentRunUsage(undefined, state(), {
            agentName: 'X',
            phase: 'p',
        });
        expect(record.model).toBeUndefined();
        expect(record.isByok).toBe(false);
    });
});
