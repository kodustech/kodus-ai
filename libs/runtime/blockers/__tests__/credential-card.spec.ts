import type { FailureBundle } from '@libs/runtime/protocol';

import { classifyBlocker } from '../catalog';

// S-58 Needs a credential (docs/runtime/egress-allowlist.md §9): a private registry answers 401, or the .npmrc reads a
// variable no secret sets. The card names the variable and the host, offers to create the secret, and no "allow".

const bundle = (logTail: string[], over: Partial<FailureBundle> = {}): FailureBundle => ({
    services: [{ name: 'kodus-boot', state: 'exited', logTail }],
    ports: [],
    disk: [],
    deniedEgress: [],
    redactions: 0,
    truncated: false,
    collectedAt: '2026-11-13T12:00:00.000Z',
    ...over,
});
const failed = (logTail: string[], over: Partial<FailureBundle> = {}) =>
    classifyBlocker({ kind: 'toolchain', signature: 'compose_up', message: 'compose up: exit 1', bundle: bundle(logTail, over) });

describe('needs a credential (S-58)', () => {
    it('names the variable the .npmrc reads and the host, and offers the secret, never an approval', () => {
        const c = failed([
            '#9 [api 4/8] RUN pnpm install --frozen-lockfile',
            ' WARN  Failed to replace env in config: ${NPM_TASKFORCESH_TOKEN}',
            ' ERR_PNPM_FETCH_401  GET https://npm.taskforce.sh/@taskforcesh%2Fbullmq-pro: Unauthorized - 401',
        ]);
        expect(c).toMatchObject({
            kind: 'external_service',
            signature: 'external_service:credential:npm.taskforce.sh',
            title: 'npm.taskforce.sh needs a credential. Your .npmrc reads it from NPM_TASKFORCESH_TOKEN',
            fixes: [{ action: 'add_secret', who: 'settings', host: 'npm.taskforce.sh', secretName: 'NPM_TASKFORCESH_TOKEN' }],
        });
        expect(c.fixes.some((f) => f.action === 'approve_host')).toBe(false);
    });

    it("reads npm's E401 with the registry URL", () => {
        const c = failed(['npm error code E401', 'npm error 401 Unauthorized - GET https://registry.corp.example/@corp%2fui - authentication token not provided']);
        expect(c).toMatchObject({ signature: 'external_service:credential:registry.corp.example', fixes: [{ action: 'add_secret', host: 'registry.corp.example' }] });
    });

    it('reads the host and the variable of an .npmrc auth line the log prints', () => {
        const c = failed(['npm ERR! //npm.corp.example/:_authToken=${CORP_NPM_TOKEN}', 'npm ERR! code E401']);
        expect(c).toMatchObject({ signature: 'external_service:credential:npm.corp.example', fixes: [{ host: 'npm.corp.example', secretName: 'CORP_NPM_TOKEN' }] });
    });

    it("reads pip's HTTP error 401", () => {
        const c = failed(['ERROR: HTTP error 401 while getting https://pypi.corp.example/simple/internal-lib/']);
        expect(c).toMatchObject({ signature: 'external_service:credential:pypi.corp.example' });
    });

    it('is not an app request log that shows a 401', () => {
        const c = failed(['GET https://api.stripe.com/v1/charges 401 Unauthorized', 'Error: STRIPE_SECRET_KEY is not set']);
        expect(c.signature).not.toMatch(/credential/);
    });

    it('a host that is also blocked asks to allow it first', () => {
        const c = failed(['npm error 401 Unauthorized - GET https://npm.vendor.example/pkg'], { deniedEgress: [{ host: 'npm.vendor.example', port: 443, at: '2026-11-13T12:00:00.000Z' }] });
        expect(c.signature).toBe('external_service:egress:npm.vendor.example');
    });
});

// The card loop (docs/runtime/egress-allowlist.md §16): a host the build was refused gets the build card, which never
// offers the reads-only allow (it would leave the same blocker), only the mirror and full access for the build.
describe('a host the image build was refused', () => {
    const buildLog = (host: string) => [
        '#9 [api 4/8] RUN npm ci',
        `#9 3.1 npm error request to https://${host}/left-pad failed, reason: socket hang up`,
        '#9 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1',
    ];
    const denied = (host: string) => ({ deniedEgress: [{ host, port: 443, at: '2026-11-13T12:00:00.000Z' }] });

    it.each(['github.com', 'registry.yarnpkg.com'])('%s: the build card with the mirror or full access, never the reads-only allow', (host) => {
        const c = failed(buildLog(host), denied(host));
        expect(c.signature).toBe(`external_service:build_egress:${host}`);
        expect(c.fixes.map((f) => f.id)).toEqual(expect.arrayContaining([`approve_full:${host}`]));
        expect(c.fixes.some((f) => f.id === `approve_host:${host}`)).toBe(false);
        expect(c.fixes.find((f) => f.id === `approve_full:${host}`)?.detail).toContain('Kodus cannot see what it sends');
    });

    it('a registry: install through the mirror, with the ARGs the cell passes', () => {
        const c = failed(buildLog('registry.npmjs.org'), denied('registry.npmjs.org'));
        expect(c.fixes[0]).toMatchObject({ id: 'use_mirror:registry.npmjs.org', action: 'fix_recipe' });
        expect(c.fixes[0].detail).toContain('ARG npm_config_registry');
    });

    it("a machine's denial outside a build keeps the one-click reads-only allow", () => {
        const c = failed(['Error: connect ECONNREFUSED api.vendor.example'], denied('api.vendor.example'));
        expect(c.signature).toBe('external_service:egress:api.vendor.example');
        expect(c.fixes[0].id).toBe('approve_host:api.vendor.example');
    });
});
