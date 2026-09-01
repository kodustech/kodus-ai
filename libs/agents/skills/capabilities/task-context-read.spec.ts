import { fetchTaskContext } from './task-context-read';
import type {
    CapabilityExecutionTrace,
    SkillCapabilityRuntimeConfig,
    ToolCaller,
} from '../runtime/skill-runtime.types';
import type { TaskContextReadParams } from './task-context/task-context.types';
import type { TaskContextReadHooks } from './task-context-read';

/**
 * Mutation-killing tests for the deterministic orchestration in
 * task-context-read.ts, driven through the only public entry point
 * (fetchTaskContext). They pin: candidate/reference assembly, the
 * URL/hostname derived hints, the seed/allowlist/exclusion tool filtering,
 * the deterministic-vs-agentic selection order, trace status/reason literals,
 * and the learned-tool persistence boundary.
 */

const CAPABILITY = 'task.context.read';

interface LlmToolShape {
    name?: string;
    parameters?: unknown;
}

/** A registered tool plus its optional LLM-facing input schema. */
function tool(name: string, parameters?: unknown): LlmToolShape {
    return { name, parameters };
}

interface ToolCallerConfig {
    registered: LlmToolShape[];
    /** Per-tool behaviour: a result payload, or a function to run. */
    callTool?: (
        name: string,
        args: Record<string, unknown>,
    ) => { result?: unknown } | Promise<{ result?: unknown }>;
    callAgent?: (
        agentName: string,
        prompt: string,
    ) => { result?: unknown } | Promise<{ result?: unknown }>;
    /** When false, omit callAgent from the ToolCaller entirely. */
    withAgent?: boolean;
}

function makeToolCaller(config: ToolCallerConfig): {
    caller: ToolCaller;
    callTool: jest.Mock;
    callAgent: jest.Mock;
} {
    const callTool = jest.fn(
        async (name: string, args: Record<string, unknown>) => {
            if (config.callTool) {
                return await config.callTool(name, args);
            }
            return { result: undefined };
        },
    );
    const callAgent = jest.fn(async (agentName: string, prompt: string) => {
        if (config.callAgent) {
            return await config.callAgent(agentName, prompt);
        }
        return { result: undefined };
    });

    const caller: ToolCaller = {
        callTool: callTool as unknown as ToolCaller['callTool'],
        getRegisteredTools: () =>
            config.registered.map((t) => ({ name: t.name })),
        getToolsForLLM: () => config.registered,
    };
    if (config.withAgent !== false) {
        caller.callAgent = callAgent as unknown as ToolCaller['callAgent'];
    }

    return { caller, callTool, callAgent };
}

function makeParams(
    overrides: Partial<TaskContextReadParams> = {},
): TaskContextReadParams {
    return {
        skillName: 'skill-x',
        organizationId: 'org-1',
        teamId: 'team-1',
        ...overrides,
    };
}

function makeRuntime(
    overrides: Partial<SkillCapabilityRuntimeConfig> = {},
): SkillCapabilityRuntimeConfig {
    return {
        providerType: 'jira',
        ...overrides,
    } as SkillCapabilityRuntimeConfig;
}

/** Signature that accepts any args and always builds a single empty-arg call. */
const EMPTY_SIG = { properties: {}, required: [] };

/** A tool result that normalizes to a usable task context. */
function usablePayload(overrides: Record<string, unknown> = {}) {
    return {
        result: {
            title: 'Add OAuth',
            description:
                'Implement OAuth login so users can authenticate on the dashboard.',
            ...overrides,
        },
    };
}

function calledToolNames(callTool: jest.Mock): string[] {
    return callTool.mock.calls.map((call) => call[0] as string);
}

function findTrace(
    traces: CapabilityExecutionTrace[],
    predicate: Partial<CapabilityExecutionTrace>,
): CapabilityExecutionTrace | undefined {
    return traces.find((trace) =>
        Object.entries(predicate).every(
            ([key, value]) => (trace as Record<string, unknown>)[key] === value,
        ),
    );
}

describe('fetchTaskContext', () => {
    describe('no-candidate short-circuit and base trace assembly', () => {
        it('returns an empty result with an exact skipped/no_candidate_tools trace and defaults provider to "external"', async () => {
            const { caller, callTool, callAgent } = makeToolCaller({
                registered: [],
            });
            const recordExecution = jest.fn(async () => {});

            const result = await fetchTaskContext(
                caller,
                makeRuntime({ providerType: '' }),
                makeParams(),
                { recordExecution },
            );

            expect(result.normalized).toBeUndefined();
            expect(result.raw).toBe('');
            expect(result.traces).toHaveLength(1);
            expect(result.traces[0]).toEqual({
                organizationId: 'org-1',
                teamId: 'team-1',
                skillName: 'skill-x',
                capability: CAPABILITY,
                provider: 'external',
                mode: 'deterministic',
                toolName: undefined,
                occurredAt: expect.any(String),
                status: 'skipped',
                reason: 'no_candidate_tools',
                latencyMs: 0,
            });
            expect(recordExecution).toHaveBeenCalledTimes(1);
            expect(recordExecution).toHaveBeenCalledWith(result.traces[0]);
            // No tools registered => nothing executed.
            expect(callTool).not.toHaveBeenCalled();
            expect(callAgent).not.toHaveBeenCalled();
        });

        it('carries the configured providerType into the trace when it is set', async () => {
            const { caller } = makeToolCaller({ registered: [] });

            const result = await fetchTaskContext(
                caller,
                makeRuntime({ providerType: 'notion' }),
                makeParams(),
            );

            expect(result.traces[0].provider).toBe('notion');
        });

        it('treats blank/missing tool names as no registered tools', async () => {
            const { caller } = makeToolCaller({
                // getRegisteredTools maps by name; these all resolve to blank.
                registered: [{ name: '' }, { name: '   ' }, {}],
            });

            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams(),
            );

            expect(result.normalized).toBeUndefined();
            expect(result.traces[0].reason).toBe('no_candidate_tools');
        });
    });

    describe('deterministic resolution', () => {
        it('resolves a usable context, stamps sourceProvider, and returns the description as raw', async () => {
            const { caller, callTool } = makeToolCaller({
                registered: [tool('getIssue', EMPTY_SIG)],
                callTool: () => usablePayload(),
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getIssue'],
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime({ providerType: 'jira' }),
                makeParams(),
                hooks,
            );

            expect(callTool).toHaveBeenCalledWith('getIssue', {});
            expect(result.normalized?.title).toBe('Add OAuth');
            expect(result.normalized?.description).toBe(
                'Implement OAuth login so users can authenticate on the dashboard.',
            );
            expect(result.normalized?.sourceProvider).toBe('jira');
            expect(result.raw).toBe(
                'Implement OAuth login so users can authenticate on the dashboard.',
            );
            const success = findTrace(result.traces, {
                mode: 'deterministic',
                toolName: 'getIssue',
                status: 'success',
            });
            expect(success).toBeDefined();
            expect(success?.reason).toBeUndefined();
        });

        it('assembles reference args from PR text: extracts the issue key and passes it to the tool', async () => {
            const { caller, callTool } = makeToolCaller({
                registered: [
                    tool('getJiraIssue', {
                        properties: { issueKey: { type: 'string' } },
                        required: ['issueKey'],
                    }),
                ],
                callTool: () => usablePayload(),
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getJiraIssue'],
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams({
                    pullRequestDescription:
                        'Implements PROJ-123 for the login flow.',
                }),
                hooks,
            );

            expect(callTool).toHaveBeenCalledWith('getJiraIssue', {
                issueKey: 'PROJ-123',
            });
            expect(result.normalized?.description).toContain('OAuth');
        });

        it('derives siteUrls (protocol//host) and urlHosts (bare host) from a task URL and offers both as context args', async () => {
            const { caller, callTool } = makeToolCaller({
                registered: [
                    tool('getJiraIssue', {
                        properties: {
                            cloudId: { type: 'string' },
                            issueKey: { type: 'string' },
                        },
                        required: ['cloudId', 'issueKey'],
                    }),
                ],
                // Return nothing so every arg combination is attempted.
                callTool: () => ({ result: {} }),
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getJiraIssue'],
            };

            await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams({
                    enableAgenticFallback: false,
                    pullRequestDescription:
                        'See https://acme.atlassian.net/browse/PROJ-123 for details.',
                }),
                hooks,
            );

            const argSets = callTool.mock.calls.map((call) => call[1]);
            // siteUrls candidate: `${protocol}//${hostname}`
            expect(argSets).toContainEqual({
                cloudId: 'https://acme.atlassian.net',
                issueKey: 'PROJ-123',
            });
            // urlHosts candidate: bare hostname
            expect(argSets).toContainEqual({
                cloudId: 'acme.atlassian.net',
                issueKey: 'PROJ-123',
            });
        });

        it('keeps the richest scored candidate across tools and returns first usable one', async () => {
            const calls: string[] = [];
            const { caller, callTool } = makeToolCaller({
                registered: [
                    tool('weakTool', EMPTY_SIG),
                    tool('strongTool', EMPTY_SIG),
                ],
                callTool: (name) => {
                    calls.push(name);
                    // weakTool returns an unusable (structured-metadata) description
                    // so resolution keeps scanning; strongTool returns real prose.
                    if (name === 'weakTool') {
                        return {
                            result: {
                                description:
                                    '{"type":"doc","content":[{"attrs":{}}]}',
                            },
                        };
                    }
                    return usablePayload();
                },
            });
            const hooks: TaskContextReadHooks = {
                getCachedTaskContextTools: async () => [],
                // No seed/preferred: exploration order = registration order.
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams({ enableAgenticFallback: false }),
                hooks,
            );

            expect(calledToolNames(callTool)).toEqual([
                'weakTool',
                'strongTool',
            ]);
            expect(result.normalized?.title).toBe('Add OAuth');
        });
    });

    describe('candidate tool filtering', () => {
        it('only calls seed-allowlisted tools, never a registered tool outside the allowlist', async () => {
            const { caller, callTool } = makeToolCaller({
                registered: [
                    tool('getIssue', EMPTY_SIG),
                    tool('searchStuff', EMPTY_SIG),
                ],
                // getIssue yields nothing usable; searchStuff WOULD succeed if reached.
                callTool: (name) =>
                    name === 'searchStuff' ? usablePayload() : { result: {} },
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getIssue'],
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams({ enableAgenticFallback: false }),
                hooks,
            );

            expect(calledToolNames(callTool)).toContain('getIssue');
            expect(calledToolNames(callTool)).not.toContain('searchStuff');
            expect(result.normalized).toBeUndefined();
        });

        it('drops tools listed in excludedTools', async () => {
            const { caller, callTool } = makeToolCaller({
                registered: [
                    tool('getIssue', EMPTY_SIG),
                    tool('searchStuff', EMPTY_SIG),
                ],
                callTool: (name) =>
                    name === 'searchStuff' ? usablePayload() : { result: {} },
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => [
                    'getIssue',
                    'searchStuff',
                ],
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams({
                    enableAgenticFallback: false,
                    excludedTools: ['searchStuff'],
                }),
                hooks,
            );

            expect(calledToolNames(callTool)).toContain('getIssue');
            expect(calledToolNames(callTool)).not.toContain('searchStuff');
            expect(result.normalized).toBeUndefined();
        });

        it('matches a cached tool alias against the registered camelCase tool and skips exploration', async () => {
            const { caller, callTool } = makeToolCaller({
                registered: [
                    tool('getIssue', EMPTY_SIG),
                    tool('searchStuff', EMPTY_SIG),
                ],
                callTool: () => ({ result: {} }),
            });
            const hooks: TaskContextReadHooks = {
                // 'get_issue' is an alias of the registered 'getIssue'.
                getCachedTaskContextTools: async () => ['get_issue'],
            };

            await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams({ enableAgenticFallback: false }),
                hooks,
            );

            // Cached path resolves to getIssue; exploration is suppressed, so
            // searchStuff is never tried.
            expect(calledToolNames(callTool)).toEqual(['getIssue']);
        });
    });

    describe('candidate ordering', () => {
        it('tries the preferred tool before the cached tool', async () => {
            const { caller, callTool } = makeToolCaller({
                registered: [
                    tool('prefTool', EMPTY_SIG),
                    tool('cacheTool', EMPTY_SIG),
                ],
                callTool: () => ({ result: {} }),
            });
            const hooks: TaskContextReadHooks = {
                resolvePreferredTool: async () => 'prefTool',
                getCachedTaskContextTools: async () => ['cacheTool'],
            };

            await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams({ enableAgenticFallback: false }),
                hooks,
            );

            expect(calledToolNames(callTool)).toEqual([
                'prefTool',
                'cacheTool',
            ]);
        });

        it('explores all candidate tools in registration order when there is no seed/preferred/cached signal', async () => {
            const { caller, callTool } = makeToolCaller({
                registered: [
                    tool('toolA', EMPTY_SIG),
                    tool('toolB', EMPTY_SIG),
                ],
                callTool: () => ({ result: {} }),
            });

            await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams({ enableAgenticFallback: false }),
                {},
            );

            expect(calledToolNames(callTool)).toEqual(['toolA', 'toolB']);
        });
    });

    describe('provider seeding', () => {
        it('seeds tools for the primary provider and every declared provider type, deduped', async () => {
            const { caller } = makeToolCaller({ registered: [] });
            const getSeedTaskContextTools = jest.fn(async () => []);

            await fetchTaskContext(
                caller,
                makeRuntime({
                    providerType: 'jira',
                    allProviderTypes: ['jira', 'notion'],
                }),
                makeParams(),
                { getSeedTaskContextTools },
            );

            const seededProviders = getSeedTaskContextTools.mock.calls.map(
                (call) => call[0],
            );
            expect(seededProviders).toEqual(['jira', 'notion']);
            getSeedTaskContextTools.mock.calls.forEach((call) => {
                expect(call[1]).toBe(CAPABILITY);
            });
        });

        it('seeds only the primary provider when no other provider types are declared', async () => {
            const { caller } = makeToolCaller({ registered: [] });
            const getSeedTaskContextTools = jest.fn(async () => []);

            await fetchTaskContext(
                caller,
                makeRuntime({ providerType: 'jira' }),
                makeParams(),
                { getSeedTaskContextTools },
            );

            const seededProviders = getSeedTaskContextTools.mock.calls.map(
                (call) => call[0],
            );
            expect(seededProviders).toEqual(['jira']);
        });
    });

    describe('deterministic-vs-agentic selection', () => {
        it('in agent_first mode returns the agentic result and never runs the deterministic tool', async () => {
            const { caller, callTool, callAgent } = makeToolCaller({
                registered: [tool('getIssue', EMPTY_SIG)],
                callTool: () => usablePayload(),
                callAgent: () => ({
                    result: {
                        taskContext: 'Real task prose describing the feature.',
                        title: 'T',
                        id: 'ID-1',
                        toolsUsed: ['getIssue'],
                    },
                }),
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getIssue'],
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime({ providerType: 'jira' }),
                makeParams({ taskContextResolutionMode: 'agent_first' }),
                hooks,
            );

            expect(callAgent).toHaveBeenCalledTimes(1);
            expect(callTool).not.toHaveBeenCalled();
            expect(result.normalized).toEqual({
                id: 'ID-1',
                title: 'T',
                description: 'Real task prose describing the feature.',
                sourceProvider: 'jira',
            });
            expect(result.raw).toBe('Real task prose describing the feature.');
        });

        it('falls back to the agent when deterministic resolution yields nothing', async () => {
            const { caller, callTool, callAgent } = makeToolCaller({
                registered: [tool('getIssue', EMPTY_SIG)],
                callTool: () => ({ result: {} }),
                callAgent: () => ({
                    result: {
                        taskContext: 'Agent-resolved prose for the task.',
                        toolsUsed: [],
                    },
                }),
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getIssue'],
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams(),
                hooks,
            );

            expect(callTool).toHaveBeenCalled();
            expect(callAgent).toHaveBeenCalledTimes(1);
            expect(result.normalized?.description).toBe(
                'Agent-resolved prose for the task.',
            );
        });

        it('does not invoke the agent when agentic fallback is disabled', async () => {
            const { caller, callTool, callAgent } = makeToolCaller({
                registered: [tool('getIssue', EMPTY_SIG)],
                callTool: () => ({ result: {} }),
                callAgent: () => usablePayload(),
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getIssue'],
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams({ enableAgenticFallback: false }),
                hooks,
            );

            expect(callTool).toHaveBeenCalled();
            expect(callAgent).not.toHaveBeenCalled();
            expect(result.normalized).toBeUndefined();
            expect(result.raw).toBe('');
        });

        it('discards an unusable agentic result (fetch-failure text) instead of surfacing it', async () => {
            const { caller, callAgent } = makeToolCaller({
                registered: [tool('getIssue', EMPTY_SIG)],
                callTool: () => ({ result: {} }),
                callAgent: () => ({
                    result: {
                        taskContext:
                            'Failed to fetch issue: status 404 not found',
                        toolsUsed: [],
                    },
                }),
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getIssue'],
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams(),
                hooks,
            );

            expect(callAgent).toHaveBeenCalledTimes(1);
            expect(result.normalized).toBeUndefined();
            expect(result.raw).toBe('');
        });
    });

    describe('deterministic trace status/reason mapping', () => {
        async function runSingleTool(
            callTool: ToolCallerConfig['callTool'],
        ): Promise<CapabilityExecutionTrace[]> {
            const { caller } = makeToolCaller({
                registered: [tool('getIssue', EMPTY_SIG)],
                callTool,
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getIssue'],
            };
            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams({ enableAgenticFallback: false }),
                hooks,
            );
            return result.traces;
        }

        it('marks a result with no extractable context as failed/empty_result', async () => {
            const traces = await runSingleTool(() => ({ result: {} }));
            const trace = findTrace(traces, {
                mode: 'deterministic',
                toolName: 'getIssue',
            });
            expect(trace?.status).toBe('failed');
            expect(trace?.reason).toBe('empty_result');
        });

        it('marks an undefined tool result as failed/missing_result', async () => {
            const traces = await runSingleTool(() => ({ result: undefined }));
            const trace = findTrace(traces, {
                mode: 'deterministic',
                toolName: 'getIssue',
            });
            expect(trace?.status).toBe('failed');
            expect(trace?.reason).toBe('missing_result');
        });

        it('marks a thrown tool call as failed/execution_error', async () => {
            const traces = await runSingleTool(() => {
                throw new Error('boom');
            });
            const trace = findTrace(traces, {
                mode: 'deterministic',
                toolName: 'getIssue',
            });
            expect(trace?.status).toBe('failed');
            expect(trace?.reason).toBe('execution_error');
        });
    });

    describe('agentic trace status/reason mapping', () => {
        it('records agentic_unavailable (skipped) when callAgent is not provided', async () => {
            const { caller } = makeToolCaller({
                registered: [tool('getIssue', EMPTY_SIG)],
                callTool: () => ({ result: {} }),
                withAgent: false,
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getIssue'],
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams(),
                hooks,
            );

            const trace = findTrace(result.traces, { mode: 'agentic' });
            expect(trace?.status).toBe('skipped');
            expect(trace?.reason).toBe('agentic_unavailable');
        });

        it('records agentic_empty_result (failed) when the agent returns no task context', async () => {
            const { caller } = makeToolCaller({
                registered: [tool('getIssue', EMPTY_SIG)],
                callTool: () => ({ result: {} }),
                // Defensive parse: numeric taskContext / non-array toolsUsed => empty.
                callAgent: () => ({
                    result: { taskContext: 12345, toolsUsed: 'nope' },
                }),
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getIssue'],
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams(),
                hooks,
            );

            const trace = findTrace(result.traces, { mode: 'agentic' });
            expect(trace?.status).toBe('failed');
            expect(trace?.reason).toBe('agentic_empty_result');
            expect(trace?.toolName).toBeUndefined();
        });

        it('records agentic_execution_error (failed) when the agent throws', async () => {
            const { caller } = makeToolCaller({
                registered: [tool('getIssue', EMPTY_SIG)],
                callTool: () => ({ result: {} }),
                callAgent: () => {
                    throw new Error('agent down');
                },
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getIssue'],
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams(),
                hooks,
            );

            const trace = findTrace(result.traces, { mode: 'agentic' });
            expect(trace?.status).toBe('failed');
            expect(trace?.reason).toBe('agentic_execution_error');
        });

        it('parses an agent JSON string result and filters non-string toolsUsed entries', async () => {
            const saveCachedTaskContextTools = jest.fn(async () => {});
            const { caller } = makeToolCaller({
                registered: [tool('getIssue', EMPTY_SIG)],
                callAgent: () => ({
                    result: JSON.stringify({
                        taskContext: 'Prose from a JSON string result.',
                        toolsUsed: ['getIssue', '', 5],
                    }),
                }),
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getIssue'],
                saveCachedTaskContextTools,
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams({ taskContextResolutionMode: 'agent_first' }),
                hooks,
            );

            expect(result.normalized?.description).toBe(
                'Prose from a JSON string result.',
            );
            // Only the valid, registered, candidate tool name is persisted.
            expect(saveCachedTaskContextTools).toHaveBeenCalledWith(
                expect.objectContaining({ capability: CAPABILITY }),
                ['getIssue'],
            );
        });
    });

    describe('learned-tool persistence boundary', () => {
        it('persists the learned tool merged with cached tools, deduped and learned-first', async () => {
            const saveCachedTaskContextTools = jest.fn(async () => {});
            const { caller } = makeToolCaller({
                registered: [
                    tool('getIssue', EMPTY_SIG),
                    tool('someCachedTool', EMPTY_SIG),
                ],
                callTool: (name) =>
                    name === 'getIssue' ? usablePayload() : { result: {} },
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getIssue'],
                getCachedTaskContextTools: async () => ['someCachedTool'],
                saveCachedTaskContextTools,
            };

            await fetchTaskContext(caller, makeRuntime(), makeParams(), hooks);

            expect(saveCachedTaskContextTools).toHaveBeenCalledWith(
                {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                    skillName: 'skill-x',
                    capability: CAPABILITY,
                    provider: 'jira',
                },
                ['getIssue', 'someCachedTool'],
            );
        });

        it('does not persist a learned tool that is not a registered candidate', async () => {
            const saveCachedTaskContextTools = jest.fn(async () => {});
            const { caller } = makeToolCaller({
                registered: [tool('getIssue', EMPTY_SIG)],
                callAgent: () => ({
                    result: {
                        taskContext: 'Usable prose from the agent path here.',
                        // ghostTool is not registered => outside the boundary.
                        toolsUsed: ['ghostTool'],
                    },
                }),
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getIssue'],
                saveCachedTaskContextTools,
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams({ taskContextResolutionMode: 'agent_first' }),
                hooks,
            );

            expect(result.normalized?.description).toBe(
                'Usable prose from the agent path here.',
            );
            expect(saveCachedTaskContextTools).not.toHaveBeenCalled();
        });

        it('does not throw when no save hook is provided on a successful resolution', async () => {
            const { caller } = makeToolCaller({
                registered: [tool('getIssue', EMPTY_SIG)],
                callTool: () => usablePayload(),
            });
            const hooks: TaskContextReadHooks = {
                getSeedTaskContextTools: async () => ['getIssue'],
            };

            const result = await fetchTaskContext(
                caller,
                makeRuntime(),
                makeParams(),
                hooks,
            );

            expect(result.normalized?.description).toContain('OAuth');
        });
    });
});
