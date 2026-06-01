import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import onboardingWebhookRegistration from '../../scenarios/onboarding-webhook-registration.js';
import type {
    Provider,
    RunContext,
    TargetContext,
    WebhookInfo,
} from '../types.js';

// Hand-rolled fake provider + kodus client so we can drive the scenario
// directly without spinning up the full mock HTTP server. The scenario's
// only external touchpoints are `ctx.provider.listWebhooks/deleteWebhook`
// and the onboarding helpers — both trivial to fake.

interface FakeProviderOpts {
    listWebhooksImpl: () => Promise<WebhookInfo[]>;
}

function makeFakeProvider(opts: FakeProviderOpts): Provider {
    const deleted: string[] = [];
    const fake: Partial<Provider> & {
        deletedIds: string[];
    } = {
        name: 'github',
        integrationType: 'GITHUB',
        webhookPath: '/github/webhook',
        deletedIds: deleted,
        listWebhooks: opts.listWebhooksImpl,
        deleteWebhook: async (id: string) => {
            deleted.push(id);
        },
        repoRef: async () => ({ full_name: 'org/repo', id: 1 }),
        createWebhook: async () => ({ id: '1' }),
        openPR: async () => ({
            number: 1,
            url: 'x',
            branch: 'b',
            baseBranch: 'main',
        }),
        closePR: async () => {},
        triggerReviewOnExistingPR: async () => ({
            triggerId: '1',
            sinceIso: new Date().toISOString(),
        }),
        pollForReview: async () => ({
            reviewComments: 0,
            issueComments: 0,
            reviews: 0,
        }),
        postComment: async () => ({ id: '1' }),
        authMode: () => 'token',
        authToken: () => 'fake-token',
    };
    return fake as Provider;
}

function makeRunContext(provider: Provider): {
    ctx: RunContext;
    cleanup: () => void;
} {
    const artifactDir = mkdtempSync(join(tmpdir(), 'webhook-test-'));
    const target: TargetContext = {
        target: 'self-hosted',
        apiBaseUrl: 'http://localhost:1',
        webBaseUrl: 'http://localhost:1',
        tunnelUrl: 'https://abc.trycloudflare.com',
    };
    const ctx: RunContext = {
        target,
        provider,
        license: 'license-paid',
        tenant: { email: 'x@y', password: 'p' },
        kodus: {
            login: async () => ({
                accessToken: 't',
                organizationId: 'o',
                teamId: 'team',
            }),
            registerIntegration: async () => {},
            registerRepo: async () => ({ full_name: 'org/repo', id: 1 }),
            finishOnboarding: async () => {},
        },
        assert: ((cond: unknown, msg: string) => {
            if (!cond) throw new Error(`Assertion failed: ${msg}`);
        }) as RunContext['assert'],
        skip: ((reason: string): never => {
            throw new Error(`ctx.skip called in unit test: ${reason}`);
        }) as RunContext['skip'],
        artifactDir,
        runId: 'test-run',
    };
    return { ctx, cleanup: () => rmSync(artifactDir, { recursive: true }) };
}

test('onboarding-webhook-registration: passes when a matching active hook exists after onboarding', async () => {
    let calls = 0;
    const provider = makeFakeProvider({
        listWebhooksImpl: async () => {
            calls += 1;
            // Pre-clean call: no stale hooks. Post-onboarding call: one
            // fresh hook from Kodus pointing at the tunnel.
            if (calls === 1) return [];
            return [
                {
                    id: 'h1',
                    url: 'https://abc.trycloudflare.com/github/webhook',
                    active: true,
                    events: ['pull_request', 'issue_comment'],
                },
            ];
        },
    });
    const { ctx, cleanup } = makeRunContext(provider);
    try {
        const result = (await onboardingWebhookRegistration.run(ctx)) as {
            registered: Array<{ url: string }>;
            staleRemoved: number;
        };
        assert.equal(result.staleRemoved, 0);
        assert.equal(result.registered.length, 1);
        assert.equal(
            result.registered[0].url,
            'https://abc.trycloudflare.com/github/webhook',
        );
    } finally {
        cleanup();
    }
});

test('onboarding-webhook-registration: removes stale hooks before re-running onboarding', async () => {
    let calls = 0;
    const provider = makeFakeProvider({
        listWebhooksImpl: async () => {
            calls += 1;
            if (calls === 1) {
                return [
                    {
                        id: 'stale-1',
                        url: 'https://old-tunnel.trycloudflare.com/github/webhook',
                        active: true,
                        events: ['pull_request'],
                    },
                    {
                        id: 'unrelated',
                        url: 'https://other-service.com/api/listener',
                        active: true,
                        events: ['push'],
                    },
                ];
            }
            return [
                {
                    id: 'fresh',
                    url: 'https://abc.trycloudflare.com/github/webhook',
                    active: true,
                    events: ['pull_request'],
                },
            ];
        },
    });
    const { ctx, cleanup } = makeRunContext(provider);
    try {
        const result = (await onboardingWebhookRegistration.run(ctx)) as {
            staleRemoved: number;
        };
        assert.equal(
            result.staleRemoved,
            1,
            'only the kodus-shaped stale hook should be removed (not the unrelated one)',
        );
        // Cast back to access the test-only field we attached.
        const fake = provider as unknown as { deletedIds: string[] };
        assert.deepEqual(fake.deletedIds, ['stale-1']);
    } finally {
        cleanup();
    }
});

test('onboarding-webhook-registration: FAILS when no kodus hook is registered after onboarding (the GitLab bug shape)', async () => {
    const provider = makeFakeProvider({
        listWebhooksImpl: async () => [],
    });
    const { ctx, cleanup } = makeRunContext(provider);
    try {
        await assert.rejects(
            () => onboardingWebhookRegistration.run(ctx),
            /Kodus did not register a webhook/,
        );
    } finally {
        cleanup();
    }
});

test('onboarding-webhook-registration: FAILS when matching hook exists but is inactive', async () => {
    let calls = 0;
    const provider = makeFakeProvider({
        listWebhooksImpl: async () => {
            calls += 1;
            if (calls === 1) return [];
            return [
                {
                    id: 'disabled',
                    url: 'https://abc.trycloudflare.com/github/webhook',
                    active: false,
                    events: ['pull_request'],
                },
            ];
        },
    });
    const { ctx, cleanup } = makeRunContext(provider);
    try {
        await assert.rejects(
            () => onboardingWebhookRegistration.run(ctx),
            /registered but none are active/,
        );
    } finally {
        cleanup();
    }
});
