import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { registerIntegration } from '../onboarding.js';
import type { KodusSession, Provider, TargetContext } from '../types.js';

// A GitHub App installation can only be linked after GitHub's authorization
// of a user in a browser (GHSA-9r6j). On cloud the persistent tenant was
// linked once by hand, so a run must reuse that link and never re-POST
// auth-integration for it. A fake API records what the harness calls.

let server: Server;
let baseUrl = '';
let hasConnection = true;
const calls: string[] = [];

before(async () => {
    server = createServer((req, res) => {
        calls.push(`${req.method} ${req.url?.split('?')[0]}`);
        res.setHeader('content-type', 'application/json');
        if (req.url?.startsWith('/integration/connections')) {
            res.end(
                JSON.stringify({
                    data: [
                        {
                            platformName: 'github',
                            category: 'CODE_MANAGEMENT',
                            hasConnection,
                        },
                    ],
                }),
            );
            return;
        }
        if (req.url?.startsWith('/code-management/auth-integration')) {
            res.end(JSON.stringify({ data: { status: 'SUCCESS' } }));
            return;
        }
        res.statusCode = 404;
        res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
    server.close();
});

const githubApp = {
    name: 'github',
    integrationType: 'GITHUB',
    authMode: () => 'oauth',
    authToken: () => '4242',
} as unknown as Provider;

const target = (): TargetContext => ({
    target: 'cloud',
    apiBaseUrl: baseUrl,
    webBaseUrl: baseUrl,
});

test('reuses the GitHub App link the cloud tenant already has', async () => {
    calls.length = 0;
    hasConnection = true;
    const session: KodusSession = {
        accessToken: 't',
        organizationId: 'org-linked',
        teamId: 'team-1',
    };

    await registerIntegration(target(), githubApp, session);

    assert.ok(calls.includes('GET /integration/connections'));
    assert.ok(!calls.includes('POST /code-management/auth-integration'));
});

test('still registers when the tenant has no working GitHub connection', async () => {
    calls.length = 0;
    hasConnection = false;
    const session: KodusSession = {
        accessToken: 't',
        organizationId: 'org-unlinked',
        teamId: 'team-1',
    };

    await registerIntegration(target(), githubApp, session);

    assert.ok(calls.includes('POST /code-management/auth-integration'));
});
