import { HubCellDataPurger, type HubClient } from './hub-environment-runtime';

// The worker's leg of the org purge: every hub replica that holds a connected cell answers how many of its cells have
// acknowledged; a replica that cannot be reached counts as a pending cell, so the rows that find the data stay.

const hubOf = (answers: Record<string, { pending: number; purged: number } | Error>) => {
    const posts: Array<{ url: string; path: string }> = [];
    const hub = {
        post: jest.fn(async (url: string, path: string) => {
            posts.push({ url, path });
            const a = answers[url];
            if (a instanceof Error) throw a;
            return a;
        }),
    } as unknown as HubClient;
    return { hub, posts };
};

describe('HubCellDataPurger', () => {
    it('asks each replica once, by organization, and adds up their answers', async () => {
        const { hub, posts } = hubOf({ 'http://r1': { pending: 1, purged: 2 }, 'http://r2': { pending: 0, purged: 1 } });
        const purger = new HubCellDataPurger(hub, async () => ['http://r1', 'http://r2', 'http://r1']);
        expect(await purger.purge('org-a')).toEqual({ cellsPending: 1, cellsPurged: 3 });
        expect(posts).toEqual([
            { url: 'http://r1', path: '/internal/organizations/org-a/cell-data-purge' },
            { url: 'http://r2', path: '/internal/organizations/org-a/cell-data-purge' },
        ]);
    });

    it('counts a replica it cannot reach as a pending cell, and still asks the others', async () => {
        const { hub } = hubOf({ 'http://r1': new Error('hub unreachable'), 'http://r2': { pending: 0, purged: 1 } });
        expect(await new HubCellDataPurger(hub, async () => ['http://r1', 'http://r2']).purge('org-a')).toEqual({ cellsPending: 1, cellsPurged: 1 });
    });

    it('has nothing to wait for when no cell is connected', async () => {
        const { hub } = hubOf({});
        expect(await new HubCellDataPurger(hub, async () => []).purge('org-a')).toEqual({ cellsPending: 0, cellsPurged: 0 });
    });
});
