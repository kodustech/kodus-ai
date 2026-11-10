import { InMemoryPrAdmissionStore } from '../../shared/admission/pr-admission-store';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
    AmqpConnection,
    MessageHandlerErrorBehavior,
    RABBIT_HANDLER,
} from '@golevelup/nestjs-rabbitmq';
import {
    connect,
    type ChannelModel,
    type ConfirmChannel,
    type ConsumeMessage,
    type Options,
} from 'amqplib';

import {
    RUNTIME_RUN_RETRY_EXCHANGE,
    RuntimeEventName,
    runtimeEnvelope,
} from '@libs/runtime/run/run-messages';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { RuntimeCommandName } from '@libs/runtime/contracts/runtime-commands';
import { WORKFLOW_JOB_QUEUE_ARGUMENTS } from '@libs/core/workflow/infrastructure/workflow-queue-arguments';
import { shopRunRequest } from '../../e2e/fixtures';
import { InMemoryCommandStore } from '../../shared/persistence/pg-command-store';
import { RuntimeCommandConsumer } from './run-request.consumer';
import { RuntimeRunRetry } from './runtime-run-retry';

const adminURL = process.env.RUNTIME_RETRY_IT_ADMIN_URL;
const managementURL = process.env.RUNTIME_RETRY_IT_MANAGEMENT_URL;
const enabled = Boolean(adminURL || managementURL);

function policyFromScript() {
    const source = readFileSync(
        resolve(
            __dirname,
            '../../../../../scripts/runtime/dev-runtime-users.sh',
        ),
        'utf8',
    );
    const variable = (name: string) =>
        source.match(new RegExp(`^${name}='([^']+)'$`, 'm'))?.[1] ?? '';
    const permissions = source.match(
        /set_permissions -p "\$VHOST" kodus_runtime \\\n\s*"([^"\n]+)" \\\n\s*"([^"\n]+)" \\\n\s*"([^"\n]+)"/,
    );
    if (!permissions) throw new Error('fixture_policy_not_found');
    const expand = (s: string) =>
        s
            .replaceAll('${Q}', variable('Q'))
            .replaceAll('${D}', variable('D'))
            .replaceAll('\\$', '$');
    const topic = (exchange: string) => {
        const escaped = exchange.replaceAll('.', '\\.');
        const match = source.match(
            new RegExp(
                `set_topic_permissions -p "\\$VHOST" kodus_runtime ${escaped} \\\\\\n\\s*'([^']+)' \\\\\\n\\s*'([^']+)'`,
            ),
        );
        if (!match) throw new Error('fixture_topic_policy_not_found');
        return { exchange, write: match[1], read: match[2] };
    };
    return {
        configure: expand(permissions[1]),
        write: expand(permissions[2]),
        read: expand(permissions[3]),
        topics: [topic('workflow.exchange')],
    };
}

function within<T>(promise: Promise<T>, ms = 10000): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<never>((_r, reject) => {
            timer = setTimeout(
                () => reject(new Error('fixture_operation_timed_out')),
                ms,
            );
        }),
    ]).finally(() => clearTimeout(timer));
}

describe('Runtime retry source permission boundary', () => {
    it('keeps product authority narrow and the private exchange publish-only', () => {
        const policy = policyFromScript();
        expect(new RegExp(policy.configure).test('workflow.exchange')).toBe(
            false,
        );
        expect(
            new RegExp(policy.configure).test(RUNTIME_RUN_RETRY_EXCHANGE),
        ).toBe(false);
        expect(
            new RegExp(policy.configure).test(
                'workflow.jobs.runtime_run.queue',
            ),
        ).toBe(true);
        expect(new RegExp(policy.write).test(RUNTIME_RUN_RETRY_EXCHANGE)).toBe(
            true,
        );
        expect(new RegExp(policy.read).test(RUNTIME_RUN_RETRY_EXCHANGE)).toBe(
            false,
        );
        expect(new RegExp(policy.write).test('workflow.exchange.delayed')).toBe(
            false,
        );
        const main = policy.topics[0];
        expect(
            new RegExp(main.write).test(
                'workflow.jobs.created.RUNTIME_PUBLISH',
            ),
        ).toBe(true);
        expect(
            new RegExp(main.write).test('workflow.jobs.created.RUNTIME_RUN'),
        ).toBe(false);
        expect(
            new RegExp(main.read).test('workflow.jobs.created.CODE_REVIEW'),
        ).toBe(false);
        expect(
            new RegExp(main.read).test('workflow.jobs.created.RUNTIME_PUBLISH'),
        ).toBe(false);
    });
});

(enabled ? describe : describe.skip)(
    'Runtime retry with isolated real delayed broker and restricted identity',
    () => {
        let admin: ChannelModel;
        let channel: ConfirmChannel;
        const connections: ChannelModel[] = [];
        const own = `runtime_retry_it_${randomUUID().replaceAll('-', '')}`;
        const password = randomBytes(24).toString('hex');
        let adminAddress: URL;
        let userAddress: URL;
        let authorization: string;
        let management: URL;

        async function api(path: string, method: string, body?: unknown) {
            const response = await fetch(new URL(path, management), {
                method,
                headers: {
                    'Authorization': authorization,
                    'Content-Type': 'application/json',
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(5000),
            });
            if (!response.ok)
                throw new Error(`fixture_management_${response.status}`);
        }
        async function user() {
            const conn = await connect(userAddress.toString());
            conn.on('error', () => undefined);
            connections.push(conn);
            const ch = await conn.createConfirmChannel();
            ch.on('error', () => undefined);
            return ch;
        }
        function confirmed(
            ch: ConfirmChannel,
            exchange: string,
            key: string,
            bytes: Buffer,
            options: Options.Publish,
        ): Promise<boolean> {
            return within(
                new Promise((res, reject) => {
                    let writable = true;
                    writable = ch.publish(
                        exchange,
                        key,
                        bytes,
                        options,
                        (err) =>
                            err
                                ? reject(new Error('fixture_publish_refused'))
                                : res(writable),
                    );
                }),
            );
        }
        async function getDeadLetter(): Promise<
            Pick<ConsumeMessage, 'content' | 'properties'>
        > {
            const end = Date.now() + 10000;
            while (Date.now() < end) {
                const msg = await channel.get('workflow.jobs.dlq', {
                    noAck: true,
                });
                if (msg) return msg;
                await new Promise((res) => setTimeout(res, 25));
            }
            throw new Error('fixture_dead_letter_missing');
        }

        beforeAll(async () => {
            if (!adminURL || !managementURL)
                throw new Error('fixture_configuration_missing');
            adminAddress = new URL(adminURL);
            management = new URL(managementURL);
            if (
                ![adminAddress.hostname, management.hostname].every((h) =>
                    ['127.0.0.1', '[::1]'].includes(h),
                )
            )
                throw new Error('fixture_requires_literal_loopback');
            authorization =
                'Basic ' +
                Buffer.from(
                    `${decodeURIComponent(adminAddress.username)}:${decodeURIComponent(adminAddress.password)}`,
                ).toString('base64');
            await api(`/api/vhosts/${own}`, 'PUT', {});
            await api(`/api/users/${own}`, 'PUT', { password, tags: '' });
            const policy = policyFromScript();
            await api(`/api/permissions/${own}/${own}`, 'PUT', {
                configure: policy.configure,
                write: policy.write,
                read: policy.read,
            });
            for (const topic of policy.topics)
                await api(`/api/topic-permissions/${own}/${own}`, 'PUT', topic);
            adminAddress.pathname = '/' + own;
            userAddress = new URL(adminAddress);
            userAddress.username = own;
            userAddress.password = password;
            admin = await connect(adminAddress.toString());
            admin.on('error', () => undefined);
            channel = await admin.createConfirmChannel();
            channel.on('error', () => undefined);
            await channel.assertExchange('workflow.exchange', 'topic', {
                durable: true,
            });
            await channel.assertExchange('workflow.exchange.dlx', 'topic', {
                durable: true,
            });
            await channel.assertExchange(
                'workflow.exchange.delayed',
                'x-delayed-message',
                { durable: true, arguments: { 'x-delayed-type': 'topic' } },
            );
            await channel.assertExchange(
                RUNTIME_RUN_RETRY_EXCHANGE,
                'x-delayed-message',
                { durable: true, arguments: { 'x-delayed-type': 'direct' } },
            );
            await channel.assertQueue('workflow.jobs.runtime_run.queue', {
                durable: true,
                arguments:
                    WORKFLOW_JOB_QUEUE_ARGUMENTS[
                        'workflow.jobs.runtime_run.queue'
                    ],
            });
            await channel.bindQueue(
                'workflow.jobs.runtime_run.queue',
                RUNTIME_RUN_RETRY_EXCHANGE,
                'workflow.jobs.created.RUNTIME_RUN',
            );
            await channel.assertQueue('workflow.jobs.dlq', {
                durable: true,
                arguments: { 'x-queue-type': 'quorum' },
            });
            await channel.bindQueue(
                'workflow.jobs.dlq',
                'workflow.exchange.dlx',
                '#',
            );
            for (const [name, key] of [
                ['workflow.jobs.runtime_control.queue', 'RUNTIME_CONTROL'],
                ['workflow.jobs.code_review.queue', 'CODE_REVIEW'],
            ]) {
                await channel.assertQueue(name, {
                    durable: true,
                    arguments: WORKFLOW_JOB_QUEUE_ARGUMENTS[name],
                });
                await channel.bindQueue(
                    name,
                    'workflow.exchange.delayed',
                    `workflow.jobs.created.${key}`,
                );
                await channel.bindQueue(
                    name,
                    'workflow.exchange',
                    `workflow.jobs.created.${key}`,
                );
            }
        }, 20000);

        afterAll(async () => {
            for (const connection of connections)
                await connection.close().catch(() => undefined);
            await admin?.close().catch(() => undefined);
            if (management && authorization) {
                await api(`/api/vhosts/${own}`, 'DELETE').catch(
                    () => undefined,
                );
                await api(`/api/users/${own}`, 'DELETE').catch(() => undefined);
            }
        }, 20000);

        it('delays transient Run/setup admission, preserves canonical identities and dead-letters exhaustion', async () => {
            const pub = await user();
            const actions: string[] = [];
            const retry = new RuntimeRunRetry(
                {
                    publish: async (exchange, key, bytes, options) => {
                        const result = await confirmed(
                            pub,
                            exchange,
                            key,
                            bytes,
                            options ?? {},
                        );
                        actions.push('confirmed');
                        return result;
                    },
                },
                { maxRetries: 2, delayMs: 100, maxDelayMs: 30000 },
            );
            const counts = new Map<string, number>();
            const canonical = new Set<string>();
            let completed!: () => void;
            let awaited = new Promise<void>((r) => {
                completed = r;
            });
            let alwaysFail = '';
            const attempts: number[] = [];
            const accept = async (id: string) => {
                const n = (counts.get(id) ?? 0) + 1;
                counts.set(id, n);
                attempts.push(Date.now());
                if (n === 1 || id === alwaysFail)
                    throw new Error('synthetic transient failure');
                canonical.add(id);
                completed();
                return id;
            };
            const engine = {
                start: async (r: { runId: string }) => accept(r.runId),
                startSetup: async (r: { key: string }) => accept(r.key),
                stop: async () => undefined,
                approve: async () => undefined,
            };
            const consumer = new RuntimeCommandConsumer(
                engine as any,
                new InMemoryRunProjectionStore(),
                new InMemoryCommandStore(), new InMemoryPrAdmissionStore(),
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                retry,
            );
            const sub = await user();
            const ack = sub.ack.bind(sub);
            sub.ack = (m, all) => {
                actions.push('ack');
                return ack(m, all);
            };
            const connection = {
                setupQueue: (AmqpConnection.prototype as any).setupQueue,
                wrapConsumer: (fn: any) => fn,
                deserializeMessage: (AmqpConnection.prototype as any)
                    .deserializeMessage,
                registerConsumerForQueue: () => undefined,
                logger: { error: () => undefined, warn: () => undefined },
                config: {
                    deserializer: (b: Buffer) => JSON.parse(b.toString()),
                    defaultSubscribeErrorBehavior:
                        MessageHandlerErrorBehavior.NACK,
                },
            };
            const options = Reflect.getMetadata(
                RABBIT_HANDLER,
                RuntimeCommandConsumer.prototype.onMessage,
            );
            await (AmqpConnection.prototype as any).setupSubscriberChannel.call(
                connection,
                consumer.onMessage.bind(consumer),
                options,
                sub,
                'Runtime fixture',
            );
            const request = shopRunRequest();
            const first = Buffer.from(
                JSON.stringify(
                    runtimeEnvelope(
                        RuntimeEventName.RunRequested,
                        request,
                        'broker-run',
                    ),
                ),
            );
            await confirmed(
                channel,
                'workflow.exchange',
                'workflow.jobs.created.RUNTIME_RUN',
                first,
                {
                    persistent: true,
                    messageId: 'broker-run',
                    correlationId: 'fixed-correlation',
                },
            );
            await within(awaited);
            expect(canonical).toEqual(new Set([request.runId]));
            expect(counts.get(request.runId)).toBe(2);
            expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(80);
            expect(actions.indexOf('confirmed')).toBeLessThan(
                actions.indexOf('ack'),
            );
            // Same Run after a lost ACK keeps its canonical identity.
            awaited = new Promise<void>((r) => {
                completed = r;
            });
            await confirmed(
                channel,
                'workflow.exchange',
                'workflow.jobs.created.RUNTIME_RUN',
                first,
                {
                    persistent: true,
                    messageId: 'broker-run',
                    correlationId: 'fixed-correlation',
                },
            );
            await within(awaited);
            expect(canonical.size).toBe(1);
            const at = new Date().toISOString();
            const setup = {
                environmentId: 'env-1',
                organizationId: 'org-fixture',
                teamId: 'team',
                repositoryId: 'repo',
                repositoryName: 'fixture/app',
                requestedBy: { userId: 'u' },
                requestedAt: at,
                key: 'setup-canonical',
            };
            awaited = new Promise<void>((r) => {
                completed = r;
            });
            await confirmed(
                channel,
                'workflow.exchange',
                'workflow.jobs.created.RUNTIME_RUN',
                Buffer.from(
                    JSON.stringify(
                        runtimeEnvelope(
                            RuntimeCommandName.EnvironmentSetupRequested,
                            setup,
                            'broker-setup',
                        ),
                    ),
                ),
                { persistent: true, messageId: 'broker-setup' },
            );
            await within(awaited);
            expect(counts.get(setup.key)).toBe(2);
            expect(canonical.has(setup.key)).toBe(true);
            const exhausted = shopRunRequest({
                pullRequest: { ...request.pullRequest, number: 98 },
            });
            alwaysFail = exhausted.runId;
            const content = Buffer.from(
                JSON.stringify(
                    runtimeEnvelope(
                        RuntimeEventName.RunRequested,
                        exhausted,
                        'exhausted',
                    ),
                ),
            );
            await confirmed(
                channel,
                'workflow.exchange',
                'workflow.jobs.created.RUNTIME_RUN',
                content,
                { persistent: true, messageId: 'exhausted' },
            );
            const dead = await getDeadLetter();
            expect(dead.content).toEqual(content);
            expect(dead.properties.messageId).toBe('exhausted');
            expect(dead.properties.headers?.['x-retry-count']).toBe(2);
            expect(dead.properties.headers).not.toHaveProperty('x-last-error');
            expect(counts.get(alwaysFail)).toBe(3);
            expect(canonical.has(alwaysFail)).toBe(false);
            await sub.close();
        }, 20000);

        it('isolates retry destinations and denies shared publication, control binding and exchange bridges', async () => {
            const denied = async (
                operation: (ch: ConfirmChannel) => Promise<unknown>,
            ) => {
                const ch = await user();
                try {
                    await within(operation(ch));
                    return false;
                } catch {
                    return true;
                } finally {
                    await ch.close().catch(() => undefined);
                }
            };
            for (const [exchange, key] of [
                [
                    'workflow.exchange.delayed',
                    'workflow.jobs.created.CODE_REVIEW',
                ],
                [
                    'workflow.exchange.delayed',
                    'workflow.jobs.created.RUNTIME_CONTROL',
                ],
                ['workflow.exchange', 'workflow.jobs.created.RUNTIME_RUN'],
                ['workflow.exchange', 'workflow.jobs.created.CODE_REVIEW'],
            ])
                expect(
                    await denied((ch) =>
                        confirmed(ch, exchange, key, Buffer.from('{}'), {
                            persistent: true,
                        }),
                    ),
                ).toBe(true);
            expect(
                await denied((ch) =>
                    ch.bindQueue(
                        'workflow.jobs.runtime_control.queue',
                        RUNTIME_RUN_RETRY_EXCHANGE,
                        'workflow.jobs.created.RUNTIME_CONTROL',
                    ),
                ),
            ).toBe(true);
            expect(
                await denied((ch) =>
                    ch.bindExchange(
                        'workflow.exchange',
                        RUNTIME_RUN_RETRY_EXCHANGE,
                        '#',
                    ),
                ),
            ).toBe(true);
            expect(
                await denied((ch) =>
                    ch.assertExchange(
                        RUNTIME_RUN_RETRY_EXCHANGE,
                        'x-delayed-message',
                        {
                            durable: true,
                            arguments: { 'x-delayed-type': 'direct' },
                        },
                    ),
                ),
            ).toBe(true);
            const ch = await user();
            await expect(
                ch.checkExchange(RUNTIME_RUN_RETRY_EXCHANGE),
            ).resolves.toBeDefined();
            await expect(
                confirmed(
                    ch,
                    'workflow.exchange',
                    'workflow.jobs.created.RUNTIME_PUBLISH',
                    Buffer.from('{}'),
                    { persistent: true },
                ),
            ).resolves.toEqual(expect.any(Boolean));
            // Topic-key ACLs are not claimed for x-delayed. Unknown keys confirm,
            // but cannot reach product/control destinations through this topology.
            await confirmed(
                ch,
                RUNTIME_RUN_RETRY_EXCHANGE,
                'workflow.jobs.created.CODE_REVIEW',
                Buffer.from('{}'),
                { persistent: true },
            );
            await confirmed(
                ch,
                RUNTIME_RUN_RETRY_EXCHANGE,
                'workflow.jobs.created.RUNTIME_CONTROL',
                Buffer.from('{}'),
                { persistent: true },
            );
            expect(
                await channel.get('workflow.jobs.code_review.queue', {
                    noAck: true,
                }),
            ).toBe(false);
            expect(
                await channel.get('workflow.jobs.runtime_control.queue', {
                    noAck: true,
                }),
            ).toBe(false);
        }, 20000);
    },
);
