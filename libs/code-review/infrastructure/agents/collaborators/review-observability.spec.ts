/**
 * runAgentWithTrace wraps the leaf that may run the model in a Langfuse span.
 * Its contract: whatever `fn` resolves to comes back unchanged (tracing on or
 * off), a leaf failure propagates, and `meta` becomes the exact
 * `propagateAttributes` config (org/team defaults, PR stringing, sessionId).
 *
 * Only `@langfuse/tracing` is mocked, so the real `shouldTrace` /
 * `pullRequestSessionId` derivation runs.
 */

const mockState: {
    propagate: any[];
    observationNames: string[];
    spanUpdateArgs: any[];
} = {
    propagate: [],
    observationNames: [],
    spanUpdateArgs: [],
};

jest.mock('@langfuse/tracing', () => ({
    propagateAttributes: (params: any, fn: () => unknown) => {
        mockState.propagate.push(params);
        return fn();
    },
    startActiveObservation: (name: string, cb: (span: any) => unknown) => {
        mockState.observationNames.push(name);
        const span = {
            update: (arg: any) => {
                mockState.spanUpdateArgs.push(arg);
            },
        };
        return cb(span);
    },
}));

import { runAgentWithTrace } from './review-observability';

const originalEnv = { ...process.env };

function enableTracing() {
    process.env.LANGFUSE_TRACING = 'true';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';
}

function disableTracing() {
    delete process.env.LANGFUSE_TRACING;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockState.propagate = [];
    mockState.observationNames = [];
    mockState.spanUpdateArgs = [];
});

afterEach(() => {
    process.env = { ...originalEnv };
});

describe('runAgentWithTrace — transparency and failure', () => {
    const baseMeta = { traceName: 'code-review-finder' };

    it('returns the fn value unchanged and opens no span when tracing is off', async () => {
        disableTracing();
        const value = { result: { findings: [] } };

        const result = await runAgentWithTrace(baseMeta, { in: 1 }, async () => value);

        expect(result).toBe(value);
        expect(mockState.propagate).toHaveLength(0);
        expect(mockState.observationNames).toHaveLength(0);
    });

    it('returns the fn value unchanged and records input then output on the span', async () => {
        enableTracing();
        const value = { result: { findings: [] } };

        const result = await runAgentWithTrace(baseMeta, { in: 1 }, async () => value);

        expect(result).toBe(value);
        expect(mockState.observationNames).toEqual(['code-review-finder']);
        expect(mockState.spanUpdateArgs).toHaveLength(2);
        expect(mockState.spanUpdateArgs[0]).toEqual({ input: { in: 1 } });
        expect(mockState.spanUpdateArgs[1].output).toBe(value);
    });

    it('propagates a leaf failure when tracing is off', async () => {
        disableTracing();
        const err = new Error('model network timeout');
        await expect(
            runAgentWithTrace(baseMeta, {}, async () => {
                throw err;
            }),
        ).rejects.toBe(err);
    });

    it('propagates a leaf failure through the open span', async () => {
        enableTracing();
        const err = new Error('model 500');
        await expect(
            runAgentWithTrace(baseMeta, {}, async () => {
                throw err;
            }),
        ).rejects.toBe(err);
        expect(mockState.spanUpdateArgs[0]).toEqual({ input: {} });
    });
});

describe('runAgentWithTrace — trace-metadata assembly', () => {
    beforeEach(enableTracing);

    // Required identity fields absent: fixed placeholders, never the string
    // "undefined", and userId mirrors org.
    it('defaults absent org/team to fixed placeholders and mirrors userId', async () => {
        await runAgentWithTrace(
            { traceName: 'code-review-finder' },
            {},
            async () => 'ok',
        );

        const cfg = mockState.propagate[0];
        expect(cfg.metadata.organizationId).toBe('unknown_org');
        expect(cfg.metadata.teamId).toBe('unknown_team');
        expect(cfg.userId).toBe('unknown_org');
        // No PR -> no session invented, and prNumber/pullRequestId omitted.
        expect(cfg.sessionId).toBeUndefined();
        expect(cfg.metadata.prNumber).toBeUndefined();
        expect(cfg.metadata.pullRequestId).toBeUndefined();
        expect(cfg.metadata.repositoryId).toBeUndefined();
    });

    it('threads a full meta into the propagate config and derives the session key', async () => {
        await runAgentWithTrace(
            {
                traceName: 'code-review-verify',
                organizationId: 'org-1',
                teamId: 'team-9',
                prNumber: 42,
                repositoryId: 'repo-7',
            },
            {},
            async () => 'ok',
        );

        const cfg = mockState.propagate[0];
        expect(cfg.traceName).toBe('code-review-verify');
        expect(cfg.userId).toBe('org-1');
        expect(cfg.metadata).toMatchObject({
            organizationId: 'org-1',
            teamId: 'team-9',
            prNumber: '42', // stringified
            pullRequestId: '42', // stringified alias
            repositoryId: 'repo-7',
        });
        // Session key derives from the SAME helper every agent shares.
        expect(cfg.sessionId).toBe('org-1:repo-7:42');
    });

    it('omits prNumber/pullRequestId and the session when prNumber is falsy (PR 0 is "no PR")', async () => {
        await runAgentWithTrace(
            { traceName: 'code-review-finder', organizationId: 'org-1', prNumber: 0 },
            {},
            async () => 'ok',
        );

        const cfg = mockState.propagate[0];
        expect(cfg.metadata.prNumber).toBeUndefined();
        expect(cfg.metadata.pullRequestId).toBeUndefined();
        expect(cfg.sessionId).toBeUndefined();
    });

    it('derives the session with a repo placeholder when only org+pr are known', async () => {
        await runAgentWithTrace(
            { traceName: 'code-review-finder', organizationId: 'org-1', prNumber: 7 },
            {},
            async () => 'ok',
        );

        expect(mockState.propagate[0].sessionId).toBe('org-1:repo:7');
        expect(mockState.propagate[0].metadata.repositoryId).toBeUndefined();
    });
});
