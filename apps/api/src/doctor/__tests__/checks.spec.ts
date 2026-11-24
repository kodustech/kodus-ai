jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));

import {
    BrokerProbe,
    brokerCheck,
    DelayedRoundTrip,
    REVIEW_JOB_TYPES,
    staleJobsCheck,
} from '../checks/broker.checks';
import { bootEnvCheck, configEnvCheck } from '../checks/env.checks';
import {
    gitAccessCheck,
    judgeWebhookAnswer,
    WEBHOOK_EVENTS_CAP,
    webhookUrlCheck,
} from '../checks/git.checks';
import { llmCheck } from '../checks/llm.checks';
import {
    analyticsCheck,
    astGraphCheck,
    editionCheck,
    mongoCheck,
    sandboxCheck,
    seatsCheck,
    setupCheck,
    skipSettingsCheck,
    versionCheck,
} from '../checks/setup.checks';
import {
    DoctorContext,
    DoctorResult,
    DoctorTeam,
    licenseCandidates,
    RECENT_DAYS,
} from '../doctor.types';

const HEX = 'a'.repeat(64);

/** A clean install: every in-scope condition healthy. */
const cleanEnv = (): NodeJS.ProcessEnv => ({
    API_CRYPTO_KEY: HEX,
    CODE_MANAGEMENT_SECRET: HEX,
    CODE_MANAGEMENT_WEBHOOK_TOKEN: 'webhook-token-value',
    API_WEBHOOKS_PORT: '3332',
    API_RABBITMQ_ENABLED: 'true',
    API_RABBITMQ_URI: 'amqp://rabbitmq:5672/kodus-ai',
    WEB_NODE_ENV: 'self-hosted',
    API_LOG_LEVEL: 'info',
    API_LLM_PROVIDER_MODEL: 'gpt-4.1',
    API_OPEN_AI_API_KEY: 'sk-test-key-1234567890',
    API_GITHUB_CODE_MANAGEMENT_WEBHOOK: 'https://api.acme.dev/github/webhook',
    API_E2B_KEY: 'e2b-key',
    API_EXA_KEY: 'exa-key',
    API_MCP_SERVER_ENABLED: 'true',
    RESEND_API_KEY: 're_123456789',
});

const team = (over: Partial<DoctorTeam> = {}): DoctorTeam => ({
    organizationId: '11111111-1111-1111-1111-111111111111',
    organizationName: 'acme',
    organizationActive: true,
    teamId: '22222222-2222-2222-2222-222222222222',
    teamName: 'core',
    teamStatus: 'active',
    platform: 'GITHUB',
    integrationActive: true,
    repositories: [{ id: '1', name: 'api', fullName: 'acme/api' }],
    codeReviewAutomationActive: true,
    ...over,
});

const ctx = (over: Partial<DoctorContext> = {}): DoctorContext => ({
    teams: [team()],
    codeReviewAutomationSeeded: true,
    licensed: true,
    env: cleanEnv(),
    ...over,
});

const statuses = (results: DoctorResult[]) => results.map((r) => r.status);
const problems = (results: DoctorResult[]) =>
    results.filter((r) => r.status === 'fail' || r.status === 'warn');

/** Every fail/warn line must say what is lost and what to do. */
function expectActionable(results: DoctorResult[]) {
    for (const r of problems(results)) {
        expect(r.impact).toBeTruthy();
        expect(r.fix).toBeTruthy();
    }
}

const healthyBroker = (
    over: {
        consumers?: Record<string, number | null>;
        delayed?: boolean;
        delayedTrip?: DelayedRoundTrip;
        connectError?: Error;
    } = {},
): BrokerProbe => ({
    connect: jest.fn(async () => {
        if (over.connectError) {
            throw over.connectError;
        }
        return {
            consumerCount: async (q: string) =>
                over.consumers && q in over.consumers ? over.consumers[q] : 1,
            exchangeExists: async () => over.delayed ?? true,
            delayedRoundTrip: async () =>
                over.delayedTrip ?? { outcome: 'arrived' },
            close: async () => undefined,
        };
    }),
});

const dataSource = (
    rows: {
        pending?: any;
        backlog?: any[];
        outcome?: any;
        unsent?: any;
    } = {},
) =>
    ({
        query: jest.fn(async (sql: string) =>
            sql.includes('outbox_messages')
                ? [rows.unsent ?? { count: 0 }]
                : sql.includes('FILTER')
                  ? [
                        rows.outcome ?? {
                            total: 0,
                            failed: 0,
                            stranded: 0,
                            topError: null,
                        },
                    ]
                  : sql.includes('NOT ("workflowType"')
                    ? (rows.backlog ?? [])
                    : [rows.pending ?? { count: 0, oldest: null }],
        ),
    }) as any;

const llmDeps = (over: { byok?: any; fail?: Error } = {}) => ({
    getBYOKConfig: jest.fn(async () => over.byok ?? null),
    complete: jest.fn(async () => {
        if (over.fail) {
            throw over.fail;
        }
    }),
});

const healthyGit = (
    over: Partial<Record<'read' | 'write' | 'hook', string>> = {},
) => ({
    diagnose: jest.fn(async () => ({
        read: 'ok',
        write: 'ok',
        hook: 'present',
        ...over,
    })) as any,
    probe: jest.fn(async () => ({
        status: 200,
        body: 'Webhook ignored (event not supported)',
    })),
    recentEvents: jest.fn(
        async (): Promise<{ count: number; last: Date | null }> => ({
            count: 0,
            last: null,
        }),
    ),
});

/** An organization a sign-up created for itself: no Git, nothing to review. */
const emptyOrganizationTeam = (over: Partial<DoctorTeam> = {}) =>
    team({
        organizationId: '33333333-3333-3333-3333-333333333333',
        organizationName: 'a-signup-Xy12',
        teamId: '44444444-4444-4444-4444-444444444444',
        platform: undefined,
        integrationActive: false,
        repositories: [],
        ...over,
    });

describe('doctor checks — each condition in scope, one at a time', () => {
    describe('clean install', () => {
        it('produces no ✘ and no ! results', async () => {
            const c = ctx();
            const results = [
                ...(await bootEnvCheck.run(c)),
                ...(await configEnvCheck.run(c)),
                ...(await brokerCheck(healthyBroker()).run(c)),
                ...(await staleJobsCheck(dataSource()).run(c)),
                ...(await setupCheck.run(c)),
                ...(await llmCheck(llmDeps()).run(c)),
                ...(await gitAccessCheck(healthyGit()).run(c)),
                ...(await webhookUrlCheck(healthyGit()).run(c)),
                ...(await seatsCheck(async () => ({
                    pullRequests: 0,
                    since: new Date(),
                })).run(c)),
                ...(await sandboxCheck(async () => [
                    { team: c.teams[0], repository: 'api' },
                ]).run(c)),
                ...(await mongoCheck(async () => undefined).run(c)),
                ...(await astGraphCheck(async () => [
                    { team: c.teams[0], repository: 'api', status: 'ready' },
                ]).run(c)),
                ...(await versionCheck(async () => ({
                    current: '2.3.0',
                    latest: '2.3.0',
                    updateAvailable: false,
                })).run(c)),
                ...(await skipSettingsCheck(async () => []).run(c)),
                ...(await editionCheck.run(c)),
                ...(await analyticsCheck(async () => ({
                    status: 'ok',
                    finishedAt: new Date(),
                    lagHours: 2,
                })).run(c)),
            ];
            expect(problems(results)).toEqual([]);
        });
    });

    describe('blocking (✘)', () => {
        it.each([
            ['API_CRYPTO_KEY', 'short'],
            ['CODE_MANAGEMENT_SECRET', undefined],
            ['CODE_MANAGEMENT_WEBHOOK_TOKEN', ''],
            ['API_WEBHOOKS_PORT', 'abc'],
        ])('boot env %s broken', async (key, value) => {
            const env = cleanEnv();
            env[key] = value;
            const results = await bootEnvCheck.run(ctx({ env }));
            expect(statuses(results)).toEqual(['fail']);
            expect(results[0].fix).toContain(key);
            expectActionable(results);
        });

        it('RabbitMQ disabled', async () => {
            const env = cleanEnv();
            env.API_RABBITMQ_ENABLED = 'false';
            const results = await brokerCheck(healthyBroker()).run(
                ctx({ env }),
            );
            expect(statuses(results)).toEqual(['fail']);
            expectActionable(results);
        });

        it('RabbitMQ unreachable', async () => {
            const results = await brokerCheck(
                healthyBroker({ connectError: new Error('ECONNREFUSED') }),
            ).run(ctx());
            expect(results[0]).toMatchObject({
                status: 'fail',
                check: 'broker.connect',
            });
            expectActionable(results);
        });

        it('no code-review worker consuming', async () => {
            const results = await brokerCheck(
                healthyBroker({
                    consumers: { 'workflow.jobs.code_review.queue': 0 },
                }),
            ).run(ctx());
            expect(
                results.find((r) => r.check === 'worker.consumers')?.status,
            ).toBe('fail');
            expectActionable(results);
        });

        it('worker never started (queue missing)', async () => {
            const results = await brokerCheck(
                healthyBroker({
                    consumers: { 'workflow.jobs.webhook.queue': null },
                }),
            ).run(ctx());
            expect(
                results.find((r) => r.check === 'worker.consumers')?.status,
            ).toBe('fail');
        });

        it('delayed messages that never come back degrade (RabbitMQ 4.2 + khepri_db, #2654)', async () => {
            const results = await brokerCheck(
                healthyBroker({ delayedTrip: { outcome: 'lost' } }),
            ).run(ctx());
            expect(
                results.find((r) => r.check === 'broker.delayed_delivery'),
            ).toMatchObject({ status: 'warn' });
            expectActionable(results);
        });

        it('a broker that blocks publishers (resource alarm, #1694) fails, and the worker lines are kept', async () => {
            const results = await brokerCheck(
                healthyBroker({
                    delayedTrip: {
                        outcome: 'blocked',
                        reason: 'low on disk',
                    },
                }),
            ).run(ctx());
            expect(
                results.find((r) => r.check === 'broker.blocked'),
            ).toMatchObject({
                status: 'fail',
                title: 'The message queue is blocking publishers (low on disk).',
            });
            expect(
                results.find((r) => r.check === 'worker.consumers')?.status,
            ).toBe('ok');
            expectActionable(results);
        });

        it('delayed-message plugin missing', async () => {
            const results = await brokerCheck(
                healthyBroker({ delayed: false }),
            ).run(ctx());
            expect(
                results.find((r) => r.check === 'broker.delayed_plugin')
                    ?.status,
            ).toBe('fail');
            expectActionable(results);
        });

        it('stale PENDING jobs', async () => {
            const results = await staleJobsCheck(
                dataSource({ pending: { count: 3, oldest: new Date() } }),
            ).run(ctx());
            expect(statuses(results)).toEqual(['fail']);
            expectActionable(results);
        });

        it('outbox rows not reaching the broker', async () => {
            const results = await staleJobsCheck(
                dataSource({ unsent: { count: 2 } }),
            ).run(ctx());
            expect(results[0]).toMatchObject({
                status: 'fail',
                check: 'jobs.outbox',
            });
        });

        it('job and outbox failures older than the window are not counted', async () => {
            // FAILED outbox rows are never cleaned and PENDING jobs never reaped:
            // an incident from months ago must not read as a failure today.
            const ds = dataSource();
            await staleJobsCheck(ds).run(ctx());

            expect(ds.query).toHaveBeenCalledTimes(4);
            for (const [sql, params] of ds.query.mock.calls) {
                expect(sql).toMatch(
                    /"createdAt" > now\(\) - make_interval\(days => \$[12]\)/,
                );
                expect(params).toContain(RECENT_DAYS);
            }
        });

        it('only review jobs waiting count; a code graph backlog is not a failure', async () => {
            const ds = dataSource({
                backlog: [{ type: 'AST_GRAPH_BUILD', count: 9 }],
            });
            const results = await staleJobsCheck(ds).run(ctx());

            expect(problems(results)).toEqual([]);
            expect(
                results.find((r) => r.check === 'jobs.background'),
            ).toMatchObject({
                status: 'info',
                title: '9 background job(s) are waiting their turn (9 AST_GRAPH_BUILD).',
            });
            const [pendingSql, pendingParams] = ds.query.mock.calls[0];
            expect(pendingSql).toContain('"workflowType"::text = ANY($3)');
            expect(pendingParams[2]).toEqual(REVIEW_JOB_TYPES);
        });

        it('review jobs that failed for good: every one fails, a share degrades', async () => {
            const all = await staleJobsCheck(
                dataSource({
                    outcome: {
                        total: 4,
                        failed: 4,
                        stranded: 0,
                        topError: 'Request failed with status code 401',
                    },
                }),
            ).run(ctx());
            const some = await staleJobsCheck(
                dataSource({
                    outcome: { total: 20, failed: 3, stranded: 0 },
                }),
            ).run(ctx());

            expect(all.find((r) => r.check === 'jobs.failed')).toMatchObject({
                status: 'fail',
            });
            expect(all.find((r) => r.check === 'jobs.failed')?.fix).toContain(
                'status code 401',
            );
            expect(some.find((r) => r.check === 'jobs.failed')?.status).toBe(
                'warn',
            );
            expectActionable(all);
        });

        it('review jobs a dead worker left PROCESSING degrade', async () => {
            const results = await staleJobsCheck(
                dataSource({
                    outcome: { total: 10, failed: 0, stranded: 2 },
                }),
            ).run(ctx());
            expect(
                results.find((r) => r.check === 'jobs.stranded')?.status,
            ).toBe('warn');
            expectActionable(results);
        });

        it('MongoDB unreachable', async () => {
            const results = await mongoCheck(async () => {
                throw new Error('not connected (mongoose state 0)');
            }).run(ctx());
            expect(statuses(results)).toEqual(['fail']);
            expect(results[0].fix).toContain('mongoose state 0');
            expectActionable(results);
        });

        it('LLM: an organization with nothing to review is not probed', async () => {
            const deps = {
                getBYOKConfig: jest.fn(async () => null),
                complete: jest.fn(
                    async ({ organizationId }: { organizationId?: string }) => {
                        if (organizationId !== team().organizationId) {
                            throw new Error('Bad Request');
                        }
                    },
                ),
            };
            const results = await llmCheck(deps).run(
                ctx({ teams: [emptyOrganizationTeam(), team()] }),
            );

            expect(problems(results)).toEqual([]);
            expect(deps.getBYOKConfig).not.toHaveBeenCalledWith(
                emptyOrganizationTeam().organizationId,
            );
        });

        it('LLM: with nothing to review yet, the model is still probed', async () => {
            const deps = llmDeps({ fail: new Error('401 invalid key') });
            const results = await llmCheck(deps).run(
                ctx({ teams: [team({ repositories: [] })] }),
            );

            expect(deps.complete).toHaveBeenCalledTimes(1);
            expect(
                results.find((r) => r.check === 'llm.completion')?.status,
            ).toBe('fail');
        });

        it('LLM completion fails (env model)', async () => {
            const results = await llmCheck(
                llmDeps({ fail: new Error('401 invalid key') }),
            ).run(ctx());
            const line = results.find((r) => r.check === 'llm.completion');
            expect(line?.status).toBe('fail');
            expect(line?.fix).toContain('401 invalid key');
            expectActionable(results);
        });

        it('a failing server model names the organizations that depend on it (#2021)', async () => {
            const byok = {
                version: 2,
                credentials: [
                    { id: 'c1', provider: 'google_gemini', apiKey: 'x' },
                ],
                models: [
                    { id: 'm1', credentialId: 'c1', model: 'gemini-2.5-flash' },
                ],
                routing: { defaultModelId: 'm1' },
            };
            const deps = {
                getBYOKConfig: jest.fn(async (organizationId: string) =>
                    organizationId === 'byok-org' ? (byok as any) : null,
                ),
                complete: jest.fn(async ({ slot }: { slot?: unknown }) => {
                    if (!slot) {
                        throw new Error('insufficient balance');
                    }
                }),
            };
            const teams = [
                team({
                    organizationId: 'byok-org',
                    organizationName: 'uses-byok',
                }),
                team({ organizationId: 'env-a', organizationName: 'alpha' }),
                team({ organizationId: 'env-b', organizationName: 'beta' }),
            ];

            const results = await llmCheck(deps).run(ctx({ teams }));
            const failures = results.filter(
                (r) => r.check === 'llm.completion' && r.status === 'fail',
            );

            expect(failures).toHaveLength(1);
            expect(failures[0].scope).toContain('alpha');
            expect(failures[0].scope).toContain('beta');
            expect(failures[0].scope).not.toContain('uses-byok');
        });

        it('LLM failure never prints the provider account or key id (#2021)', async () => {
            const results = await llmCheck(
                llmDeps({
                    fail: new Error(
                        'Your account org-0123456789abcdef0123456789abcdef <ak-f00ba7f00ba7f00ba7> is suspended due to insufficient balance, please recharge your account',
                    ),
                }),
            ).run(ctx());
            const line = results.find((r) => r.check === 'llm.completion');

            expect(line?.status).toBe('fail');
            expect(`${line?.title} ${line?.fix}`).not.toMatch(
                /org-[0-9a-f]{8}|ak-[a-z0-9]{8}/,
            );
            expect(line?.fix).toContain('insufficient balance');
        });

        it('no LLM configured at all', async () => {
            const env = cleanEnv();
            delete env.API_LLM_PROVIDER_MODEL;
            const deps = llmDeps();
            const results = await llmCheck(deps).run(ctx({ env }));
            expect(results[0]).toMatchObject({
                status: 'fail',
                check: 'llm.configured',
            });
            expect(deps.complete).not.toHaveBeenCalled();
        });

        it('an invalid declared env model fails with its reason, not "no model"', async () => {
            const env = cleanEnv();
            env.API_LLM_PROVIDER = 'openrouter';
            const deps = llmDeps();
            const results = await llmCheck(deps).run(ctx({ env }));
            expect(results[0]).toMatchObject({
                status: 'fail',
                check: 'llm.configured',
                title: 'The server LLM configuration is invalid: API_LLM_PROVIDER="openrouter" is not supported. Use one of: openai, openai_compatible, anthropic, anthropic_compatible, google_gemini, google_vertex.',
            });
            expect(deps.complete).not.toHaveBeenCalled();
            expectActionable(results);
        });

        it('says whether the server model provider was declared or guessed', async () => {
            const guessed = await llmCheck(llmDeps()).run(ctx());
            expect(
                guessed.find((r) => r.check === 'llm.env_provider')?.title,
            ).toContain('guessed from the model name');

            const env = cleanEnv();
            env.API_LLM_PROVIDER = 'openai';
            const declared = await llmCheck(llmDeps()).run(ctx({ env }));
            expect(
                declared.find((r) => r.check === 'llm.env_provider')?.title,
            ).toContain('set in API_LLM_PROVIDER');
        });

        it('does not report the server model origin when every org runs on BYOK', async () => {
            const byok = {
                version: 2,
                credentials: [{ id: 'c1', provider: 'openai', apiKey: 'x' }],
                models: [{ id: 'm1', credentialId: 'c1', model: 'gpt-4.1' }],
                routing: { defaultModelId: 'm1' },
            };
            const results = await llmCheck(llmDeps({ byok })).run(ctx());
            expect(
                results.find((r) => r.check === 'llm.env_provider'),
            ).toBeUndefined();
        });

        it('reports a base URL carrying the SDK endpoint with its own fix', async () => {
            const env = cleanEnv();
            env.API_OPENAI_FORCE_BASE_URL =
                'https://proxy.example/v1/chat/completions';
            const results = await llmCheck(llmDeps()).run(ctx({ env }));
            // Kodus calls the corrected URL, so reviews are not degraded.
            expect(
                results.find((r) => r.check === 'llm.env_base_url'),
            ).toMatchObject({
                status: 'info',
                title: 'API_OPENAI_FORCE_BASE_URL ends with the endpoint the provider SDK adds itself; https://proxy.example/v1 is used.',
            });
            expect(
                results.find((r) => r.check === 'llm.env_conflict'),
            ).toBeUndefined();
            expectActionable(results);
        });

        it('warns when the generic and the legacy key disagree', async () => {
            const env = cleanEnv();
            env.API_LLM_PROVIDER = 'anthropic';
            env.API_LLM_API_KEY = 'sk-other-key-0987654321';
            env.API_ANTHROPIC_API_KEY = 'sk-ant-key-1234567890';
            const results = await llmCheck(llmDeps()).run(ctx({ env }));
            expect(
                results.find((r) => r.check === 'llm.env_conflict'),
            ).toMatchObject({
                status: 'warn',
                title: 'API_LLM_API_KEY and API_ANTHROPIC_API_KEY are both set to different values; API_LLM_API_KEY is used.',
            });
            expectActionable(results);
        });

        it('does not flag the OpenAI key kept for embeddings as a conflict', async () => {
            const env = cleanEnv();
            env.API_LLM_PROVIDER = 'openai';
            env.API_LLM_API_KEY = 'sk-other-key-0987654321';
            const results = await llmCheck(llmDeps()).run(ctx({ env }));
            expect(
                results.find((r) => r.check === 'llm.env_conflict'),
            ).toBeUndefined();
        });

        it('warns when the legacy base URL points a declared openai at another host', async () => {
            const env = cleanEnv();
            env.API_LLM_PROVIDER = 'openai';
            env.API_OPENAI_FORCE_BASE_URL = 'https://openrouter.test/api/v1';
            const results = await llmCheck(llmDeps()).run(ctx({ env }));
            expect(
                results.find((r) => r.check === 'llm.env_base_url'),
            ).toMatchObject({
                status: 'warn',
                fix: 'For a proxy, set API_LLM_PROVIDER=openai_compatible; otherwise remove API_OPENAI_FORCE_BASE_URL.',
            });
            expectActionable(results);
        });

        it('warns when the env reasoning effort is one the model cannot honor', async () => {
            const env = cleanEnv();
            env.API_LLM_PROVIDER = 'openai_compatible';
            env.API_LLM_BASE_URL = 'https://api.minimax.test/v1';
            env.API_LLM_PROVIDER_MODEL = 'minimax-m2.5';
            env.API_LLM_REASONING_EFFORT = 'none';
            const results = await llmCheck(llmDeps()).run(ctx({ env }));
            const tuning = results.find((r) => r.check === 'llm.env_tuning');
            expect(tuning?.status).toBe('warn');
            expect(tuning?.title).toMatch(/^API_LLM_REASONING_EFFORT: /);
            expectActionable(results);
        });

        it('git token cannot read', async () => {
            const results = await gitAccessCheck(
                healthyGit({ read: 'denied' }),
            ).run(ctx());
            expect(results.find((r) => r.check === 'git.read')?.status).toBe(
                'fail',
            );
            expectActionable(results);
        });

        it('git token cannot comment', async () => {
            const results = await gitAccessCheck(
                healthyGit({ write: 'denied' }),
            ).run(ctx());
            expect(results.find((r) => r.check === 'git.write')?.status).toBe(
                'fail',
            );
        });

        it('webhook missing on a selected repo', async () => {
            const results = await gitAccessCheck(
                healthyGit({ hook: 'missing' }),
            ).run(ctx());
            const line = results.find((r) => r.check === 'git.webhook');
            expect(line?.status).toBe('fail');
            expect(line?.fix).toContain('https://api.acme.dev/github/webhook');
        });

        it('a missing hook still shows read and comment access as conforming', async () => {
            const results = await gitAccessCheck(
                healthyGit({ hook: 'missing' }),
            ).run(ctx());
            const ok = results
                .filter((r) => r.status === 'ok')
                .map((r) => r.check);
            expect(ok).toEqual(['git.read', 'git.write']);
        });

        it('webhook URL unset: no per-repo webhook line, no false "receives events"', async () => {
            const env = cleanEnv();
            delete env.API_GITHUB_CODE_MANAGEMENT_WEBHOOK;
            const results = await gitAccessCheck(
                healthyGit({ hook: 'unknown' }),
            ).run(ctx({ env }));
            expect(results.map((r) => r.check)).toEqual([
                'git.read',
                'git.write',
            ]);
        });

        it('GitHub App installs use the app-level hook: fine once events arrive', async () => {
            const git = {
                ...healthyGit({ hook: 'app-level' }),
                deliveredEvents: jest.fn(async () => ({
                    platformEvents: 3,
                    repositoryIds: new Set(['1']),
                })),
            };
            const results = await gitAccessCheck(git).run(ctx());
            expect(problems(results)).toEqual([]);
            expect(results.find((r) => r.check === 'git.webhook')?.status).toBe(
                'ok',
            );
        });

        it('a GitHub App that delivered nothing is unverified, not "receives events"', async () => {
            const results = await gitAccessCheck(
                healthyGit({ hook: 'app-level' }),
            ).run(ctx());
            const line = results.find((r) => r.check === 'git.webhook');
            expect(line).toMatchObject({ status: 'unknown', blocking: true });
            expect(line?.fix).toContain('GitHub Apps');
        });

        it('a repository hook the provider no longer accepts (stale token) fails', async () => {
            const results = await gitAccessCheck(
                healthyGit({ hook: 'stale' }),
            ).run(ctx());
            expect(
                results.find((r) => r.check === 'git.webhook'),
            ).toMatchObject({ status: 'fail' });
            expectActionable(results);
        });

        it('no repository hook, but events arrive from that repository: an org or group hook delivers', async () => {
            const git = {
                ...healthyGit({ hook: 'missing' }),
                deliveredEvents: jest.fn(async () => ({
                    platformEvents: 5,
                    repositoryIds: new Set(['1']),
                })),
            };
            const results = await gitAccessCheck(git).run(ctx());
            expect(problems(results)).toEqual([]);
            expect(results.find((r) => r.check === 'git.webhook')?.status).toBe(
                'ok',
            );
        });

        it('no repository hook and no event from it, while other repositories deliver: unverified', async () => {
            const git = {
                ...healthyGit({ hook: 'missing' }),
                deliveredEvents: jest.fn(async () => ({
                    platformEvents: 5,
                    repositoryIds: new Set(['999']),
                })),
            };
            const results = await gitAccessCheck(git).run(ctx());
            const line = results.find((r) => r.check === 'git.webhook');
            expect(line).toMatchObject({ status: 'unknown', blocking: true });
            expect(line?.fix).toContain('organization or group webhook');
        });

        it('events that could not be read are not "no event arrived": a missing hook is unverified, not failed', async () => {
            const git = {
                ...healthyGit({ hook: 'missing' }),
                deliveredEvents: jest.fn(async () => {
                    throw new Error('relation does not exist');
                }),
            };
            const results = await gitAccessCheck(git).run(ctx());
            expect(problems(results)).toEqual([]);
            expect(
                results.find((r) => r.check === 'git.webhook'),
            ).toMatchObject({ status: 'unknown', blocking: true });
        });

        it('a stale hook whose repository delivered this week is unverified, not failed', async () => {
            const git = {
                ...healthyGit({ hook: 'stale' }),
                deliveredEvents: jest.fn(async () => ({
                    platformEvents: 2,
                    repositoryIds: new Set(['1']),
                })),
            };
            const results = await gitAccessCheck(git).run(ctx());
            expect(problems(results)).toEqual([]);
            expect(
                results.find((r) => r.check === 'git.webhook'),
            ).toMatchObject({ status: 'unknown', blocking: true });
        });

        it('a GitHub App repository with unreadable events gets App advice, not repository-hook advice', async () => {
            const git = {
                ...healthyGit({ hook: 'app-level' }),
                deliveredEvents: jest.fn(async () => {
                    throw new Error('statement timeout');
                }),
            };
            const results = await gitAccessCheck(git).run(ctx());
            const line = results.find((r) => r.check === 'git.webhook');
            expect(line).toMatchObject({ status: 'unknown', blocking: true });
            expect(line?.title).toContain('GitHub App');
            expect(line?.title).not.toContain('No repository webhook');
            expect(line?.fix).toContain('GitHub Apps');
        });

        it('a stale hook is unverified, not failed, when the received events could not be read', async () => {
            const git = {
                ...healthyGit({ hook: 'stale' }),
                deliveredEvents: jest.fn(async () => {
                    throw new Error('statement timeout');
                }),
            };
            const results = await gitAccessCheck(git).run(ctx());
            expect(problems(results)).toEqual([]);
            expect(
                results.find((r) => r.check === 'git.webhook'),
            ).toMatchObject({ status: 'unknown', blocking: true });
        });

        it('comment lookups run a few at a time, not one per repository at once', async () => {
            const repos = Array.from({ length: 10 }, (_, i) => ({
                id: String(i + 1),
                name: `repo-${i + 1}`,
            }));
            let inFlight = 0;
            let peak = 0;
            const git = {
                ...healthyGit({ write: 'unknown' }),
                postedComments: jest.fn(async () => {
                    inFlight += 1;
                    peak = Math.max(peak, inFlight);
                    await new Promise((r) => setImmediate(r));
                    inFlight -= 1;
                    return 1;
                }),
            };
            const results = await gitAccessCheck(git).run(
                ctx({ teams: [team({ repositories: repos })] }),
            );
            expect(git.postedComments).toHaveBeenCalledTimes(10);
            expect(peak).toBeLessThanOrEqual(3);
            expect(
                results.find((r) => r.check === 'git.unverified'),
            ).toBeUndefined();
        });

        it('a comment lookup that hangs is cut at the ceiling, the check still reports', async () => {
            let clock = 0;
            const git = {
                ...healthyGit({ write: 'unknown' }),
                now: () => clock,
                postedComments: jest.fn(() => {
                    clock = 10 * 60_000; // past deadline + grace
                    return new Promise<number>(() => undefined);
                }),
            };
            const results = await gitAccessCheck(git).run(ctx());
            expect(
                results.find((r) => r.check === 'git.unverified')?.title,
            ).toContain('comment on pull requests in api');
        });

        it('write access the provider does not report is proven by comments Kody posted', async () => {
            const git = {
                ...healthyGit({ write: 'unknown' }),
                postedComments: jest.fn(async () => 1),
            };
            const results = await gitAccessCheck(git).run(ctx());
            expect(
                results.find((r) => r.check === 'git.unverified'),
            ).toBeUndefined();
            expect(results.find((r) => r.check === 'git.write')?.status).toBe(
                'ok',
            );
            expect(git.postedComments).toHaveBeenCalledWith(
                ctx().teams[0],
                '1',
            );
        });

        describe('webhook address probed with an empty POST when no event arrived', () => {
            const probed = async (
                answer: { status: number; body: string },
                env = cleanEnv(),
            ) => {
                const git = healthyGit();
                git.probe.mockResolvedValue(answer);
                return webhookUrlCheck(git).run(ctx({ env }));
            };

            it('the webhooks service dropping it unqueued proves the route', async () => {
                const results = await probed({
                    status: 200,
                    body: 'Webhook ignored (event not supported)',
                });
                expect(statuses(results)).toEqual(['ok']);
                expect(results[0].title).toContain(
                    'reaches the Kodus webhooks service',
                );
            });

            it('a Kodus 404 means no webhook route there (the API or a wrong path)', async () => {
                const results = await probed({
                    status: 404,
                    body: '{"statusCode":404,"message":"Cannot POST /github/webhook","error":"Not Found"}',
                });
                expect(statuses(results)).toEqual(['fail']);
                expect(results[0].fix).toContain('port 3332');
                expectActionable(results);
            });

            it('a proxy error fails', async () => {
                const results = await probed({
                    status: 502,
                    body: 'Bad Gateway',
                });
                expect(statuses(results)).toEqual(['fail']);
                expectActionable(results);
            });

            it('anything else (login page, web app, redirect) is unverified', async () => {
                const results = await probed({
                    status: 200,
                    body: '<!DOCTYPE html><html>',
                });
                expect(results[0]).toMatchObject({
                    status: 'unknown',
                    blocking: true,
                });
            });

            it('Azure Repos: the webhooks service rejecting a token this API minted fails', async () => {
                const env = cleanEnv();
                env.GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK =
                    'https://api.acme.dev/azure-repos/webhook';
                const git = healthyGit();
                git.probe.mockResolvedValue({
                    status: 403,
                    body: 'Unauthorized',
                });
                const results = await webhookUrlCheck(git).run(
                    ctx({ env, teams: [team({ platform: 'AZURE_REPOS' })] }),
                );
                expect(statuses(results)).toEqual(['fail']);
                expect(results[0].fix).toContain('CODE_MANAGEMENT_SECRET');
                expect(git.probe).toHaveBeenCalledWith(
                    'https://api.acme.dev/azure-repos/webhook',
                    'AZURE_REPOS',
                );
            });

            it('judges the answers per platform', () => {
                expect(
                    judgeWebhookAnswer('AZURE_REPOS', {
                        status: 400,
                        body: 'Unrecognized event',
                    }),
                ).toBe('kodus');
                expect(
                    judgeWebhookAnswer('GITLAB', {
                        status: 400,
                        body: 'Unrecognized event',
                    }),
                ).toBe('other');
                expect(
                    judgeWebhookAnswer('GITHUB', {
                        status: 403,
                        body: 'Forbidden',
                    }),
                ).toBe('other');
            });
        });

        it('webhook URL not set', async () => {
            const env = cleanEnv();
            delete env.API_GITHUB_CODE_MANAGEMENT_WEBHOOK;
            const results = await webhookUrlCheck(healthyGit()).run(
                ctx({ env }),
            );
            expect(statuses(results)).toEqual(['fail']);
            expectActionable(results);
        });

        it('webhook URL does not resolve from here and no event arrived: unverified, not failed', async () => {
            // This container's resolver and CA store are not the Git host's
            // (split-horizon DNS, private CA), so it cannot prove a failure.
            const git = healthyGit();
            git.probe.mockRejectedValue(
                Object.assign(new Error('fetch failed'), {
                    cause: { code: 'ENOTFOUND' },
                }),
            );
            const results = await webhookUrlCheck(git).run(ctx());
            expect(statuses(results)).toEqual(['unknown']);
            expect(results[0].blocking).toBe(true);
            expect(results[0].title).toContain('ENOTFOUND');
        });

        it('webhook host does not resolve from here, but events arrive: delivered', async () => {
            const git = healthyGit();
            git.probe.mockRejectedValue(
                Object.assign(new Error('fetch failed'), {
                    cause: { code: 'ENOTFOUND' },
                }),
            );
            git.recentEvents.mockResolvedValue({
                count: 12,
                last: new Date('2026-10-02T10:00:00Z'),
            });
            const results = await webhookUrlCheck(git).run(ctx());

            expect(statuses(results)).toEqual(['ok']);
            expect(results[0].title).toContain('12 GitHub event(s)');
            expect(git.recentEvents).toHaveBeenCalledWith('GITHUB');
            expect(git.probe).not.toHaveBeenCalled();
        });

        it('says "1000+" when the event count hit the cap', async () => {
            const git = healthyGit();
            git.recentEvents.mockResolvedValue({
                count: WEBHOOK_EVENTS_CAP,
                last: new Date('2026-10-02T10:00:00Z'),
            });
            const results = await webhookUrlCheck(git).run(ctx());

            expect(results[0].title).toContain(
                `${WEBHOOK_EVENTS_CAP}+ GitHub event(s)`,
            );
        });

        it('webhook URL times out from inside (NAT) is unverified, not failed', async () => {
            const git = healthyGit();
            git.probe.mockRejectedValue(
                Object.assign(new Error('timeout'), {
                    cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
                }),
            );
            const results = await webhookUrlCheck(git).run(ctx());
            expect(statuses(results)).toEqual(['unknown']);
        });

        it.each([
            ['no repository selected', { repositories: [] }],
            ['team automation off', { codeReviewAutomationActive: false }],
            ['team not active', { teamStatus: 'pending' }],
            ['git connection disabled', { integrationActive: false }],
        ])('%s, on the only team', async (_name, over) => {
            const results = await setupCheck.run(
                ctx({ teams: [team(over as any)] }),
            );
            expect(statuses(results)).toEqual(['fail']);
            expectActionable(results);
        });

        it.each([
            ['no repository selected', { repositories: [] }, 'warn'],
            ['git connection disabled', { integrationActive: false }, 'warn'],
            [
                'team automation off',
                { codeReviewAutomationActive: false },
                'skip',
            ],
        ])(
            '%s on one team while another reviews: that team only',
            async (_name, over, status) => {
                const other = team({
                    teamId: '55555555-5555-5555-5555-555555555555',
                    teamName: 'mobile',
                    ...(over as any),
                });
                const results = await setupCheck.run(
                    ctx({ teams: [team(), other] }),
                );
                expect(
                    results
                        .filter((r) => r.status !== 'ok')
                        .map((r) => [r.scope, r.status]),
                ).toEqual([['acme/mobile', status]]);
            },
        );

        it('a disabled organization is reported, not failed: no review gate reads it', async () => {
            const results = await setupCheck.run(
                ctx({ teams: [team({ organizationActive: false })] }),
            );
            expect(
                results.find((r) => r.check === 'setup.organization')?.status,
            ).toBe('info');
            expect(problems(results)).toEqual([]);
        });

        it('no Git provider connected', async () => {
            const results = await setupCheck.run(
                ctx({ teams: [team({ platform: undefined })] }),
            );
            expect(results[0]).toMatchObject({
                status: 'fail',
                check: 'setup.git_connected',
            });
        });

        it('code review automation not seeded', async () => {
            const results = await setupCheck.run(
                ctx({ codeReviewAutomationSeeded: false }),
            );
            expect(results[0]).toMatchObject({
                status: 'fail',
                check: 'setup.automation_seed',
            });
        });

        it('licensed: recent PR authors without a seat', async () => {
            const results = await seatsCheck(async () => ({
                pullRequests: 4,
                since: new Date('2026-09-08'),
            })).run(ctx());
            expect(statuses(results)).toEqual(['fail']);
            expectActionable(results);
        });

        it('Community Edition: seat check does not apply', async () => {
            const count = jest.fn();
            const results = await seatsCheck(count).run(
                ctx({ licensed: false }),
            );
            expect(results).toEqual([]);
            expect(count).not.toHaveBeenCalled();
        });
    });

    describe('time budgets (partial results instead of a lost check)', () => {
        it('Git: probes what fits in the budget and lists the rest as not checked', async () => {
            let clock = 0;
            const git = healthyGit();
            git.diagnose.mockImplementation(async () => {
                clock += 25_000; // each probe takes 25s
                return { read: 'ok', write: 'ok', hook: 'present' };
            });
            const repos = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(
                (n, i) => ({
                    id: String(i),
                    name: n,
                }),
            );
            const results = await gitAccessCheck({
                ...git,
                now: () => clock,
            }).run(ctx({ teams: [team({ repositories: repos })] }));
            const truncated = results.find((r) => r.check === 'git.truncated');
            expect(truncated?.status).toBe('info');
            expect(truncated?.title).toContain('time budget reached');
            expect(results.find((r) => r.check === 'git.read')?.status).toBe(
                'ok',
            );
            expect(git.diagnose.mock.calls.length).toBeLessThan(repos.length);
        });

        it('Git: a probe that hangs is cut at the ceiling and reported as "?", not lost', async () => {
            jest.useFakeTimers();
            try {
                const git = healthyGit();
                git.diagnose.mockImplementation(
                    () => new Promise(() => undefined),
                );
                const pending = gitAccessCheck({ ...git, now: () => 0 }).run(
                    ctx(),
                );
                await jest.advanceTimersByTimeAsync(75_000);
                const results = await pending;
                const line = results.find((r) => r.check === 'git.timed_out');
                expect(line?.status).toBe('unknown');
                expect(line?.title).toContain('did not answer in time');
                // no token or webhook advice for something never checked
                expect(
                    results.find((r) => r.check === 'git.unverified'),
                ).toBeUndefined();
                expect(results.some((r) => r.status === 'ok')).toBe(false);
            } finally {
                jest.useRealTimers();
            }
        });

        it('LLM: every probe gets the full 60s timeout (a shortened one would fail a slow model)', async () => {
            let clock = 0;
            const deps = llmDeps();
            deps.complete.mockImplementation(async () => {
                clock += 20_000; // 50s left: less than a full probe
            });
            const teams = [
                team(),
                team({
                    organizationId: '33333333-3333-3333-3333-333333333333',
                    organizationName: 'beta',
                }),
            ];
            deps.getBYOKConfig.mockResolvedValue({
                version: 2,
                credentials: [
                    { id: 'c1', provider: 'google_gemini', apiKey: 'x' },
                ],
                models: [
                    { id: 'm1', credentialId: 'c1', model: 'gemini-2.5-flash' },
                ],
                routing: { defaultModelId: 'm1' },
            } as any);
            const results = await llmCheck({ ...deps, now: () => clock }).run(
                ctx({ teams }),
            );
            expect(
                deps.complete.mock.calls.map((c: any[]) => c[0].timeoutMs),
            ).toEqual([60_000]);
            expect(
                results
                    .filter((r) => r.check === 'llm.completion')
                    .map((r) => r.status),
            ).toEqual(['ok', 'unknown']);
            expect(results.some((r) => r.status === 'fail')).toBe(false);
        });

        it('LLM: an org the budget cannot cover is "?", the probed one keeps its result', async () => {
            let clock = 0;
            const deps = llmDeps();
            deps.complete.mockImplementation(async () => {
                clock += 68_000; // one slow provider eats the budget
            });
            const byok = {
                version: 2,
                credentials: [
                    { id: 'c1', provider: 'google_gemini', apiKey: 'x' },
                ],
                models: [
                    { id: 'm1', credentialId: 'c1', model: 'gemini-2.5-flash' },
                ],
                routing: { defaultModelId: 'm1' },
            };
            deps.getBYOKConfig.mockResolvedValue(byok as any);
            const teams = [
                team(),
                team({
                    organizationId: '33333333-3333-3333-3333-333333333333',
                    organizationName: 'beta',
                }),
            ];
            const results = await llmCheck({ ...deps, now: () => clock }).run(
                ctx({ teams }),
            );
            const lines = results.filter((r) => r.check === 'llm.completion');
            expect(lines.map((r) => r.status)).toEqual(['ok', 'unknown']);
            expect(lines[1].title).toContain('ran out of time');
            expect(deps.complete).toHaveBeenCalledTimes(1);
        });
    });

    describe('could not verify (?)', () => {
        it('names the part that could not be verified, and is not a failure', async () => {
            const results = await gitAccessCheck(
                healthyGit({ write: 'unknown' }),
            ).run(ctx());
            expect(problems(results)).toEqual([]);
            const line = results.find((r) => r.check === 'git.unverified');
            expect(line?.status).toBe('unknown');
            expect(line?.title).toContain('comment on pull requests in api');
        });
    });

    describe('degraded (!)', () => {
        it('sandbox turned off', async () => {
            const env = cleanEnv();
            env.SANDBOX_PROVIDER = 'null';
            const results = await configEnvCheck.run(ctx({ env }));
            expect(
                results.find((r) => r.check === 'sandbox.mode')?.status,
            ).toBe('warn');
            expectActionable(results);
        });

        it('E2B selected without a key (reviews get no sandbox)', async () => {
            const env = cleanEnv();
            env.SANDBOX_PROVIDER = 'e2b';
            delete env.API_E2B_KEY;
            const results = await configEnvCheck.run(ctx({ env }));
            expect(
                results.find((r) => r.check === 'sandbox.mode')?.status,
            ).toBe('warn');
            // no advisory claiming the local sandbox is used
            expect(
                results.find((r) => r.check === 'advisory.e2b'),
            ).toBeUndefined();
            expectActionable(results);
            const clone = jest.fn();
            expect(await sandboxCheck(clone).run(ctx({ env }))).toEqual([]);
            expect(clone).not.toHaveBeenCalled();
        });

        it('local sandbox cannot clone', async () => {
            const env = cleanEnv();
            delete env.API_E2B_KEY;
            const c = ctx({ env });
            const results = await sandboxCheck(async () => [
                {
                    team: c.teams[0],
                    repository: 'api',
                    error: 'fatal: Authentication failed',
                },
            ]).run(c);
            expect(statuses(results)).toEqual(['warn']);
            expect(results[0].scope).toBe('acme/core');
            expectActionable(results);
        });

        it('clones one repository per team: a token that cannot clone is named with its team', async () => {
            const env = cleanEnv();
            delete env.API_E2B_KEY;
            const mobile = team({ teamName: 'mobile', platform: 'GITLAB' });
            const c = ctx({ env, teams: [team(), mobile] });
            const results = await sandboxCheck(async () => [
                { team: c.teams[0], repository: 'api' },
                {
                    team: mobile,
                    repository: 'app',
                    error: 'remote: HTTP Basic: Access denied',
                },
            ]).run(c);
            expect(results.map((r) => [r.status, r.scope])).toEqual([
                ['warn', 'acme/mobile'],
                ['ok', undefined],
            ]);
            expect(results[0].fix).toContain('read_repository');
        });

        it('AST graph not ready', async () => {
            const c = ctx();
            const results = await astGraphCheck(async () => [
                { team: c.teams[0], repository: 'api', status: 'failed' },
            ]).run(c);
            expect(statuses(results)).toEqual(['warn']);
            expectActionable(results);
        });

        it('context window under 64K', async () => {
            const env = cleanEnv();
            env.API_LLM_PROVIDER_MODEL = 'gpt-3.5-turbo';
            const results = await llmCheck(llmDeps()).run(ctx({ env }));
            expect(
                results.find((r) => r.check === 'llm.context_window')?.status,
            ).toBe('warn');
            expectActionable(results);
        });

        it('a review model with an incomplete BYOK credential blocks every review', async () => {
            // permissionValidation.service.ts: outside a trial (self-hosted is
            // never one) the review is skipped, not run on the server model.
            const byok = {
                version: 2,
                credentials: [
                    { id: 'c-oa', provider: 'openai', apiKey: 'enc-oa' },
                    { id: 'c-an', provider: 'anthropic' },
                ],
                models: [
                    { id: 'm1', credentialId: 'c-an', model: 'claude-x' },
                    { id: 'm2', credentialId: 'c-oa', model: 'gpt-4o' },
                ],
                routing: { defaultModelId: 'm1' },
            };
            const deps = llmDeps({ byok });
            const results = await llmCheck(deps).run(ctx());
            expect(
                results.find((r) => r.check === 'llm.byok_credential'),
            ).toMatchObject({
                status: 'fail',
                title: 'The model chosen for reviews (claude-x) has an incomplete credential.',
            });
            expect(deps.complete).not.toHaveBeenCalled();
            expectActionable(results);
        });

        it('BYOK settings that route no model to reviews use the server model, on purpose', async () => {
            const byok = { credentials: [], models: [] };
            const results = await llmCheck(llmDeps({ byok })).run(ctx());
            expect(
                results.find((r) => r.check === 'llm.byok_fallback')?.status,
            ).toBe('info');
            expect(
                results.find((r) => r.check === 'llm.completion')?.status,
            ).toBe('ok');
        });

        describe('BYOK fallback and the other tasks a review routes', () => {
            const byok = (routing: any) => ({
                version: 2,
                credentials: [
                    { id: 'c-oa', provider: 'openai', apiKey: 'enc-oa' },
                ],
                models: [
                    { id: 'm-A', credentialId: 'c-oa', model: 'gpt-4o' },
                    { id: 'm-B', credentialId: 'c-oa', model: 'gpt-5-mini' },
                ],
                routing,
            });
            const failing = (model: string) => (deps: any) =>
                deps.complete.mockImplementation(async ({ slot }: any) => {
                    if (slot?.model === model) {
                        throw new Error(`${model}: insufficient_quota`);
                    }
                });

            it('a primary that fails while its fallback answers degrades, it does not fail', async () => {
                const deps = llmDeps({
                    byok: byok({
                        defaultModelId: 'm-A',
                        fallbackModelId: 'm-B',
                    }),
                });
                failing('gpt-4o')(deps);
                const results = await llmCheck(deps).run(ctx());
                const line = results.find((r) => r.check === 'llm.completion');

                expect(line).toMatchObject({
                    status: 'warn',
                    title: 'The review model (openai / gpt-4o) did not answer a test request; its fallback (openai / gpt-5-mini) did.',
                });
                expect(line?.fix).toContain('insufficient_quota');
                expectActionable(results);
            });

            it('primary and fallback both failing still fails', async () => {
                const deps = llmDeps({
                    byok: byok({
                        defaultModelId: 'm-A',
                        fallbackModelId: 'm-B',
                    }),
                    fail: new Error('invalid_api_key'),
                });
                const results = await llmCheck(deps).run(ctx());
                expect(
                    results.find((r) => r.check === 'llm.completion'),
                ).toMatchObject({
                    status: 'fail',
                    title: 'The review model (openai / gpt-4o) and its fallback (openai / gpt-5-mini) did not answer a test request.',
                });
            });

            it('a model routed to Kody Rules that fails degrades, naming what is lost', async () => {
                const deps = llmDeps({
                    byok: byok({
                        defaultModelId: 'm-A',
                        taskOverrides: { kodyRulesReview: 'm-B' },
                    }),
                });
                failing('gpt-5-mini')(deps);
                const results = await llmCheck(deps).run(ctx());

                expect(
                    results.find((r) => r.check === 'llm.completion')?.status,
                ).toBe('ok');
                expect(
                    results.find((r) => r.check === 'llm.task_model'),
                ).toMatchObject({
                    status: 'warn',
                    title: 'The model routed to Kody Rules checks (openai / gpt-5-mini) did not answer a test request.',
                    impact: 'Kody Rules are not checked on pull requests.',
                });
            });

            it('probes of different orgs run together, so one slow model never leaves another untested', async () => {
                // Each answer takes 12s. In sequence, the second org's probe
                // would start with 58s of the 70s budget left and never run.
                let clock = 0;
                const other = team({
                    organizationId: '66666666-6666-6666-6666-666666666666',
                    organizationName: 'beta',
                    teamId: '77777777-7777-7777-7777-777777777777',
                });
                const deps = {
                    ...llmDeps(),
                    now: () => clock,
                    getBYOKConfig: jest.fn(async (organizationId: string) =>
                        byok(
                            organizationId === team().organizationId
                                ? {
                                      defaultModelId: 'm-A',
                                      taskOverrides: { kodyRulesReview: 'm-B' },
                                  }
                                : { defaultModelId: 'm-B' },
                        ),
                    ),
                };
                deps.complete.mockImplementation(
                    () =>
                        new Promise<void>((resolve) =>
                            setImmediate(() => {
                                clock = Math.max(clock, 12_000);
                                resolve();
                            }),
                        ),
                );
                const results = await llmCheck(deps).run(
                    ctx({ teams: [team(), other] }),
                );

                expect(
                    results
                        .filter((r) => r.check === 'llm.completion')
                        .map((r) => r.status),
                ).toEqual(['ok', 'ok']);
                expect(results.filter((r) => r.status === 'unknown')).toEqual(
                    [],
                );
            });

            it('a primary that failed too late to test its fallback is unverified, not failed', async () => {
                let clock = 0;
                const deps = {
                    ...llmDeps({
                        byok: byok({
                            defaultModelId: 'm-A',
                            fallbackModelId: 'm-B',
                        }),
                    }),
                    now: () => clock,
                };
                deps.complete.mockImplementation(async () => {
                    clock = 60_000; // the primary timed out
                    throw new Error('timeout');
                });
                const results = await llmCheck(deps).run(ctx());
                expect(
                    results.find((r) => r.check === 'llm.completion'),
                ).toMatchObject({ status: 'unknown', blocking: true });
                expect(deps.complete).toHaveBeenCalledTimes(1);
            });

            it('a task routed to the review model itself is not probed twice', async () => {
                const deps = llmDeps({ byok: byok({ defaultModelId: 'm-A' }) });
                await llmCheck(deps).run(ctx());
                expect(deps.complete).toHaveBeenCalledTimes(1);
            });
        });

        it('WEB_NODE_ENV not self-hosted is advisory: reviews are not affected', async () => {
            const env = cleanEnv();
            env.WEB_NODE_ENV = 'production';
            const results = await configEnvCheck.run(ctx({ env }));
            expect(
                results.find((r) => r.check === 'env.web_node_env')?.status,
            ).toBe('info');
        });

        it('version behind latest release is advisory: the reviews that run are not degraded', async () => {
            const results = await versionCheck(async () => ({
                current: '2.1.0',
                latest: '2.3.0',
                updateAvailable: true,
            })).run(ctx());
            expect(statuses(results)).toEqual(['info']);
        });
    });

    describe('advisory (i)', () => {
        it.each([
            ['advisory.e2b', 'API_E2B_KEY'],
            ['advisory.exa', 'API_EXA_KEY'],
            ['advisory.mcp', 'API_MCP_SERVER_ENABLED'],
            ['advisory.dedup', 'API_OPEN_AI_API_KEY'],
            ['advisory.email', 'RESEND_API_KEY'],
        ])('%s when %s is unset', async (check, key) => {
            const env = cleanEnv();
            delete env[key];
            const results = await configEnvCheck.run(ctx({ env }));
            expect(results.find((r) => r.check === check)?.status).toBe('info');
        });

        it('API_LOG_LEVEL=error (the installer default) is advisory, not degraded', async () => {
            const env = cleanEnv();
            env.API_LOG_LEVEL = 'error';
            const results = await configEnvCheck.run(ctx({ env }));
            expect(
                results.find((r) => r.check === 'env.log_level')?.status,
            ).toBe('info');
        });

        it('Community Edition', async () => {
            const results = await editionCheck.run(ctx({ licensed: false }));
            expect(statuses(results)).toEqual(['info']);
            expect(results[0].impact).toContain('first 10 Kody Rules');
        });

        it.each([
            ['expired', { status: 'expired' }],
            ['invalid', { status: 'invalid' }],
        ])(
            'a %s license key degrades: the admin believes the install is licensed',
            async (_n, license) => {
                const results = await editionCheck.run(
                    ctx({ licensed: false, license: license as any }),
                );
                expect(statuses(results)).toEqual(['warn']);
                expectActionable(results);
            },
        );

        it('a license set under API_KODUS_LICENSE_KEY names the variable Kodus reads', async () => {
            const env = cleanEnv();
            env.API_KODUS_LICENSE_KEY = 'eyJhbGciOiJFZERTQSJ9.e30.sig';
            const results = await editionCheck.run(
                ctx({ licensed: false, license: { status: 'none' }, env }),
            );
            expect(statuses(results)).toEqual(['warn']);
            expect(results[0].fix).toContain('KODUS_LICENSE_KEY');
        });

        it('a license about to expire says when', async () => {
            const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
            const later = new Date(Date.now() + 90 * 86_400_000).toISOString();
            const expiring = await editionCheck.run(
                ctx({ license: { status: 'valid', expiresAt: soon } }),
            );
            const fine = await editionCheck.run(
                ctx({ license: { status: 'valid', expiresAt: later } }),
            );
            expect(statuses(expiring)).toEqual(['info']);
            expect(expiring[0].title).toContain(soon.slice(0, 10));
            expect(statuses(fine)).toEqual(['ok']);
        });

        it('email over SMTP is read from the API_SMTP_* variables the app uses', async () => {
            const env = cleanEnv();
            delete env.RESEND_API_KEY;
            env.API_NOTIFICATION_EMAIL_PROVIDER = 'smtp';
            env.API_SMTP_HOST = 'smtp.acme.dev';
            const results = await configEnvCheck.run(ctx({ env }));
            expect(
                results.find((r) => r.check === 'advisory.email')?.status,
            ).toBe('ok');
        });

        it('the edition is read from the organization that reviews, not the first by name', () => {
            const reviewing = team({ organizationName: 'licensed-org' });
            expect(
                licenseCandidates([emptyOrganizationTeam(), reviewing]),
            ).toEqual([reviewing]);
        });

        it('with nothing to review yet, every organization is a license candidate', () => {
            const other = emptyOrganizationTeam();
            const first = team({ repositories: [] });
            expect(
                licenseCandidates([first, team({ repositories: [] }), other]),
            ).toEqual([first, other]);
        });

        it('showStatusFeedback=false', async () => {
            const c = ctx();
            const results = await skipSettingsCheck(async () => [
                {
                    team: c.teams[0],
                    repository: null,
                    config: { showStatusFeedback: false },
                },
            ]).run(c);
            expect(statuses(results)).toEqual(['info']);
        });
    });

    describe('enterprise only', () => {
        it('analytics ingestion stale', async () => {
            const results = await analyticsCheck(async () => ({
                status: 'failed',
                finishedAt: null,
                lagHours: 72,
            })).run(ctx());
            expect(statuses(results)).toEqual(['info']);
        });

        it('not reported on Community Edition', async () => {
            const lastRun = jest.fn();
            expect(
                await analyticsCheck(lastRun).run(ctx({ licensed: false })),
            ).toEqual([]);
            expect(lastRun).not.toHaveBeenCalled();
        });
    });

    describe('configured to skip, not broken', () => {
        it.each([
            ['drafts', { runOnDraft: false }],
            ['base branches', { baseBranches: ['main'] }],
            ['ignore paths', { ignorePaths: ['docs/**'] }],
            ['manual cadence', { reviewCadence: { type: 'manual' } }],
            ['automatic reviews off', { automatedReviewActive: false }],
        ])('%s', async (_name, config) => {
            const c = ctx();
            const results = await skipSettingsCheck(async () => [
                { team: c.teams[0], repository: 'api', config },
            ]).run(c);
            expect(statuses(results)).toEqual(['skip']);
            expect(results[0].scope).toBe('acme/core/api');
        });

        it("the default ignore list is not counted as the team's choice", async () => {
            const c = ctx();
            const results = await skipSettingsCheck(
                async () => [
                    {
                        team: c.teams[0],
                        repository: 'api',
                        config: {
                            ignorePaths: ['yarn.lock', 'dist/**', 'docs/**'],
                        },
                    },
                ],
                () => ['yarn.lock', 'dist/**'],
            ).run(c);

            expect(statuses(results)).toEqual(['skip']);
            expect(results[0].title).toBe(
                '1 path pattern(s) beyond the default list are ignored (docs/**).',
            );
        });

        it('a config that carries only the default ignore list skips nothing', async () => {
            const c = ctx();
            const results = await skipSettingsCheck(
                async () => [
                    {
                        team: c.teams[0],
                        repository: 'api',
                        config: { ignorePaths: ['yarn.lock', 'dist/**'] },
                    },
                ],
                () => ['yarn.lock', 'dist/**'],
            ).run(c);

            expect(results).toEqual([]);
        });
    });
});
