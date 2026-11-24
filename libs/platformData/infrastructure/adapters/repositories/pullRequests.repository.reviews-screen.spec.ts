import { PullRequestsRepository } from './pullRequests.repository';
import {
    OPEN_PULL_REQUESTS_INDEX,
    PULL_REQUEST_TITLE_INDEX,
} from './schemas/pullRequests.model';

/**
 * The MongoDB reads behind the Reviews screen: what each one asks for, which
 * index it names, and what it does on a deployment that lacks that index.
 *
 * The model is a stand-in, so these say nothing about whether the queries
 * return the right documents — pullRequests-open-count.integration.spec.ts
 * does that against a real MongoDB. They pin the shape of the request.
 */

const UNKNOWN_HINT = Object.assign(
    new Error(
        'error processing query: planner returned error :: caused by :: hint provided does not correspond to an existing index',
    ),
    { code: 2 },
);

/** A mongoose query: every builder call is recorded and returns the query. */
const fakeQuery = (execute: (calls: Record<string, unknown[]>) => unknown) => {
    const calls: Record<string, unknown[]> = {};
    const query: any = {};
    for (const method of ['hint', 'limit', 'lean', 'maxTimeMS']) {
        query[method] = jest.fn((...args: unknown[]) => {
            calls[method] = args;
            return query;
        });
    }
    query.exec = jest.fn(async () => execute(calls));
    return { query, calls };
};

const build = (answer: (calls: Record<string, unknown[]>) => unknown) => {
    const issued: Array<Record<string, unknown[]>> = [];
    const start = () => {
        const { query, calls } = fakeQuery(answer);
        issued.push(calls);
        return query;
    };
    const model = {
        countDocuments: jest.fn(start),
        find: jest.fn(start),
        aggregate: jest.fn(),
    };
    const repository = new PullRequestsRepository(model as any);

    return { repository, model, issued };
};

const withoutIndex =
    <T>(value: T) =>
    (calls: Record<string, unknown[]>) => {
        if (calls.hint) throw UNKNOWN_HINT;
        return value;
    };

describe('PullRequestsRepository.countDeliveredPullRequests', () => {
    it('hints the open-PR index when it counts open pull requests', async () => {
        const { repository, model, issued } = build(() => 7);

        const count = await repository.countDeliveredPullRequests(
            'org-1',
            ['r1', 'r2'],
            { unresolvedOnly: true, openOnly: true },
        );

        expect(count).toBe(7);
        expect(model.countDocuments).toHaveBeenCalledTimes(1);
        expect(model.countDocuments).toHaveBeenCalledWith({
            'organizationId': 'org-1',
            'repository.id': { $in: ['r1', 'r2'] },
            'merged': { $ne: true },
            'status': { $nin: ['closed'] },
            'files': {
                $elemMatch: {
                    suggestions: {
                        $elemMatch: {
                            deliveryStatus: 'sent',
                            implementationStatus: { $ne: 'implemented' },
                        },
                    },
                },
            },
        });
        expect(issued[0].hint).toEqual([OPEN_PULL_REQUESTS_INDEX]);
        expect(issued[0].maxTimeMS).toEqual([expect.any(Number)]);
    });

    it('leaves the plan to the server when the count is not about open PRs', async () => {
        const { repository, model, issued } = build(() => 4);

        const count = await repository.countDeliveredPullRequests(
            'org-1',
            undefined,
            { authorEmail: 'Me@Acme.dev' },
        );

        expect(count).toBe(4);
        expect(issued[0].hint).toBeUndefined();
        expect(issued[0].maxTimeMS).toEqual([expect.any(Number)]);
        expect(model.countDocuments).toHaveBeenCalledWith({
            'organizationId': 'org-1',
            '$expr': {
                $eq: [
                    { $toLower: { $ifNull: ['$user.email', ''] } },
                    'me@acme.dev',
                ],
            },
            'files.suggestions.deliveryStatus': 'sent',
        });
    });

    it('counts without the hint on a deployment that lacks the index', async () => {
        const { repository, model, issued } = build(withoutIndex(3));

        const count = await repository.countDeliveredPullRequests(
            'org-1',
            ['r1'],
            { unresolvedOnly: true, openOnly: true },
        );

        expect(count).toBe(3);
        expect(model.countDocuments).toHaveBeenCalledTimes(2);
        expect(issued[0].hint).toEqual([OPEN_PULL_REQUESTS_INDEX]);
        expect(issued[1].hint).toBeUndefined();
        // Same filter both times: the fallback changes the plan, not the count.
        expect(model.countDocuments.mock.calls[1]).toEqual(
            model.countDocuments.mock.calls[0],
        );
    });

    it('does not retry, and does not hide, any other failure', async () => {
        const { repository, model } = build(() => {
            throw new Error('operation exceeded time limit');
        });

        await expect(
            repository.countDeliveredPullRequests('org-1', ['r1'], {
                unresolvedOnly: true,
                openOnly: true,
            }),
        ).rejects.toThrow('operation exceeded time limit');
        expect(model.countDocuments).toHaveBeenCalledTimes(1);
    });
});

describe('PullRequestsRepository.findOpenPullRequestKeys', () => {
    const rows = (count: number) =>
        Array.from({ length: count }, (_, i) => ({
            number: i + 1,
            repository: { id: 900 + (i % 2) },
        }));

    it('asks for the keys of open PRs through the open-PR index', async () => {
        const { repository, model, issued } = build(() => rows(2));

        const result = await repository.findOpenPullRequestKeys(
            'org-1',
            ['900', '901'],
            { limit: 10 },
        );

        expect(result).toEqual({
            keys: [
                { number: 1, repositoryId: '900' },
                { number: 2, repositoryId: '901' },
            ],
            truncated: false,
        });
        expect(model.find).toHaveBeenCalledWith(
            {
                'organizationId': 'org-1',
                'merged': { $ne: true },
                'status': { $nin: ['closed'] },
                'repository.id': { $in: ['900', '901'] },
            },
            { 'number': 1, 'repository.id': 1, '_id': 0 },
        );
        expect(issued[0].hint).toEqual([OPEN_PULL_REQUESTS_INDEX]);
        // One more than the limit, to tell "exactly the limit" from "more".
        expect(issued[0].limit).toEqual([11]);
        expect(issued[0].maxTimeMS).toEqual([expect.any(Number)]);
    });

    it('adds the unresolved-suggestion condition only when asked', async () => {
        const { repository, model } = build(() => []);

        await repository.findOpenPullRequestKeys('org-1', undefined, {
            unresolvedOnly: true,
            limit: 10,
        });

        const [filter] = model.find.mock.calls[0] as any[];
        expect(filter).toEqual({
            organizationId: 'org-1',
            merged: { $ne: true },
            status: { $nin: ['closed'] },
            files: {
                $elemMatch: {
                    suggestions: {
                        $elemMatch: {
                            deliveryStatus: 'sent',
                            implementationStatus: { $ne: 'implemented' },
                        },
                    },
                },
            },
        });
    });

    it('reports exactly the limit as complete and one more as truncated', async () => {
        const atLimit = build(() => rows(3));
        await expect(
            atLimit.repository.findOpenPullRequestKeys('org-1', undefined, {
                limit: 3,
            }),
        ).resolves.toMatchObject({ truncated: false, keys: { length: 3 } });

        const past = build(() => rows(4));
        const result = await past.repository.findOpenPullRequestKeys(
            'org-1',
            undefined,
            { limit: 3 },
        );
        expect(result.truncated).toBe(true);
        expect(result.keys).toHaveLength(3);
    });

    it('drops documents without a number or a repository', async () => {
        const { repository } = build(() => [
            { number: 1, repository: { id: 'r1' } },
            { repository: { id: 'r1' } },
            { number: 3 },
            { number: 4, repository: {} },
        ]);

        const { keys } = await repository.findOpenPullRequestKeys(
            'org-1',
            undefined,
            { limit: 10 },
        );

        expect(keys).toEqual([{ number: 1, repositoryId: 'r1' }]);
    });

    it('reads without the hint on a deployment that lacks the index', async () => {
        const { repository, model, issued } = build(withoutIndex(rows(1)));

        const result = await repository.findOpenPullRequestKeys(
            'org-1',
            undefined,
            { limit: 10 },
        );

        expect(result.keys).toHaveLength(1);
        expect(model.find).toHaveBeenCalledTimes(2);
        expect(issued[1].hint).toBeUndefined();
        expect(issued[1].limit).toEqual([11]);
    });
});

describe('PullRequestsRepository.findPRNumbersByTitleAndOrganization', () => {
    it('reads only indexed fields through the title index', async () => {
        const { repository, model, issued } = build(() => [
            { number: 7, repository: { id: 'r1' } },
            { number: 9 },
        ]);

        const result = await repository.findPRNumbersByTitleAndOrganization(
            'login',
            'org-1',
            ['r1'],
        );

        expect(result).toEqual([
            { number: 7, repositoryId: 'r1' },
            { number: 9, repositoryId: '' },
        ]);
        // `_id: 0` is what keeps the documents from being loaded: every other
        // projected field is in the index.
        expect((model.find.mock.calls[0] as unknown[])[1]).toEqual({
            'number': 1,
            'repository.id': 1,
            '_id': 0,
        });
        expect(issued[0].hint).toEqual([PULL_REQUEST_TITLE_INDEX]);
        expect(issued[0].maxTimeMS).toEqual([expect.any(Number)]);
    });

    it('searches without the hint on a deployment that lacks the index', async () => {
        const { repository, model, issued } = build(
            withoutIndex([{ number: 7, repository: { id: 'r1' } }]),
        );

        const result = await repository.findPRNumbersByTitleAndOrganization(
            'login',
            'org-1',
        );

        expect(result).toEqual([{ number: 7, repositoryId: 'r1' }]);
        expect(model.find).toHaveBeenCalledTimes(2);
        expect(issued[1].hint).toBeUndefined();
        expect(model.find.mock.calls[1]).toEqual(model.find.mock.calls[0]);
    });

    it('propagates a failure that is not about the index', async () => {
        const { repository, model } = build(() => {
            throw new Error('operation exceeded time limit');
        });

        await expect(
            repository.findPRNumbersByTitleAndOrganization('login', 'org-1'),
        ).rejects.toThrow('operation exceeded time limit');
        expect(model.find).toHaveBeenCalledTimes(1);
    });
});
