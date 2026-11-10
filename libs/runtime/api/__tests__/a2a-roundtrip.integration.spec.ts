import { randomUUID } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TransformInterceptor } from '@libs/core/infrastructure/interceptors/transform.interceptor';
import { AgentCard, SendMessageRequest, Task, TaskState } from '@a2a-js/sdk';
import { Client, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import request from 'supertest';

import { RuntimeA2AController } from '../../../../apps/api/src/controllers/runtime/runtime-a2a.controller';
import { SCENARIOS } from '../../../../apps/runtime/src/fake-cell/scenarios';
import { inMemoryRunDeps } from '../../../../apps/runtime/src/worker/run/in-memory-deps';
import { runRuntimeRun } from '../../../../apps/runtime/src/worker/run/run-orchestrator';
import { TEAM_CLI_KEY_SERVICE_TOKEN } from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import { FakeEnvironmentRuntime } from '@libs/runtime/environment';
import type { RuntimeRunRequested } from '@libs/runtime/run';
import { RUNTIME_EXTERNAL_FINDINGS } from '../domain/external-findings';
import { RuntimeA2ABearerGuard } from '../infrastructure/a2a/runtime-a2a.guard';
import {
    RUNTIME_A2A_BASE_URL,
    RuntimeA2AAdapter,
} from '../infrastructure/a2a/runtime-a2a.adapter';
import { runtimeA2AJsonParser } from '../infrastructure/a2a/a2a-body-parser';
import { createExternalFixture } from './external-findings.fixtures';

const KEY = 'kodus_external_roundtrip_fixture';
function data(task: Task): Record<string, unknown> {
    const wire = Task.toJSON(task) as {
        artifacts: Array<{ parts: Array<{ data: Record<string, unknown> }> }>;
    };
    return wire.artifacts[0].parts[0].data;
}
function task(result: Task | unknown): Task {
    if (!result || typeof result !== 'object' || !('id' in result))
        throw new Error('Expected an A2A task');
    return result as Task;
}

describe('official A2A client → product admission → independent worker replay → task proof', () => {
    let app: INestApplication | undefined;
    afterEach(async () => {
        await app?.close();
        app = undefined;
    });

    it.each([true, false])(
        'measures the exact probe, regression=%s, without trusting submitted observations',
        async (regression) => {
            const api = createExternalFixture();
            api.input.findings[0].evidence.probe.expected = '200';
            api.input.findings[0].evidence.observed = {
                verdict: 'finding',
                trusted: true,
            };
            const module = await Test.createTestingModule({
                controllers: [RuntimeA2AController],
                providers: [
                    {
                        provide: APP_INTERCEPTOR,
                        useClass: TransformInterceptor,
                    },
                    RuntimeA2AAdapter,
                    RuntimeA2ABearerGuard,
                    {
                        provide: RUNTIME_EXTERNAL_FINDINGS,
                        useValue: api.service,
                    },
                    {
                        provide: RUNTIME_A2A_BASE_URL,
                        useValue: 'https://kodus.example.test',
                    },
                    {
                        provide: TEAM_CLI_KEY_SERVICE_TOKEN,
                        useValue: {
                            validateKey: async (key: string) =>
                                key === KEY
                                    ? {
                                          keyId: api.principal.keyId,
                                          organization: {
                                              uuid: api.principal
                                                  .organizationId,
                                          },
                                          team: { uuid: api.principal.teamId },
                                          config: {
                                              capabilities:
                                                  api.principal.capabilities,
                                              repositoryIds:
                                                  api.principal.repositoryIds,
                                          },
                                      }
                                    : null,
                        },
                    },
                ],
            }).compile();
            app = module.createNestApplication({
                logger: false,
                bodyParser: false,
            });
            app.use('/runtime/a2a', ...runtimeA2AJsonParser());
            await app.listen(0, '127.0.0.1');
            const url = await app.getUrl();
            const card = AgentCard.fromJSON(
                (
                    await request(app.getHttpServer())
                        .get('/.well-known/agent-card.json')
                        .expect(200)
                ).body,
            );
            const transport = await new JsonRpcTransportFactory({
                fetchImpl: (input, init) =>
                    fetch(input, {
                        ...init,
                        headers: {
                            ...Object.fromEntries(
                                new Headers(init?.headers).entries(),
                            ),
                            Authorization: `Bearer ${KEY}`,
                        },
                    }),
            }).create(`${url}/runtime/a2a`, card);
            const client = new Client(transport, card);
            const message = SendMessageRequest.fromJSON({
                message: {
                    messageId: randomUUID(),
                    role: 'ROLE_USER',
                    parts: [
                        {
                            data: {
                                operation: 'submit_findings',
                                ...api.input,
                            },
                        },
                    ],
                },
                configuration: { returnImmediately: true },
            });
            const receipt = task(await client.sendMessage(message));
            expect(receipt.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
            const info = data(receipt);
            const verificationId = info.verificationTaskId as string;
            expect(
                (await client.getTask({ id: verificationId, tenant: '' }))
                    .status?.state,
            ).toBe(TaskState.TASK_STATE_WORKING);
            expect(api.store.requests).toHaveLength(1);
            const verifyMessage = SendMessageRequest.fromJSON({
                message: {
                    messageId: randomUUID(),
                    role: 'ROLE_USER',
                    parts: [
                        {
                            data: {
                                operation: 'verify_finding',
                                findingId: (info.findingIds as string[])[0],
                            },
                        },
                    ],
                },
                configuration: { returnImmediately: true },
            });
            const linked = task(await client.sendMessage(verifyMessage));
            expect(linked.id).toBe(verificationId);
            expect(linked.status?.state).toBe(TaskState.TASK_STATE_WORKING);
            expect(api.store.requests).toHaveLength(1);
            const req = api.store.requests[0] as RuntimeRunRequested;
            expect(JSON.stringify(req)).not.toContain('trusted');
            const findingId = req.externalVerification!.findings[0].findingId;
            const rawEnv = new FakeEnvironmentRuntime(
                {
                    [api.environment.environmentId]: {
                        ...SCENARIOS.shop,
                        imageId: api.image.imageId,
                        probes: {
                            [findingId]: {
                                base: () => ({
                                    http: {
                                        status: 200,
                                        headers: {},
                                        body: '{"items":[]}',
                                    },
                                }),
                                pr: () => ({
                                    http: {
                                        status: regression ? 500 : 200,
                                        headers: {},
                                        body: regression
                                            ? '{"error":"broken"}'
                                            : '{"items":[]}',
                                    },
                                }),
                            },
                        },
                    },
                },
                api.now,
            );
            const worker = inMemoryRunDeps({ env: rawEnv });
            worker.deps.projection = api.runs;
            worker.deps.now = api.now;
            const planner = jest.spyOn(worker.deps.agent, 'plan');
            await api.runs.upsert(req.runId, {
                runId: req.runId,
                attempt: req.attempt,
                correlationId: req.correlationId,
                organizationId: req.organizationId,
                teamId: req.teamId,
                repositoryId: req.repository.id,
                repositoryName: req.repository.name,
                prNumber: req.pullRequest.number,
                headSha: req.pullRequest.headSha,
                baseSha: req.pullRequest.baseSha,
                environmentId: req.environment.environmentId,
                imageId: req.environment.imageId,
                state: 'queued',
                requestedAt: req.requestedAt,
                trigger: req.trigger,
            });
            await runRuntimeRun(req, worker.deps);
            const result = await client.getTask({
                id: verificationId,
                tenant: '',
            });
            expect(result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
            expect(data(result).verdicts).toEqual([
                expect.objectContaining({
                    findingId,
                    verdict: regression ? 'finding' : 'not_reproduced',
                    verification: regression
                        ? 'verified_by_execution'
                        : 'not_verified',
                }),
            ]);
            expect(rawEnv.resets).toHaveLength(regression ? 4 : 3);
            expect(planner).not.toHaveBeenCalled();
            expect(worker.published).toHaveLength(0);
            expect(await worker.claims.forRun(req.runId)).toEqual([]);
            expect(task(await client.sendMessage(verifyMessage)).id).toBe(
                verificationId,
            );
            await client.sendMessage(message);
            expect(api.store.requests).toHaveLength(1);
            expect(
                (await client.getTask({ id: verificationId, tenant: '' }))
                    .status?.state,
            ).toBe(TaskState.TASK_STATE_COMPLETED);
        },
    );
});
