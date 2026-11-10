jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: jest.fn(),
}));
import { randomUUID } from 'crypto';
import { MockLanguageModelV3 } from 'ai/test';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { resolveModelConfig } from '@libs/llm/model-invocation';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { RuntimeTestPlannerUseCase } from '@libs/runtime/api/application/use-cases/test-planner.use-case';
import { RuntimeModelTurnGatewayUseCase } from '@libs/runtime/api/application/use-cases/model-turn-gateway.use-case';
import { RuntimePlannerSourceUseCase } from '@libs/runtime/api/application/use-cases/planner-source.use-case';
import { ByokRuntimeModelTurnProvider } from '@libs/runtime/api/infrastructure/byok-model-turn.provider';
import { signRunToken } from '@libs/runtime/api/domain/run-token';
import {
    clock,
    config,
    InMemoryLlmUsage,
    NOW,
    run,
    SECRET,
    SEAL_KEY,
    storeWith,
} from '@libs/runtime/api/__tests__/fixtures';
import { canaryKeyFrom, HmacCanaryVault } from '@libs/runtime/canary';
import { sealingKeyFrom } from '@libs/runtime/run';
import type { RuntimeGitPort } from '@libs/runtime/api/domain/ports';
import { SealedSecretOpener } from '../secrets/sealed-tokens';
import { WorkerRunPlanClient } from './worker-plan-client';
import { HttpModelTurnClient } from './http-model-turn';
import { CanaryLeakError } from '../canary/canary';
import { RuntimeAgent } from './runtime-agent';
import { LlmBudgetExceededError, LlmUnavailableError } from './llm-gateway';

const plan = {
    probes: [
        {
            entryPoint: 'GET /orders',
            assertions: { kind: 'http', status: 200 },
            probe: {
                id: 'orders',
                purpose: 'orders list',
                expected: 'orders are listed',
                compare: ['status'],
                spec: {
                    kind: 'http',
                    target: { service: 'web', port: 3000 },
                    method: 'GET',
                    path: '/orders',
                    timeoutMs: 30000,
                },
            },
        },
    ],
    tests: [],
    claims: [],
    cannotProve: [],
};
function script() {
    const turns = [
        { tool: 'list_files', input: { path: '' } },
        { tool: 'read_file', input: { path: 'src/routes.ts' } },
        { tool: 'submit_plan', input: plan },
    ];
    const calls: any[] = [];
    const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
            calls.push(options);
            const t = turns[calls.length - 1];
            if (!t) throw new Error('unexpected extra model call');
            return {
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: `call-${calls.length}`,
                        toolName: t.tool,
                        input: JSON.stringify(t.input),
                    },
                ],
                finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                usage: {
                    inputTokens: {
                        total: 100,
                        noCache: 100,
                        cacheRead: 0,
                        cacheWrite: 0,
                    },
                    outputTokens: { total: 10, text: 10, reasoning: 0 },
                },
                warnings: [],
            };
        },
    } as any);
    (resolveModelConfig as jest.Mock).mockReturnValue({
        model,
        callOptions: {},
        providerOptions: {},
        modelName: 'mock',
        usageIdentity: {},
    });
    return calls;
}
class Receipts {
    rows = new Map<string, any>();
    async claim(key: string, fingerprint: string) {
        const old = this.rows.get(key);
        if (old) return { fresh: false as const, ...old };
        this.rows.set(key, { fingerprint });
        return { fresh: true as const };
    }
    async complete(key: string, _fingerprint: string, response: unknown) {
        this.rows.get(key).response = response;
    }
}
async function fixture(slot?: any) {
    const r = run({ state: 'testing' }),
        usage = new InMemoryLlmUsage();
    const cfg = config({
        llmBudget: {
            perRun: 500_000,
            perPullRequest: 1_000_000,
            perOrgPerDay: 5_000_000,
        },
    });
    const runs = await storeWith(r);
    const token = signRunToken(
        {
            runId: r.runId,
            attempt: 1,
            organizationId: r.organizationId,
            teamId: r.teamId,
            repositoryId: r.repositoryId,
            prNumber: r.prNumber,
            exp: NOW.getTime() / 1000 + 3600,
        },
        SECRET,
    );
    const secrets = new SealedSecretOpener(sealingKeyFrom(SEAL_KEY));
    const runToken = secrets.seal(token, r.runId);
    const vault = new HmacCanaryVault(canaryKeyFrom(sealingKeyFrom(SEAL_KEY)));
    const body = {
        runId: r.runId,
        round: 0,
        entryPoints: [{ id: 'GET /orders', kind: 'http_route' as const }],
        changedPaths: ['src/routes.ts'],
        diff: '--- src/routes.ts\n+++ src/routes.ts\n@@ -1 +1 @@\n-app.get("/orders", list)\n+app.get("/orders", changed)',
        targets: [{ service: 'web', port: 3000, kind: 'http' }],
        execLeft: 5,
        observations: [],
    };
    const git = {
        getPullRequestHead: async () => ({ headSha: r.headSha }),
        getPullRequestDiff: async () => ({
            files: [{ path: 'src/routes.ts', patch: '+changed' }],
            truncated: false,
        }),
        listFilesAtCommit: async () => ['src/routes.ts'],
        readFileAtCommit: async () => 'app.get("/orders", list);',
    } as unknown as RuntimeGitPort;
    const provider = new ByokRuntimeModelTurnProvider(
        { resolveTaskSlot: async () => slot },
        () => true,
    );
    const gateway = new RuntimeModelTurnGatewayUseCase(
        cfg,
        clock,
        runs,
        usage,
        provider,
        new Receipts(),
    );
    const source = new RuntimePlannerSourceUseCase(cfg, clock, runs, git);
    const fetchCalls: any[] = [];
    const fetch = async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init });
        try {
            const headers = init.headers as Record<string, string>;
            const input = {
                body: JSON.parse(init.body as string),
                authorization: headers.authorization,
            };
            const data = url.endsWith('/model-turn')
                ? await gateway.execute({
                      ...input,
                      sealedToken: headers['x-runtime-sealed-token'],
                      signal: init.signal ?? undefined,
                  })
                : await source.execute(input);
            return new Response(JSON.stringify({ data }), { status: 200 });
        } catch (e: any) {
            return new Response(
                JSON.stringify(e.getResponse?.() ?? { code: 'unavailable' }),
                { status: e.getStatus?.() ?? 500 },
            );
        }
    };
    const call = {
        runId: r.runId,
        attempt: 1,
        organizationId: r.organizationId,
        runToken,
        body,
    };
    const old = new RuntimeTestPlannerUseCase(
        cfg,
        clock,
        runs,
        new InMemoryLlmUsage(),
        git,
        {
            forOrganization: async () => ({
                runner: new AiSdkAgentRunner(undefined),
                model: 'mock',
            }),
        },
    );
    return {
        r,
        usage,
        token,
        runToken,
        body,
        fetch,
        fetchCalls,
        call,
        old,
        vault,
        secrets,
        git,
    };
}
describe('worker-hosted planner through production gateway', () => {
    it('runs the same core/tools/SDK loop and produces the same plan and usage as the API-hosted path', async () => {
        const h = await fixture();
        const oldCalls = script();
        const expected = await h.old.execute({
            authorization: `Bearer ${h.token}`,
            body: h.body,
        });
        const newCalls = script();
        const actual = await new WorkerRunPlanClient('https://product.test', {
            secrets: h.secrets,
            canaries: h.vault,
            fetch: h.fetch,
        }).plan(h.call);
        expect(actual).toEqual(expected);
        expect(actual.status).toBe('planned');
        expect(actual.usage).toEqual({ inputTokens: 300, outputTokens: 30 });
        expect(newCalls.map((c) => c.prompt)).toEqual(
            oldCalls.map((c) => c.prompt),
        );
        expect(newCalls.map((c) => c.tools)).toEqual(
            oldCalls.map((c) => c.tools),
        );
        expect(
            h.fetchCalls.filter((c) => c.url.endsWith('/model-turn')),
        ).toHaveLength(3);
        expect(await h.usage.totalForRun(h.r.runId)).toBe(330);
        const modelBodies = h.fetchCalls
            .filter((c) => c.url.endsWith('/model-turn'))
            .map((c) => c.init.body)
            .join('');
        expect(modelBodies).not.toContain(h.token);
        expect(modelBodies).not.toContain(h.runToken);
    });
    it('checks canaries before each outbound model turn and sends immutable transport context outside model frames', async () => {
        const h = await fixture();
        const fetch = jest.fn(async () => new Response('{}'));
        const client = new HttpModelTurnClient('https://product.test', {
            secrets: h.secrets,
            canaries: h.vault,
            fetch,
        });
        const request: any = {
            v: 1,
            scope: { runId: h.r.runId, attempt: 1, turnId: randomUUID() },
            task: 'runtime.plan',
            toolset: 'runtime-planner-v1',
            call: {
                tools: [],
                prompt: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: h.vault.forRun(h.call)[0].value,
                            },
                        ],
                    },
                ],
            },
        };
        await expect(
            client.complete({ ...h.call, request }),
        ).rejects.toBeInstanceOf(CanaryLeakError);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('refuses oversized streamed responses and never follows a redirect with authorization', async () => {
        const h = await fixture();
        const fetch = jest.fn(async (..._args: Parameters<typeof globalThis.fetch>) => new Response('x'.repeat(1_005_000)));
        const client = new HttpModelTurnClient('https://product.test', {
            secrets: h.secrets,
            canaries: h.vault,
            fetch,
        });
        const request: any = {
            v: 1,
            scope: { runId: h.r.runId, attempt: 1, turnId: randomUUID() },
            task: 'runtime.plan',
            toolset: 'runtime-planner-v1',
            call: {
                tools: [],
                prompt: [
                    {
                        role: 'user',
                        content: [{ type: 'text', text: 'bounded' }],
                    },
                ],
            },
        };
        await expect(
            client.complete({ ...h.call, request }),
        ).rejects.toBeInstanceOf(LlmUnavailableError);
        expect(fetch.mock.calls[0][1]).toMatchObject({
            redirect: 'error',
            headers: expect.objectContaining({
                'x-runtime-sealed-token': h.runToken,
            }),
        });
    });
    it.each([
        ['canary', new CanaryLeakError('llm_prompt')],
        ['budget', new LlmBudgetExceededError('fixture budget')],
    ] as const)(
        'preserves fatal %s through the real harness and RuntimeAgent rather than downgrading it to no_plan',
        async (_label, fatal) => {
            const h = await fixture();
            const client = new WorkerRunPlanClient('https://product.test', {
                secrets: h.secrets,
                canaries: h.vault,
                fetch: h.fetch,
                model: {
                    complete: async () => {
                        throw fatal;
                    },
                },
            });
            const agent = new RuntimeAgent(
                {
                    complete: async () => {
                        throw Error('legacy gateway must not run');
                    },
                },
                {} as any,
                client,
            );
            await expect(
                agent.plan({
                    runId: h.r.runId,
                    attempt: 1,
                    organizationId: h.r.organizationId,
                    runToken: h.runToken,
                    entryPoints: h.body.entryPoints as any,
                    diffSummary: h.body.diff,
                    files: [
                        {
                            path: 'src/routes.ts',
                            content: 'app.get("/orders", changed);',
                        },
                    ],
                    baseClaimId: 'claim-base',
                    targets: h.body.targets,
                    canaries: h.vault.forRun(h.call),
                }),
            ).rejects.toBe(fatal);
        },
    );
    it('forwards caller cancellation to an active model turn and preserves the cancellation reason', async () => {
        const h = await fixture(),
            controller = new AbortController();
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const reason = new Error('fixture caller cancellation');
        const model = {
            complete: async (turn: any): Promise<any> => {
                entered();
                return new Promise((_, reject) => {
                    if (turn.signal.aborted) reject(turn.signal.reason);
                    else
                        turn.signal.addEventListener(
                            'abort',
                            () => reject(turn.signal.reason),
                            { once: true },
                        );
                });
            },
        };
        const pending = new WorkerRunPlanClient('https://product.test', {
            secrets: h.secrets,
            canaries: h.vault,
            fetch: h.fetch,
            model,
        }).plan({ ...h.call, signal: controller.signal });
        await started;
        controller.abort(reason);
        await expect(pending).rejects.toBe(reason);
    });
});

it.each([
    'openai-chat',
    'anthropic',
    'openai-responses',
    'google',
    'vertex',
] as const)(
    'accepts real installed %s adapter metadata and preserves continuation signatures through worker/product loops',
    async (providerName) => {
        const h = await fixture();
        const requests: any[] = [];
        const fetch = async (_url: any, init: any) => {
            requests.push(JSON.parse(init.body));
            const index = requests.length;
            const action =
                index === 1
                    ? { name: 'list_files', input: { path: '' } }
                    : index === 2
                      ? { name: 'read_file', input: { path: 'src/routes.ts' } }
                      : { name: 'submit_plan', input: plan };
            const response =
                providerName === 'google' || providerName === 'vertex'
                    ? {
                          candidates: [
                              {
                                  content: {
                                      role: 'model',
                                      parts: [
                                          {
                                              functionCall: {
                                                  name: action.name,
                                                  args: action.input,
                                              },
                                              thoughtSignature:
                                                  'fixture-google-signature',
                                          },
                                      ],
                                  },
                                  finishReason: 'STOP',
                              },
                          ],
                          usageMetadata: {
                              promptTokenCount: 100,
                              candidatesTokenCount: 10,
                              totalTokenCount: 110,
                          },
                          modelVersion: 'fixture-model',
                      }
                    : providerName === 'openai-responses'
                      ? {
                            id: `resp-${index}`,
                            object: 'response',
                            created_at: 1,
                            model: 'gpt-4.1-mini',
                            status: 'completed',
                            error: null,
                            incomplete_details: null,
                            output: [
                                {
                                    type: 'reasoning',
                                    id: `rs-${index}`,
                                    encrypted_content:
                                        'fixture-encrypted-reasoning',
                                    summary: [
                                        {
                                            type: 'summary_text',
                                            text: 'bounded reasoning',
                                        },
                                    ],
                                },
                                {
                                    type: 'function_call',
                                    id: `fc-${index}`,
                                    call_id: `call-${index}`,
                                    name: action.name,
                                    arguments: JSON.stringify(action.input),
                                },
                            ],
                            usage: {
                                input_tokens: 100,
                                output_tokens: 10,
                                total_tokens: 110,
                                input_tokens_details: { cached_tokens: 0 },
                                output_tokens_details: { reasoning_tokens: 2 },
                            },
                        }
                      : providerName === 'openai-chat'
                        ? {
                              id: `chat-${index}`,
                              object: 'chat.completion',
                              created: 1,
                              model: 'fixture-model',
                              choices: [
                                  {
                                      index: 0,
                                      message: {
                                          role: 'assistant',
                                          content: null,
                                          tool_calls: [
                                              {
                                                  id: `call-${index}`,
                                                  type: 'function',
                                                  function: {
                                                      name: action.name,
                                                      arguments: JSON.stringify(
                                                          action.input,
                                                      ),
                                                  },
                                              },
                                          ],
                                      },
                                      finish_reason: 'tool_calls',
                                  },
                              ],
                              usage: {
                                  prompt_tokens: 100,
                                  completion_tokens: 10,
                                  total_tokens: 110,
                              },
                          }
                        : {
                              id: `msg-${index}`,
                              type: 'message',
                              role: 'assistant',
                              model: 'fixture-model',
                              content: [
                                  {
                                      type: 'thinking',
                                      thinking: 'bounded fixture reasoning',
                                      signature: 'fixture-signed-reasoning',
                                  },
                                  {
                                      type: 'tool_use',
                                      id: `call-${index}`,
                                      name: action.name,
                                      input: action.input,
                                  },
                              ],
                              stop_reason: 'tool_use',
                              stop_sequence: null,
                              usage: {
                                  input_tokens: 100,
                                  output_tokens: 10,
                                  cache_creation_input_tokens: 0,
                                  cache_read_input_tokens: 0,
                              },
                          };
            return new Response(JSON.stringify(response), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        };
        const model =
            providerName === 'google'
                ? createGoogleGenerativeAI({ apiKey: 'fixture-only', fetch })(
                      'gemini-2.5-flash',
                  )
                : providerName === 'vertex'
                  ? createVertex({ apiKey: 'fixture-only', fetch })(
                        'gemini-2.5-flash',
                    )
                  : providerName === 'openai-responses'
                    ? createOpenAI({ apiKey: 'fixture-only', fetch }).responses(
                          'gpt-4.1-mini',
                      )
                    : providerName === 'openai-chat'
                      ? createOpenAI({ apiKey: 'fixture-only', fetch }).chat(
                            'gpt-4.1-mini',
                        )
                      : createAnthropic({ apiKey: 'fixture-only', fetch })(
                            'claude-sonnet-4-5',
                        );
        (resolveModelConfig as jest.Mock).mockReturnValue({
            model,
            callOptions: {},
            providerOptions: {},
            modelName: 'fixture-model',
            usageIdentity: {},
            ...(providerName === 'openai-responses'
                ? { providerOptions: { openai: { store: false } } }
                : {}),
        });
        const actual = await new WorkerRunPlanClient('https://product.test', {
            secrets: h.secrets,
            canaries: h.vault,
            fetch: h.fetch,
        }).plan(h.call);
        expect(actual.status).toBe('planned');
        expect(actual.usage).toEqual({ inputTokens: 300, outputTokens: 30 });
        expect(requests).toHaveLength(3);
        if (providerName === 'google' || providerName === 'vertex')
            expect(JSON.stringify(requests[1].contents)).toContain(
                'fixture-google-signature',
            );
        if (providerName === 'openai-responses')
            expect(requests[1].input).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        type: 'reasoning',
                        id: 'rs-1',
                        encrypted_content: 'fixture-encrypted-reasoning',
                    }),
                ]),
            );
        if (providerName === 'anthropic')
            expect(requests[1].messages).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        role: 'assistant',
                        content: expect.arrayContaining([
                            expect.objectContaining({
                                type: 'thinking',
                                signature: 'fixture-signed-reasoning',
                            }),
                        ]),
                    }),
                ]),
            );
    },
);

it('propagates a planted canary returned by the actual product/provider boundary as a security failure', async () => {
    const h = await fixture();
    const bait = h.vault.forRun(h.call)[0].value;
    const model = new MockLanguageModelV3({
        doGenerate: async () => ({
            content: [{ type: 'text', text: bait }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 100 }, outputTokens: { total: 10 } },
            warnings: [],
        }),
    } as any);
    (resolveModelConfig as jest.Mock).mockReturnValue({
        model,
        callOptions: {},
        providerOptions: {},
        modelName: 'mock',
        usageIdentity: {},
    });
    await expect(
        new WorkerRunPlanClient('https://product.test', {
            secrets: h.secrets,
            canaries: h.vault,
            fetch: h.fetch,
        }).plan(h.call),
    ).rejects.toBeInstanceOf(CanaryLeakError);
    expect(await h.usage.totalForRun(h.r.runId)).toBe(110);
});
it('refuses a canary in a later source tool result before the next product model dispatch', async () => {
    const h = await fixture(),
        calls = script();
    h.git.readFileAtCommit = async () => h.vault.forRun(h.call)[0].value;
    await expect(
        new WorkerRunPlanClient('https://product.test', {
            secrets: h.secrets,
            canaries: h.vault,
            fetch: h.fetch,
        }).plan(h.call),
    ).rejects.toBeInstanceOf(CanaryLeakError);
    expect(calls).toHaveLength(2);
});
it('returns only measured numeric usage plus a partial marker when the gateway conservatively retained unmeasured usage', async () => {
    const h = await fixture();
    script();
    const fetch = async (url: string, init: RequestInit) => {
        const result = await h.fetch(url, init);
        if (!url.endsWith('/model-turn') || !result.ok) return result;
        const data: any = await result.json();
        data.data.budget = {
            remainingTokens: 10000,
            usageBasis: 'reservation',
            additionalUsageUnknown: true,
        };
        return new Response(JSON.stringify(data), { status: 200 });
    };
    const result = await new WorkerRunPlanClient('https://product.test', {
        secrets: h.secrets,
        canaries: h.vault,
        fetch,
    }).plan(h.call);
    expect(result.usage).toEqual({
        inputTokens: 300,
        outputTokens: 30,
        measurement: 'partial',
    });
});

it('leases failed primary and fallback independently, preserves measured usage identity and never raises the fallback output cap', async () => {
    const { APICallError } = await import('@ai-sdk/provider');
    const h = await fixture({
        provider: 'openai',
        model: 'primary',
        apiKey: 'fixture',
        maxOutputTokens: 4000,
        fallback: {
            provider: 'openai',
            model: 'fallback',
            apiKey: 'fixture',
            maxOutputTokens: 64000,
        },
    });
    const caps: number[] = [];
    const primary = new MockLanguageModelV3({
        modelId: 'primary-model',
        doGenerate: async (options: any) => {
            caps.push(options.maxOutputTokens);
            throw new APICallError({
                message: 'fixture key rejected',
                url: 'https://provider.test',
                requestBodyValues: {},
                statusCode: 401,
                isRetryable: false,
            });
        },
    } as any);
    let turn = 0;
    const fallback = new MockLanguageModelV3({
        modelId: 'fallback-model',
        doGenerate: async (options: any) => {
            caps.push(options.maxOutputTokens);
            const action =
                ++turn === 1
                    ? { name: 'list_files', input: { path: '' } }
                    : turn === 2
                      ? { name: 'read_file', input: { path: 'src/routes.ts' } }
                      : { name: 'submit_plan', input: plan };
            return {
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: `call-${turn}`,
                        toolName: action.name,
                        input: JSON.stringify(action.input),
                    },
                ],
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: {
                    inputTokens: { total: 100 },
                    outputTokens: { total: 10 },
                },
                warnings: [],
            };
        },
    } as any);
    (resolveModelConfig as jest.Mock).mockImplementation((slot: any) => ({
        model: slot.model === 'primary' ? primary : fallback,
        callOptions: { maxOutputTokens: slot.maxOutputTokens },
        providerOptions: {},
        modelName: slot.model,
        usageIdentity: {},
    }));
    const result = await new WorkerRunPlanClient('https://product.test', {
        secrets: h.secrets,
        canaries: h.vault,
        fetch: h.fetch,
    }).plan(h.call);
    expect(result.status).toBe('planned');
    expect(result.usage).toEqual({
        inputTokens: 300,
        outputTokens: 30,
        measurement: 'partial',
    });
    expect(caps).toHaveLength(6);
    expect(caps.every((cap) => cap <= 8192)).toBe(true);
    expect(
        h.usage.rows.filter((row) => !row.pending).map((row) => row.model),
    ).toEqual(['fallback-model', 'fallback-model', 'fallback-model']);
    expect(h.usage.rows.filter((row) => row.pending)).toHaveLength(3);
});

it('accounts hidden SDK tool repair through the actual product provider and returns its measured subtotal to the worker', async () => {
    const h = await fixture(),
        rawCalls: any[] = [];
    const model = new MockLanguageModelV3({
        modelId: 'repair-model',
        doGenerate: async (options: any) => {
            rawCalls.push(options);
            const n = rawCalls.length;
            const content =
                n === 1
                    ? [
                          {
                              type: 'tool-call',
                              toolCallId: 'read',
                              toolName: 'read_file',
                              input: '{broken',
                          },
                      ]
                    : n === 2
                      ? [{ type: 'text', text: '{"path":"src/routes.ts"}' }]
                      : [
                            {
                                type: 'tool-call',
                                toolCallId: 'plan',
                                toolName: 'submit_plan',
                                input: JSON.stringify(plan),
                            },
                        ];
            return {
                content,
                finishReason: {
                    unified: n === 2 ? 'stop' : 'tool-calls',
                    raw: 'stop',
                },
                usage: {
                    inputTokens: { total: 100 },
                    outputTokens: { total: 10 },
                },
                warnings: [],
            };
        },
    } as any);
    (resolveModelConfig as jest.Mock).mockReturnValue({
        model,
        callOptions: {},
        providerOptions: {},
        modelName: 'repair-model',
        usageIdentity: {},
    });
    const result = await new WorkerRunPlanClient('https://product.test', {
        secrets: h.secrets,
        canaries: h.vault,
        fetch: h.fetch,
    }).plan(h.call);
    expect(result.status).toBe('planned');
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 30 });
    expect(rawCalls).toHaveLength(3);
    expect(rawCalls[1].responseFormat.type).toBe('json');
    expect(
        h.fetchCalls.filter((call) => call.url.endsWith('/model-turn')),
    ).toHaveLength(2);
    expect(
        h.usage.rows.filter((row) => !row.pending).map((row) => row.model),
    ).toEqual(['repair-model', 'repair-model', 'repair-model']);
    expect(await h.usage.totalForRun(h.r.runId)).toBe(330);
});
