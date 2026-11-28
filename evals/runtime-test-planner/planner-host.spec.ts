import { randomBytes } from 'crypto';
import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { RuntimeModelTurnGatewayUseCase } from '@libs/runtime/api/application/use-cases/model-turn-gateway.use-case';
import { RuntimePlannerSourceUseCase } from '@libs/runtime/api/application/use-cases/planner-source.use-case';
import { loadRuntimeApiConfig } from '@libs/runtime/api/infrastructure/runtime-api.config';
import { signRunToken } from '@libs/runtime/api/domain/run-token';
import {
    InMemoryLlmUsage,
    run,
    storeWith,
    NOW,
} from '@libs/runtime/api/__tests__/fixtures';
import { HmacCanaryVault, canaryKeyFrom } from '@libs/runtime/canary';
import { SealedSecretOpener } from '../../apps/runtime/src/worker/secrets/sealed-tokens';
import { WorkerRunPlanClient } from '../../apps/runtime/src/worker/agent/worker-plan-client';
import { RuntimeAgent } from '../../apps/runtime/src/worker/agent/runtime-agent';
import type { RuntimeGitPort } from '@libs/runtime/api/domain/ports';
import type { RuntimeModelTurnProvider } from '@libs/runtime/api/domain/model-turn';
import type { ModelTurnResponse } from '@libs/runtime/contracts/model-turn';
import type { RunPlanRequest } from '@libs/runtime/contracts/run-plan';
import type { EntryPoint } from '@libs/runtime/entry-points/extract';
import { createPlannerClient, MemoryReceipts } from './planner-host';

const plan = {
    probes: [
        {
            entryPoint: 'GET /orders',
            assertions: { kind: 'http', status: 200 },
            probe: {
                id: 'orders',
                purpose: 'list orders',
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

/** Wire JSON is validated at runtime; SDK JSON fields are explicitly required. */
function budgetPrompt(
    frames: Parameters<
        RuntimeModelTurnProvider['complete']
    >[0]['request']['call']['prompt'],
): LanguageModelV4Prompt {
    return frames.map((frame): LanguageModelV4Prompt[number] => {
        if (frame.role === 'assistant')
            return {
                ...frame,
                content: frame.content.map((part) => {
                    if (part.type !== 'tool-call') return part;
                    if (
                        !Object.hasOwn(part, 'input') ||
                        part.input === undefined
                    )
                        throw new Error('scripted tool input missing');
                    return { ...part, input: part.input };
                }),
            };
        if (frame.role === 'tool')
            return {
                ...frame,
                content: frame.content.map((part) => {
                    const output = part.output;
                    if (output.type === 'execution-denied')
                        return {
                            ...part,
                            output: {
                                type: output.type,
                                reason: output.reason,
                            },
                        };
                    if (output.type === 'text' || output.type === 'error-text')
                        return {
                            ...part,
                            output: { type: output.type, value: output.value },
                        };
                    if (
                        !Object.hasOwn(output, 'value') ||
                        output.value === undefined
                    )
                        throw new Error('scripted tool result missing');
                    return {
                        ...part,
                        output: { type: output.type, value: output.value },
                    };
                }),
            };
        return frame;
    });
}

async function fixture() {
    const key = randomBytes(32),
        tokenSecret = randomBytes(32).toString('hex');
    const config = loadRuntimeApiConfig({
        RUNTIME_RUN_TOKEN_SECRET: tokenSecret,
        RUNTIME_SECRET_SEAL_KEY: key.toString('hex'),
    });
    const projection = run({ state: 'testing' });
    const runs = await storeWith(projection);
    const usage = new InMemoryLlmUsage();
    const secrets = new SealedSecretOpener(key);
    const canaries = new HmacCanaryVault(canaryKeyFrom(key));
    const token = signRunToken(
        {
            runId: projection.runId,
            attempt: 1,
            organizationId: projection.organizationId,
            teamId: projection.teamId,
            repositoryId: projection.repositoryId,
            prNumber: projection.prNumber,
            exp: NOW.getTime() / 1000 + 3600,
        },
        tokenSecret,
    );
    const runToken = secrets.seal(token, projection.runId);
    const entryPoints: EntryPoint[] = [
        {
            id: 'GET /orders',
            kind: 'http_route',
            match: { method: 'GET', route: '/orders', file: 'src/routes.ts' },
        },
    ];
    const body: RunPlanRequest = {
        runId: projection.runId,
        round: 0,
        entryPoints: entryPoints.map(({ id, kind }) => ({ id, kind })),
        changedPaths: ['src/routes.ts'],
        diff: '--- src/routes.ts\n+app.get("/orders", changed)',
        targets: [{ service: 'web', port: 3000, kind: 'http' as const }],
        execLeft: 5,
        observations: [],
    };
    const git = {
        getPullRequestHead: async () => ({ headSha: projection.headSha }),
        getPullRequestDiff: async () => ({
            files: [{ path: 'src/routes.ts', patch: '+changed' }],
            truncated: false,
        }),
        listFilesAtCommit: async () => ['src/routes.ts'],
        readFileAtCommit: async () => 'app.get("/orders", list);',
    } as unknown as RuntimeGitPort;
    type ToolCall = Extract<
        ModelTurnResponse['generation']['content'][number],
        { type: 'tool-call' }
    >;
    const script: { tool: ToolCall['toolName']; input: unknown }[] = [
        { tool: 'list_files', input: { path: '' } },
        { tool: 'read_file', input: { path: 'src/routes.ts' } },
        { tool: 'submit_plan', input: plan },
    ];
    let turn = 0;
    const generation = () => {
        const action = script[turn++];
        if (!action) throw new Error('unexpected scripted model call');
        return {
            content: [
                {
                    type: 'tool-call' as const,
                    toolCallId: `call-${turn}`,
                    toolName: action.tool,
                    input: JSON.stringify(action.input),
                },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
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
    };
    const receipts = new MemoryReceipts();
    const provider = {
        complete: jest.fn(
            async (
                input: Parameters<RuntimeModelTurnProvider['complete']>[0],
            ): ReturnType<RuntimeModelTurnProvider['complete']> => {
                const lease = await input.modelCallBudget.before({
                    ...input.request.call,
                    prompt: budgetPrompt(input.request.call.prompt),
                    maxOutputTokens: input.maxOutputTokens,
                });
                const response = generation();
                await lease.finish({
                    outcome: 'completed',
                    usage: response.usage,
                });
                return {
                    generation: {
                        ...response,
                        usage: {
                            reported: true as const,
                            inputTokens: { total: 100 },
                            outputTokens: { total: 10 },
                        },
                    },
                };
            },
        ),
    };
    const model = new MockLanguageModelV3({
        doGenerate: async () => generation(),
    } as any);
    const runner = new AiSdkAgentRunner(undefined, undefined, (invocation) =>
        generateText({
            model,
            system: invocation.system,
            messages: invocation.messages,
            tools: invocation.loop.tools as any,
            stopWhen: invocation.loop.stopWhen as any,
            prepareStep: invocation.loop.prepareStep as any,
            onStepFinish: invocation.loop.onStepFinish as any,
            abortSignal: invocation.signal,
        }),
    );
    const input = {
        config,
        now: () => NOW,
        runs,
        usage,
        git,
        runners: {
            forOrganization: async () => ({
                runner,
                model: 'scripted-contract',
            }),
        },
        provider,
        receipts,
        secrets,
        canaries,
    };
    const call = {
        runId: projection.runId,
        attempt: 1,
        organizationId: projection.organizationId,
        runToken,
        body,
    };
    return {
        input,
        call,
        provider,
        usage,
        receipts,
        token,
        projection,
        entryPoints,
    };
}

describe('planner eval host adapter (scripted contract, not model quality)', () => {
    it('refuses absent SDK JSON fields instead of inventing model input', () => {
        expect(() =>
            budgetPrompt([
                {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool-call',
                            toolCallId: 'missing-input',
                            toolName: 'submit_plan',
                        },
                    ],
                },
            ]),
        ).toThrow('scripted tool input missing');
        expect(() =>
            budgetPrompt([
                {
                    role: 'tool',
                    content: [
                        {
                            type: 'tool-result',
                            toolCallId: 'missing-result',
                            toolName: 'list_files',
                            output: { type: 'json' },
                        },
                    ],
                },
            ]),
        ).toThrow('scripted tool result missing');
    });
    it('keeps explicit null JSON values and the full prompt when normalizing budget input', () => {
        const frames = [
            { role: 'system' as const, content: 'original instructions' },
            {
                role: 'assistant' as const,
                content: [
                    {
                        type: 'tool-call' as const,
                        toolCallId: 'call',
                        toolName: 'submit_plan' as const,
                        input: null,
                    },
                ],
            },
            {
                role: 'tool' as const,
                content: [
                    {
                        type: 'tool-result' as const,
                        toolCallId: 'call',
                        toolName: 'submit_plan' as const,
                        output: { type: 'json' as const, value: null },
                    },
                ],
            },
        ];
        expect(budgetPrompt(frames)).toEqual(frames);
    });
    it('drives the worker planner from the same RuntimeAgent entry point as the quality runner', async () => {
        const h = await fixture();
        const llm = {
            complete: jest.fn(async () => {
                throw new Error('baseline must not be selected');
            }),
        };
        const exec = jest.fn(async () => {
            throw new Error('no shell requested');
        });
        // The reconnaissance pass sends each http probe to base before the
        // replay; a stable JSON answer raises no doubt, so no revision round.
        const probe = jest.fn(
            async (_claim: string, _probe: unknown, stepId: string) => ({
                stepId,
                executor: 'observer' as const,
                imageId: 'img',
                transport: 'ok' as const,
                http: {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                    body: '{"orders":[]}',
                },
            }),
        );
        const agent = new RuntimeAgent(
            llm,
            { exec, probe } as any,
            createPlannerClient('worker', h.input),
        );
        const actual = await agent.plan({
            runId: h.call.runId,
            attempt: 1,
            organizationId: h.call.organizationId,
            runToken: h.call.runToken,
            entryPoints: h.entryPoints,
            diffSummary: h.call.body.diff,
            files: [
                {
                    path: 'src/routes.ts',
                    content: 'app.get("/orders", changed);',
                },
            ],
            baseClaimId: 'eval-base-claim',
            targets: h.call.body.targets,
        });
        expect(actual.probes).toHaveLength(1);
        expect(actual.probes[0].probe.spec).toMatchObject({
            kind: 'http',
            path: '/orders',
        });
        expect(actual.usage).toEqual({ inputTokens: 300, outputTokens: 30 });
        expect(actual.recon).toEqual({ probes: 1, doubts: 0, revised: false });
        expect(probe.mock.calls.map((c) => c[0])).toEqual(
            Array(probe.mock.calls.length).fill('eval-base-claim'),
        );
        expect(llm.complete).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
    });
    it('runs WorkerRunPlanClient through actual product source/gateway authority and usage', async () => {
        const h = await fixture();
        const workerPlan = jest.spyOn(WorkerRunPlanClient.prototype, 'plan');
        const modelTurn = jest.spyOn(
            RuntimeModelTurnGatewayUseCase.prototype,
            'execute',
        );
        const source = jest.spyOn(
            RuntimePlannerSourceUseCase.prototype,
            'execute',
        );
        try {
            const actual = await createPlannerClient('worker', h.input).plan(
                h.call,
            );
            expect(actual.status).toBe('planned');
            if (actual.status !== 'planned')
                throw new Error('scripted planner did not complete');
            expect(actual.plan.probes).toHaveLength(1);
            expect(actual.usage).toEqual({
                inputTokens: 300,
                outputTokens: 30,
            });
            expect(workerPlan).toHaveBeenCalledTimes(1);
            expect(modelTurn).toHaveBeenCalledTimes(3);
            expect(source).toHaveBeenCalled();
            expect(await h.usage.totalForRun(h.call.runId)).toBe(330);
            expect(h.receipts.size).toBe(3);
            expect(h.provider.complete.mock.calls).toHaveLength(3);
            expect(
                JSON.stringify(h.provider.complete.mock.calls),
            ).not.toContain(h.token);
            expect(
                JSON.stringify(h.provider.complete.mock.calls),
            ).not.toContain(h.call.runToken);
        } finally {
            jest.restoreAllMocks();
        }
    });
    it('preserves the explicit product comparison with the same scoped plan', async () => {
        const product = await fixture(),
            worker = await fixture();
        const oldPlan = await createPlannerClient(
            'product',
            product.input,
        ).plan(product.call);
        const newPlan = await createPlannerClient('worker', worker.input).plan(
            worker.call,
        );
        if (oldPlan.status !== 'planned' || newPlan.status !== 'planned')
            throw new Error('scripted comparison did not complete');
        expect(newPlan.plan).toEqual(oldPlan.plan);
        expect(newPlan.usage).toEqual(oldPlan.usage);
    });
    it('refuses a mismatched worker attempt before invoking the provider', async () => {
        const h = await fixture();
        await expect(
            createPlannerClient('worker', h.input).plan({
                ...h.call,
                attempt: 2,
            }),
        ).rejects.toThrow();
        expect(h.provider.complete).not.toHaveBeenCalled();
    });
    it('does not silently fall back to product for an unsupported host', async () => {
        const h = await fixture();
        expect(() => createPlannerClient('unknown' as any, h.input)).toThrow(
            /host/,
        );
        expect(h.provider.complete).not.toHaveBeenCalled();
    });
});
