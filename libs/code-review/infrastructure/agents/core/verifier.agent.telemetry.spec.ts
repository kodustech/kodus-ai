/**
 * A recovered verdict that cannot be traced back to the organization that
 * produced it is a log line nobody can act on (PR #1976 review, Rule 1).
 *
 * The logger is created at module scope in verifier.agent.ts, so it is mocked
 * here BEFORE the import — spying on a separately-created instance would assert
 * nothing, which is how the first version of this test passed while proving it.
 */
const logCalls: any[] = [];
const warnCalls: any[] = [];

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: (entry: any) => logCalls.push(entry),
        warn: (entry: any) => warnCalls.push(entry),
        error: () => undefined,
    }),
}));

import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import {
    VERIFY_DONE_TOOL,
    extractVerdict,
} from '@libs/code-review/infrastructure/agents/core/verifier.agent';

const telemetry = {
    organizationId: 'org-1',
    teamId: 'team-1',
    pullRequestId: 42,
    repositoryId: 'repo-1',
};

function state(text: string, artifacts: RunState['artifacts'] = []): RunState {
    return {
        runId: 'r',
        agentId: 'verifier',
        status: 'completed',
        steps: [
            {
                index: 0,
                message: { role: 'assistant', content: text, toolCalls: [] },
            },
        ],
        artifacts,
        usage: {},
        trace: [],
    } as unknown as RunState;
}

describe('verifier recovery logs carry the caller telemetry', () => {
    beforeEach(() => {
        logCalls.length = 0;
        warnCalls.length = 0;
    });

    it('names the organization and the parse mode on a text recovery', () => {
        const v = extractVerdict(
            state('{"keep": false, "rationale": "r"}'),
            telemetry,
        );
        expect(v.parseMode).toBe('text');
        expect(logCalls).toHaveLength(1);
        expect(logCalls[0].metadata).toEqual({
            parseMode: 'text',
            keep: false,
            ...telemetry,
        });
    });

    it('names the organization on an off-schema envelope recovery', () => {
        const v = extractVerdict(
            state('', [
                {
                    type: VERIFY_DONE_TOOL,
                    payload: { shouldKeep: false, rationale: 'r' },
                },
            ] as RunState['artifacts']),
            telemetry,
        );
        expect(v.keep).toBe(false);
        expect(warnCalls).toHaveLength(1);
        expect(warnCalls[0].metadata).toMatchObject({
            organizationId: 'org-1',
            reason: expect.stringContaining('shouldKeep'),
        });
    });

    it('works with no telemetry — the eval and unit callers pass a RunState alone', () => {
        const v = extractVerdict(state('{"keep": false, "rationale": "r"}'));
        expect(v.keep).toBe(false);
        expect(logCalls[0].metadata).toEqual({
            parseMode: 'text',
            keep: false,
        });
    });
});
