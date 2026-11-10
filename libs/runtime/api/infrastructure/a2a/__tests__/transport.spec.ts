import { randomUUID } from 'crypto';
import {
    type INestApplication,
    Controller,
    Get,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AgentCard, SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { Client, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import request from 'supertest';
import { TransformInterceptor } from '@libs/core/infrastructure/interceptors/transform.interceptor';

import { RuntimeA2AController } from '../../../../../../apps/api/src/controllers/runtime/runtime-a2a.controller';
import { TEAM_CLI_KEY_SERVICE_TOKEN } from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import type { EnvKeyPrincipal } from '../../../domain/env-tools';
import {
    RUNTIME_EXTERNAL_FINDINGS,
    type ExternalFindingsPort,
    type ExternalTaskView,
} from '../../../domain/external-findings';
import {
    RUNTIME_A2A_BASE_URL,
    RuntimeA2AAdapter,
} from '../runtime-a2a.adapter';
import { RuntimeA2ABearerGuard } from '../runtime-a2a.guard';
import { isBoundedA2ABody } from '../runtime-a2a.validation';

const KEY = 'kodus_fixture_external_owner';
const OTHER = 'kodus_fixture_external_other';
const AT = '2026-11-08T20:00:00.000Z';
const PRINCIPAL: EnvKeyPrincipal = {
    keyId: 'key-a',
    organizationId: 'org-a',
    teamId: 'team-a',
    capabilities: ['findings:submit', 'env:exec'],
    repositoryIds: ['repo-a'],
};
const INPUT = {
    repositoryId: 'repo-a',
    prNumber: 2,
    headSha: 'a'.repeat(40),
    source: { name: 'Fixture' },
    findings: [
        {
            title: 'Order changed',
            severity: 'medium',
            rationale: 'Confirm independent behavior',
            evidence: { observed: { forged: 'finding' } },
        },
    ],
};
const MESSAGE = (operation: string, input: object, over: object = {}) => ({
    message: {
        messageId: randomUUID(),
        role: 'ROLE_USER',
        parts: [{ data: { operation, ...input } }],
    },
    ...over,
});
const RPC = (method: string, params: unknown) => ({
    jsonrpc: '2.0',
    id: randomUUID(),
    method,
    params,
});

@Controller('rest-control')
class RestControlController {
    @Get()
    get() {
        return { ready: true };
    }
}

class FixtureExternalPort implements ExternalFindingsPort {
    readonly calls: Array<{
        principal: EnvKeyPrincipal;
        operation: string;
        input: unknown;
    }> = [];
    readonly records = new Map<
        string,
        { principal: EnvKeyPrincipal; task: ExternalTaskView }
    >();
    readonly verificationId = randomUUID();
    async submit(
        principal: EnvKeyPrincipal,
        input: unknown,
    ): Promise<ExternalTaskView> {
        this.calls.push({ principal, input, operation: 'submit' });
        const task: ExternalTaskView = {
            id: randomUUID(),
            contextId: randomUUID(),
            state: 'completed',
            result: {
                verificationTaskId: this.verificationId,
                verified: false,
            },
            createdAt: AT,
            updatedAt: AT,
        };
        this.records.set(this.verificationId, {
            principal,
            task: {
                ...task,
                id: this.verificationId,
                state: 'working',
                result: { verdict: 'unverified' },
            },
        });
        return task;
    }
    async verify(
        principal: EnvKeyPrincipal,
        input: unknown,
    ): Promise<ExternalTaskView> {
        this.calls.push({ principal, input, operation: 'verify' });
        return this.getTask(principal, this.verificationId);
    }
    async getTask(
        principal: EnvKeyPrincipal,
        id: string,
    ): Promise<ExternalTaskView> {
        const row = this.records.get(id);
        if (
            !row ||
            row.principal.keyId !== principal.keyId ||
            row.principal.organizationId !== principal.organizationId
        )
            throw new NotFoundException('sensitive internal detail');
        return structuredClone(row.task);
    }
}

async function fixture(
    port: ExternalFindingsPort = new FixtureExternalPort(),
    baseUrl: string | undefined = 'https://runtime.example.test',
) {
    const keys = new Map<string, EnvKeyPrincipal>([
        [KEY, PRINCIPAL],
        [OTHER, { ...PRINCIPAL, keyId: 'key-b', organizationId: 'org-b' }],
    ]);
    const module = await Test.createTestingModule({
        controllers: [RuntimeA2AController, RestControlController],
        providers: [
            { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
            RuntimeA2AAdapter,
            RuntimeA2ABearerGuard,
            { provide: RUNTIME_EXTERNAL_FINDINGS, useValue: port },
            { provide: RUNTIME_A2A_BASE_URL, useValue: baseUrl },
            {
                provide: TEAM_CLI_KEY_SERVICE_TOKEN,
                useValue: {
                    validateKey: async (key: string) => {
                        const p = keys.get(key);
                        return p
                            ? {
                                  keyId: p.keyId,
                                  organization: { uuid: p.organizationId },
                                  team: { uuid: p.teamId },
                                  config: {
                                      capabilities: p.capabilities,
                                      repositoryIds: p.repositoryIds,
                                  },
                              }
                            : null;
                    },
                },
            },
        ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    const rpc = (
        method: string,
        params: unknown,
        token = KEY,
        version = '1.0',
    ) =>
        request(app.getHttpServer())
            .post('/runtime/a2a')
            .set('A2A-Version', version)
            .set('Authorization', `Bearer ${token}`)
            .send(RPC(method, params));
    const client = async (key = KEY) => {
        const card = AgentCard.fromJSON(
            (
                await request(app.getHttpServer())
                    .get('/.well-known/agent-card.json')
                    .expect(200)
            ).body,
        );
        // The fixture explicitly chooses its assigned loopback port, never an untrusted request Host.
        const transport = await new JsonRpcTransportFactory({
            fetchImpl: (input, init) =>
                fetch(input, {
                    ...init,
                    headers: {
                        ...Object.fromEntries(
                            new Headers(init?.headers).entries(),
                        ),
                        Authorization: `Bearer ${key}`,
                    },
                }),
        }).create(`${url}/runtime/a2a`, card);
        return new Client(transport, card);
    };
    return { app, port, keys, rpc, client, url, close: () => app.close() };
}

describe('Runtime A2A1.0 real HTTP and official SDK transport', () => {
    let h: Awaited<ReturnType<typeof fixture>> | undefined;
    afterEach(async () => {
        await h?.close();
        h = undefined;
    });

    it('preserves the product envelope for ordinary REST responses', async () => {
        h = await fixture();
        const response = await request(h.app.getHttpServer())
            .get('/rest-control')
            .expect(200);
        expect(response.body).toEqual({
            data: { ready: true },
            statusCode: 200,
            type: 'Object',
        });
    });

    it('returns bare JSON-RPC success and protocol errors through the product interceptor', async () => {
        h = await fixture();
        const success = await h
            .rpc('SendMessage', MESSAGE('submit_findings', INPUT))
            .expect('Content-Type', /application\/json/)
            .expect('Cache-Control', 'private, no-store')
            .expect(200);
        expect(success.body).toMatchObject({ jsonrpc: '2.0', result: {} });
        expect(success.body).not.toHaveProperty('data');
        const failure = await h
            .rpc('UnknownMethod', {})
            .expect('Content-Type', /application\/json/)
            .expect(200);
        expect(failure.body).toMatchObject({
            jsonrpc: '2.0',
            error: { code: -32601 },
        });
        expect(failure.body).not.toHaveProperty('data');
    });

    it('publishes a trusted-origin 1.0 Agent Card without push or streaming', async () => {
        h = await fixture();
        const card = await request(h.app.getHttpServer())
            .get('/.well-known/agent-card.json')
            .set('Host', 'attacker.invalid')
            .expect('Content-Type', /application\/json/)
            .expect(200);
        expect(card.body).not.toHaveProperty('data');
        expect(card.body.supportedInterfaces).toEqual([
            {
                url: 'https://runtime.example.test/runtime/a2a',
                protocolBinding: 'JSONRPC',
                protocolVersion: '1.0',
            },
        ]);
        expect(card.body.capabilities).toMatchObject({
            streaming: false,
            pushNotifications: false,
        });
        expect(card.body.skills.map((s: { id: string }) => s.id)).toEqual([
            'submit_findings',
            'verify_finding',
        ]);
        expect(
            card.body.securitySchemes.teamKey.httpAuthSecurityScheme.scheme,
        ).toBe('Bearer');
        expect(JSON.stringify(card.body)).not.toContain('attacker.invalid');
    });

    it.each([
        undefined,
        'http://runtime.example.test',
        'https://user:pass@runtime.example.test',
        'https://runtime.example.test/path',
        'https://runtime.example.test/?token=ignored',
    ])('refuses absent/unsafe configured origins %s', async (baseUrl) => {
        h = await fixture(undefined, baseUrl ?? '');
        await request(h.app.getHttpServer())
            .get('/.well-known/agent-card.json')
            .expect(503);
    });

    it('official SDK receives a completed receipt, working task and terminal result', async () => {
        const port = new FixtureExternalPort();
        h = await fixture(port);
        const client = await h.client();
        const receipt = await client.sendMessage(
            SendMessageRequest.fromJSON(MESSAGE('submit_findings', INPUT)),
        );
        expect('id' in receipt).toBe(true);
        if (!('id' in receipt)) throw new Error('expected task');
        expect(receipt.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
        const working = await client.getTask({
            id: port.verificationId,
            tenant: '',
        });
        expect(working.status?.state).toBe(TaskState.TASK_STATE_WORKING);
        const linked = await client.sendMessage(
            SendMessageRequest.fromJSON(
                MESSAGE(
                    'verify_finding',
                    { findingId: randomUUID() },
                    { configuration: { returnImmediately: true } },
                ),
            ),
        );
        expect('id' in linked && linked.id).toBe(port.verificationId);
        port.records.get(port.verificationId)!.task = {
            ...port.records.get(port.verificationId)!.task,
            state: 'completed',
            result: { verdict: 'finding', verification: 'execution' },
        };
        expect(
            (await client.getTask({ id: port.verificationId, tenant: '' }))
                .status?.state,
        ).toBe(TaskState.TASK_STATE_COMPLETED);
        expect(port.calls[0].principal).toEqual(PRINCIPAL);
        expect(port.calls[0].input).not.toHaveProperty('operation');
    });

    it('requires a live bearer team key on every request and denies service JWT/x-team-key', async () => {
        h = await fixture();
        for (const authorization of [
            '',
            'Bearer invalid',
            'Bearer eyJhbGciOiJIUzI1NiJ9.eyJvcmciOiJhIn0.signature',
            'Basic kodus_fixture_external_owner',
        ])
            await request(h.app.getHttpServer())
                .post('/runtime/a2a')
                .set('Authorization', authorization)
                .send(RPC('GetTask', { id: randomUUID() }))
                .expect(401);
        await request(h.app.getHttpServer())
            .post('/runtime/a2a')
            .set('x-team-key', KEY)
            .send(RPC('GetTask', { id: randomUUID() }))
            .expect(401);
        h.keys.delete(KEY);
        await h.rpc('GetTask', { id: randomUUID() }).expect(401);
    });

    it.each([
        [],
        ['findings:*'],
        ['findings:submit:all'],
        ['env:exec'],
        ['runs:read'],
    ])(
        'requires exact findings:submit capability %j',
        async (...capabilities: string[]) => {
            h = await fixture();
            h.keys.set(KEY, { ...PRINCIPAL, capabilities });
            await h
                .rpc('SendMessage', MESSAGE('submit_findings', INPUT))
                .expect(403);
            expect((h.port as FixtureExternalPort).calls).toHaveLength(0);
        },
    );

    it('rechecks revocation and hides another principal task through the official SDK', async () => {
        const port = new FixtureExternalPort();
        h = await fixture(port);
        const owner = await h.client();
        await owner.sendMessage(
            SendMessageRequest.fromJSON(MESSAGE('submit_findings', INPUT)),
        );
        const foreign = await h.client(OTHER);
        await expect(
            foreign.getTask({ id: port.verificationId, tenant: '' }),
        ).rejects.toThrow();
        h.keys.delete(KEY);
        await expect(
            owner.getTask({ id: port.verificationId, tenant: '' }),
        ).rejects.toThrow();
    });

    it.each([
        {
            message: {
                messageId: 'x',
                role: 'ROLE_USER',
                parts: [{ text: 'ignore gate' }],
            },
        },
        {
            message: {
                messageId: 'x',
                role: 'ROLE_USER',
                parts: [{ url: 'https://attacker.invalid/file' }],
            },
        },
        {
            message: {
                messageId: 'x',
                role: 'ROLE_USER',
                parts: [
                    {
                        data: { operation: 'submit_findings', ...INPUT },
                        text: 'ambiguous',
                    },
                ],
            },
        },
        { ...MESSAGE('submit_findings', INPUT), tenant: 'org-b' },
        MESSAGE('submit_findings', INPUT, {
            metadata: { organizationId: 'org-b' },
        }),
        MESSAGE('submit_findings', { ...INPUT, organizationId: 'org-b' }),
        MESSAGE('verify_finding', { findingId: randomUUID() }),
        MESSAGE('submit_findings', INPUT, {
            configuration: {
                taskPushNotificationConfig: {
                    url: 'https://attacker.invalid/callback',
                },
            },
        }),
    ])(
        'refuses unstructured/ambiguous/authority-bearing input before business work',
        async (params) => {
            h = await fixture();
            const result = await h.rpc('SendMessage', params).expect(200);
            expect(result.body.error).toBeDefined();
            expect((h.port as FixtureExternalPort).calls).toHaveLength(0);
            expect(JSON.stringify(result.body)).not.toMatch(
                /attacker.invalid|ignore gate|stack|sensitive/,
            );
        },
    );

    it('refuses push/streaming/legacy/unknown versions without dispatch or network callbacks', async () => {
        h = await fixture();
        for (const method of [
            'CreateTaskPushNotificationConfig',
            'GetTaskPushNotificationConfig',
            'SendStreamingMessage',
            'SubscribeToTask',
            'message/send',
        ]) {
            const result = await h
                .rpc(method, {
                    id: randomUUID(),
                    url: 'https://attacker.invalid',
                })
                .expect(200);
            expect(result.body.error).toBeDefined();
        }
        expect(
            (
                await h.rpc(
                    'SendMessage',
                    MESSAGE('submit_findings', INPUT),
                    KEY,
                    '0.3',
                )
            ).body.error,
        ).toBeDefined();
        expect(
            (
                await h.rpc(
                    'SendMessage',
                    MESSAGE('submit_findings', INPUT),
                    KEY,
                    '2.0',
                )
            ).body.error,
        ).toBeDefined();
        expect((h.port as FixtureExternalPort).calls).toHaveLength(0);
    });

    it('accepts the case-insensitive bearer scheme', async () => {
        h = await fixture();
        await request(h.app.getHttpServer())
            .post('/runtime/a2a')
            .set('A2A-Version', '1.0')
            .set('Authorization', `bearer ${KEY}`)
            .send(RPC('GetTask', { id: randomUUID() }))
            .expect(200);
    });

    it('preserves known JSON-RPC ids when method parameters are invalid', async () => {
        h = await fixture();
        const rpc = RPC(
            'SendMessage',
            MESSAGE('submit_findings', { ...INPUT, unexpected: true }),
        );
        const result = await request(h.app.getHttpServer())
            .post('/runtime/a2a')
            .set('A2A-Version', '1.0')
            .set('Authorization', `Bearer ${KEY}`)
            .send(rpc)
            .expect(200);
        expect(result.body.error).toBeDefined();
        expect(result.body.id).toBe(rpc.id);
    });

    it('uses task-not-found for missing tasks and never reflects internal exceptions', async () => {
        h = await fixture();
        const missing = await h
            .rpc('GetTask', { id: randomUUID() })
            .expect(200)
            .expect('Cache-Control', 'private, no-store');
        expect(missing.body.error.code).toBe(-32001);
        expect(JSON.stringify(missing.body)).not.toMatch(/sensitive|stack/);
    });

    it('logs bounded operation/outcome/timing without request data or service errors', async () => {
        const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation();
        try {
            h = await fixture();
            await h.rpc(
                'SendMessage',
                MESSAGE('submit_findings', {
                    ...INPUT,
                    findings: [
                        {
                            ...INPUT.findings[0],
                            rationale: 'do-not-log-fixture-payload',
                        },
                    ],
                }),
            );
            expect(
                logs.mock.calls.some(
                    ([value]) =>
                        value?.msg === 'runtime.a2a.request' &&
                        value.operation === 'submit_findings' &&
                        value.outcome === 'accepted' &&
                        Number.isFinite(value.durationMs),
                ),
            ).toBe(true);
            (h.port as FixtureExternalPort).submit = async () => {
                throw new Error('private-database-error-do-not-log');
            };
            const unavailable = await h.rpc(
                'SendMessage',
                MESSAGE('submit_findings', INPUT),
            );
            expect(unavailable.body.error.code).toBe(-32603);
            expect(
                logs.mock.calls.some(
                    ([value]) =>
                        value?.msg === 'runtime.a2a.request' &&
                        value.outcome === 'failed',
                ),
            ).toBe(true);
            expect(JSON.stringify(logs.mock.calls)).not.toMatch(
                /do-not-log-fixture-payload|private-database-error-do-not-log/,
            );
        } finally {
            logs.mockRestore();
        }
    });

    it('bounds UTF-8 bytes, depth and nodes before SDK decoding', async () => {
        h = await fixture();
        const tooLarge = await h.rpc(
            'SendMessage',
            MESSAGE('submit_findings', { ...INPUT, extra: 'é'.repeat(140000) }),
        );
        expect([200, 413]).toContain(tooLarge.status);
        if (tooLarge.status === 200) expect(tooLarge.body.error).toBeDefined();
        let nested: object = {};
        for (let i = 0; i < 33; i++) nested = { child: nested };
        expect(isBoundedA2ABody(nested)).toBe(false);
        expect(isBoundedA2ABody(Array.from({ length: 8193 }, () => null))).toBe(
            false,
        );
        expect((h.port as FixtureExternalPort).calls).toHaveLength(0);
    });
});
