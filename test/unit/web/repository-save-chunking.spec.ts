/**
 * The repository selection is posted in chunks of 50 from one modal shared by
 * every git provider. Each chunk persists what it carries, and every provider
 * adapter reconciles webhooks against the persisted selection — so an
 * intermediate chunk shows them a partial one. For a 200-repository save, the
 * first chunk persists 50 and the adapters that remove webhooks outside the
 * selection delete the other 150, which the later chunks then recreate: those
 * repositories deliver no PR events in between, and never recover if the
 * process dies mid-save.
 *
 * `deferWebhooks` is the client half of the contract that prevents it. What
 * matters here is the boundary: every chunk but the last carries it, the last
 * one does not, and a single-request save (the per-row remove, the onboarding
 * save, the per-provider modals) never carries it at all.
 */

const post = jest.fn().mockResolvedValue({ data: {} });

jest.mock('src/core/utils/axios', () => ({
    axiosAuthorized: {
        post: (...args: unknown[]) => post(...args),
        fetcher: jest.fn(),
    },
}));

import {
    createOrUpdateRepositories,
    createOrUpdateRepositoriesInChunks,
} from '../../../apps/web/src/lib/services/codeManagement/fetch';

function repos(count: number) {
    return Array.from({ length: count }, (_, i) => ({
        id: `repo-${i}`,
        name: `repo-${i}`,
    })) as any;
}

function bodies() {
    return post.mock.calls.map((call) => call[1]);
}

describe('chunked repository save — deferring webhook setup', () => {
    beforeEach(() => post.mockClear());

    it('defers on every chunk except the last', async () => {
        await createOrUpdateRepositoriesInChunks(repos(200), 'team-1');

        const sent = bodies();
        expect(sent).toHaveLength(4);
        expect(sent.map((body) => body.deferWebhooks)).toEqual([
            true,
            true,
            true,
            undefined,
        ]);
    });

    it('keeps replace-then-append, so the selection is rebuilt and not doubled', async () => {
        await createOrUpdateRepositoriesInChunks(repos(200), 'team-1');

        expect(bodies().map((body) => body.type)).toEqual([
            'replace',
            'append',
            'append',
            'append',
        ]);
    });

    it('does not defer when the selection fits in a single chunk', async () => {
        await createOrUpdateRepositoriesInChunks(repos(10), 'team-1');

        const sent = bodies();
        expect(sent).toHaveLength(1);
        expect(sent[0].deferWebhooks).toBeUndefined();
    });

    it('defers on a chunk that follows a failed one, so a retry cannot strand webhooks', async () => {
        post.mockRejectedValueOnce(new Error('network')).mockResolvedValue({
            data: {},
        });

        const result = await createOrUpdateRepositoriesInChunks(
            repos(200),
            'team-1',
        );

        // Partial-failure tolerance is why the chunking exists: the other
        // chunks still land.
        expect(result.failed).toBe(50);
        expect(result.success).toBe(150);
        // And the last chunk is still the one that sets webhooks up.
        expect(bodies()[3].deferWebhooks).toBeUndefined();
    });

    it('never defers for a single-request save', async () => {
        await createOrUpdateRepositories(repos(3), 'team-1');

        expect(bodies()[0]).not.toHaveProperty('deferWebhooks');
    });

    it('omits the flag rather than sending false, so older backends are unaffected', async () => {
        await createOrUpdateRepositories(repos(3), 'team-1', 'replace', {
            deferWebhooks: false,
        });

        expect(bodies()[0]).not.toHaveProperty('deferWebhooks');
    });
});
