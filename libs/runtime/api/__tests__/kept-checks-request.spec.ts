import { RuntimeRunRequestedSchema } from '@libs/runtime/run/run-messages';

import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import type { PullRequestHead } from '../domain/ports';
import { BASE_SHA, InMemoryKeptChecks, ORG, REPO, SHA, TEAM, clock, config } from './fixtures';

// A Run carries its repository's active kept checks, as they are when it is
// asked (docs/runtime/kept-checks.md §5); an external finding's closed plan
// carries none.

describe('the Run request carries the kept checks of its repository', () => {
    const env = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop' };
    const head: PullRequestHead = { headSha: SHA, baseSha: BASE_SHA, fork: false };
    const spec = { kind: 'http' as const, target: { service: 'web', port: 3000 }, method: 'GET' as const, path: '/orders/1', timeoutMs: 5_000 };
    const keep = (store: InMemoryKeptChecks, over: { organizationId?: string; environmentId?: string; repositoryId?: string; path?: string } = {}) =>
        store.keep(
            {
                organizationId: over.organizationId ?? ORG,
                environmentId: over.environmentId ?? 'env-1',
                repositoryId: over.repositoryId ?? REPO,
                probeKey: `http GET ${over.path ?? '/orders/1'}`,
                entryPoint: 'GET /orders/:id',
                probe: { spec: { ...spec, path: over.path ?? '/orders/1' }, purpose: 'order 1 totals 3', expected: '200', compare: ['status', 'json'] },
                assertions: { kind: 'http', status: 200 },
                differingFields: ['json.total'],
                sourceRunId: 'run-1',
                sourceProbeId: 'p',
                sourcePrNumber: 3,
                keptBy: 'u',
            },
            10,
        );
    const builder = (store: InMemoryKeptChecks) =>
        new RuntimeRunRequestBuilder(
            { getPullRequestDiff: async () => ({ files: [], truncated: false }) } as any,
            { issue: async () => 'fixture-token' },
            { get: async () => ({ ...env, imageId: 'image-1', expose: [] }) },
            config(),
            clock,
            undefined,
            undefined,
            store,
        );

    it('puts the active checks of this environment and repository in the request, and nothing of another scope', async () => {
        const store = new InMemoryKeptChecks();
        const kept = await keep(store);
        await keep(store, { repositoryId: 'repo-2', path: '/a' });
        await keep(store, { environmentId: 'env-2', path: '/b' });
        await keep(store, { organizationId: 'org-b', path: '/c' });
        const removed = await keep(store, { path: '/d' });
        await store.remove(ORG, 'record' in removed ? removed.record.keptCheckId : '', 'u');
        const requested = await builder(store).build({ env, prNumber: 7, head, trigger: 'pull_request' });
        expect(requested.keptChecks).toEqual([
            {
                keptCheckId: 'record' in kept ? kept.record.keptCheckId : '',
                entryPoint: 'GET /orders/:id',
                probe: { spec, purpose: 'order 1 totals 3', expected: '200', compare: ['status', 'json'] },
                assertions: { kind: 'http', status: 200 },
                differingFields: ['json.total'],
                sourcePrNumber: 3,
            },
        ]);
        expect(RuntimeRunRequestedSchema.safeParse(requested).success).toBe(true);
    });

    it('sends no field when the repository keeps no check', async () => {
        const requested = await builder(new InMemoryKeptChecks()).build({ env, prNumber: 7, head, trigger: 'pull_request' });
        expect(requested).not.toHaveProperty('keptChecks');
    });

    it("never puts kept checks in an external finding's Run", async () => {
        const store = new InMemoryKeptChecks();
        await keep(store);
        const asked = jest.spyOn(store, 'listActive');
        const externalVerification = {
            findings: [{ findingId: 'f1', probe: { id: 'x', spec, origin: 'external' as const, purpose: 'p', expected: '200', compare: ['status' as const] } }],
        };
        const requested = await builder(store).build({ env, prNumber: 7, head, trigger: 'external_finding', externalVerification } as any).catch((e) => e);
        expect(asked).not.toHaveBeenCalled();
        expect((requested as any)?.keptChecks).toBeUndefined();
    });
});
