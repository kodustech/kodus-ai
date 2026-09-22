jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));

import {
    BrokerProbe,
    brokerCheck,
    staleJobsCheck,
} from '../checks/broker.checks';
import { bootEnvCheck, configEnvCheck } from '../checks/env.checks';
import { gitAccessCheck, webhookUrlCheck } from '../checks/git.checks';
import { llmCheck } from '../checks/llm.checks';
import {
    analyticsCheck,
    astGraphCheck,
    editionCheck,
    sandboxCheck,
    seatsCheck,
    setupCheck,
    skipSettingsCheck,
    versionCheck,
} from '../checks/setup.checks';
import { DoctorContext, DoctorResult, DoctorTeam } from '../doctor.types';

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
            close: async () => undefined,
        };
    }),
});

const dataSource = (rows: { pending?: any; unsent?: any } = {}) =>
    ({
        query: jest.fn(async (sql: string) =>
            sql.includes('workflow_jobs')
                ? [rows.pending ?? { count: 0, oldest: null }]
                : [rows.unsent ?? { count: 0 }],
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
    reach: jest.fn(async () => 404),
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
                ...(await sandboxCheck(async () => ({ repository: 'api' })).run(
                    c,
                )),
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

        it('LLM completion fails (env model)', async () => {
            const results = await llmCheck(
                llmDeps({ fail: new Error('401 invalid key') }),
            ).run(ctx());
            const line = results.find((r) => r.check === 'llm.completion');
            expect(line?.status).toBe('fail');
            expect(line?.fix).toContain('401 invalid key');
            expectActionable(results);
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

        it('GitHub App installs use the app-level hook (not a failure)', async () => {
            const results = await gitAccessCheck(
                healthyGit({ hook: 'app-level' }),
            ).run(ctx());
            expect(problems(results)).toEqual([]);
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

        it('webhook URL does not resolve', async () => {
            const git = healthyGit();
            git.reach.mockRejectedValue(
                Object.assign(new Error('fetch failed'), {
                    cause: { code: 'ENOTFOUND' },
                }),
            );
            const results = await webhookUrlCheck(git).run(ctx());
            expect(statuses(results)).toEqual(['fail']);
        });

        it('webhook URL times out from inside (NAT) is unverified, not failed', async () => {
            const git = healthyGit();
            git.reach.mockRejectedValue(
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
            ['organization disabled', { organizationActive: false }],
            ['team not active', { teamStatus: 'pending' }],
            ['git connection disabled', { integrationActive: false }],
        ])('%s', async (_name, over) => {
            const results = await setupCheck.run(
                ctx({ teams: [team(over as any)] }),
            );
            expect(statuses(results)).toEqual(['fail']);
            expectActionable(results);
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

        it('local sandbox cannot clone', async () => {
            const env = cleanEnv();
            delete env.API_E2B_KEY;
            const results = await sandboxCheck(async () => ({
                repository: 'api',
                error: 'fatal: Authentication failed',
            })).run(ctx({ env }));
            expect(statuses(results)).toEqual(['warn']);
            expectActionable(results);
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

        it('BYOK routing falls back to the env model', async () => {
            const byok = {
                version: 2,
                credentials: [],
                models: [
                    { id: 'm1', credentialId: 'missing', model: 'claude-x' },
                ],
                routing: { defaultModelId: 'm1' },
            };
            const results = await llmCheck(llmDeps({ byok })).run(ctx());
            expect(
                results.find((r) => r.check === 'llm.byok_fallback')?.status,
            ).toBe('warn');
            expectActionable(results);
        });

        it('WEB_NODE_ENV not self-hosted', async () => {
            const env = cleanEnv();
            env.WEB_NODE_ENV = 'production';
            const results = await configEnvCheck.run(ctx({ env }));
            expect(
                results.find((r) => r.check === 'env.web_node_env')?.status,
            ).toBe('warn');
        });

        it('version behind latest release', async () => {
            const results = await versionCheck(async () => ({
                current: '2.1.0',
                latest: '2.3.0',
                updateAvailable: true,
            })).run();
            expect(statuses(results)).toEqual(['warn']);
            expectActionable(results);
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
    });
});
