import type { ProductEnvironment, RuntimeGitPort } from '../domain/ports';
import { RuntimeSetupRequester } from '../application/runtime-setup-requester.service';
import { RuntimeTemplateSetupRequests } from '../application/template-setup-requests.service';
import { FakeOutbox, NOW, ORG, REPO, SHA, TEAM, clock, config, openSealed, runtimeReleaseGate } from './fixtures';

jest.mock('@libs/core/log/logger', () => ({ createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));

const env = (patch: Partial<ProductEnvironment> = {}): ProductEnvironment => ({
    environmentId: 'env-1',
    organizationId: ORG,
    teamId: TEAM,
    repositoryId: REPO,
    repositoryName: 'acme/shop',
    state: 'active',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...patch,
});

const RECIPE = 'version: 1\nservices: {compose: {public: app}}\n';
const git = {
    getDefaultBranchHead: async () => ({ status: 'ok', sha: SHA, branch: 'main' }),
    readFileAtCommit: async () => RECIPE,
};
const tokens = { issue: async () => 'ghs_download_1' };

function world(opts: { envs?: ProductEnvironment[]; pending?: Array<{ organizationId: string; environmentId: string; key: string }>; released?: boolean } = {}) {
    const envs = opts.envs ?? [env()];
    const marked: string[] = [];
    const store = {
        get: async (o: string, e: string) => envs.find((x) => x.organizationId === o && x.environmentId === e) ?? null,
        markSetupRequested: async (_o: string, e: string) => void marked.push(e),
    };
    const outbox = new FakeOutbox();
    const requester = new RuntimeSetupRequester(store as any, git as unknown as RuntimeGitPort, tokens, outbox as any, clock, config());
    const pending = opts.pending ?? [{ organizationId: ORG, environmentId: 'env-1', key: 'template:org-a/env-1:tpl-x' }];
    const reader = { pending: jest.fn(async () => pending) };
    const step = new RuntimeTemplateSetupRequests(reader, store as any, requester, opts.released === undefined ? undefined : runtimeReleaseGate(opts.released));
    return { step, outbox, marked, reader };
}
const setups = (o: FakeOutbox) => o.rows.filter((r) => r.payload.event_name === 'runtime.environment.setup_requested').map((r) => r.payload.payload);

describe('when the fleet is waiting for the setup of an environment template', () => {
    it('issues one setup_requested with the template key and bound key for a pending build', async () => {
        const w = world();
        expect(await w.step.run()).toEqual({ pending: 1, requested: 1, skipped: 0, failed: 0 });
        const cmds = setups(w.outbox);
        expect(cmds).toHaveLength(1);
        expect(cmds[0]).toMatchObject({ environmentId: 'env-1', organizationId: ORG, key: 'template:org-a/env-1:tpl-x', boundKey: 'template:org-a/env-1' });
        // A template build is not the environment's own setup: the product state stays.
        expect(w.marked).toEqual([]);
    });

    it('issues nothing when the reader finds no pending build (the environment record already holds the key)', async () => {
        const w = world({ pending: [] });
        expect(await w.step.run()).toEqual({ pending: 0, requested: 0, skipped: 0, failed: 0 });
        expect(setups(w.outbox)).toEqual([]);
    });

    it('issues nothing for an environment the product does not know, or an org the Runtime is not released to', async () => {
        const unknown = world({ pending: [{ organizationId: ORG, environmentId: 'env-gone', key: 'template:org-a/env-gone:tpl-x' }] });
        expect(await unknown.step.run()).toMatchObject({ requested: 0, skipped: 1, failed: 0 });
        const off = world({ released: false });
        expect(await off.step.run()).toMatchObject({ requested: 0, skipped: 1 });
        expect([...setups(unknown.outbox), ...setups(off.outbox)]).toEqual([]);
    });

    it('asks for the same key once in this process, and never throws when the request fails or the read does', async () => {
        const w = world();
        await w.step.run();
        expect(await w.step.run()).toMatchObject({ requested: 0, skipped: 1 });
        expect(setups(w.outbox)).toHaveLength(1);

        const broken = world();
        broken.outbox.create = async () => Promise.reject(new Error('db down'));
        expect(await broken.step.run()).toMatchObject({ requested: 0, failed: 1 });
        broken.reader.pending.mockRejectedValueOnce(new Error('read down'));
        expect(await broken.step.run()).toMatchObject({ failed: 1 });
    });
});

describe('RuntimeSetupRequester.request with a key and a bound key', () => {
    it('puts both in the command and seals the tokens to that key', async () => {
        const w = world();
        const requester = new RuntimeSetupRequester({ markSetupRequested: async () => undefined } as any, git as unknown as RuntimeGitPort, tokens, w.outbox as any, clock, config());
        await requester.request(env(), { uuid: 'kodus-template-builder' }, { key: 'template:org-a/env-1:tpl-y', boundKey: 'template:org-a/env-1' });
        const cmd = setups(w.outbox)[0];
        expect(cmd).toMatchObject({ key: 'template:org-a/env-1:tpl-y', boundKey: 'template:org-a/env-1', requestedBy: { userId: 'kodus-template-builder' } });
        expect(openSealed(cmd.repoToken, 'template:org-a/env-1:tpl-y')).toBe('ghs_download_1');
        expect(w.outbox.rows[0].payload.event_name).toBe('runtime.environment.setup_requested');
    });

    it('keeps the default key and marks the environment when no key is given', async () => {
        const w = world();
        const marked: string[] = [];
        const requester = new RuntimeSetupRequester({ markSetupRequested: async (_o: string, e: string) => void marked.push(e) } as any, git as unknown as RuntimeGitPort, tokens, w.outbox as any, clock, config());
        await requester.request(env(), { uuid: 'u' });
        expect(setups(w.outbox)[0].key).toBe(`env-1:${NOW.toISOString()}`);
        expect(setups(w.outbox)[0]).not.toHaveProperty('boundKey');
        expect(marked).toEqual(['env-1']);
    });
});
