import { randomUUID } from 'node:crypto';
import mongoose, { Connection, Model } from 'mongoose';

import { resolveMongoTestGate } from '../mongo-test-uri';
import { PullRequestsRepository } from '@libs/platformData/infrastructure/adapters/repositories/pullRequests.repository';
import {
    PullRequestsModel,
    PullRequestsSchema,
} from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';

const gate = resolveMongoTestGate('kodus_test_reaction_refs');
const describeMongo = gate.shouldSkip ? describe.skip : describe;

/**
 * The reported failure (#2625): one organization, PR number 84 living in six
 * repositories created between February and November. The sync matched on the
 * number alone, read all six, and the organization's GitLab answered 429 on
 * every run. These cases run the real aggregation, so the shape of the match
 * is proven against Mongo rather than against a mock of it.
 */
describeMongo('delivered suggestions are read per repository', () => {
    let connection: Connection;
    let model: Model<PullRequestsModel>;
    let repository: PullRequestsRepository;

    const delivered = (number: number, repositoryId: string) => ({
        organizationId: 'org-1',
        number,
        status: 'merged',
        provider: 'gitlab',
        url: `https://gitlab.com/${repositoryId}/-/merge_requests/${number}`,
        repository: { id: repositoryId, name: repositoryId },
        files: [
            {
                filename: 'a.ts',
                suggestions: [
                    {
                        id: `suggestion-${repositoryId}-${number}`,
                        deliveryStatus: 'sent',
                        comment: { id: `${repositoryId}-comment-${number}` },
                    },
                ],
            },
        ],
    });

    const read = (
        refs: Array<{ repositoryId?: string; pullRequestNumber: number }>,
    ) =>
        repository.findPullRequestsWithDeliveredSuggestions('org-1', refs, [
            'merged',
            'closed',
        ]);

    beforeAll(async () => {
        connection = await mongoose
            .createConnection(gate.mongoUri, {
                dbName: `kodus_reaction_refs_${randomUUID().replaceAll('-', '')}`,
                autoIndex: false,
                serverSelectionTimeoutMS: 5000,
            })
            .asPromise();
        model = connection.model(PullRequestsModel.name, PullRequestsSchema);
        repository = new PullRequestsRepository(model);
    });

    beforeEach(async () => {
        await model.collection.deleteMany({});
        await model.collection.insertMany([
            delivered(84, 'repo-a'),
            delivered(84, 'repo-b'),
            delivered(84, 'repo-c'),
            delivered(7, 'repo-a'),
            delivered(7, 'repo-b'),
            // A document written before the repository id was captured.
            delivered(55, ''),
        ] as any);
    });

    afterAll(async () => {
        await connection?.dropDatabase();
        await connection?.close();
    });

    it('reads the PR of the repository it was asked for', async () => {
        const found = await read([
            { repositoryId: 'repo-a', pullRequestNumber: 84 },
        ]);

        expect(found.map((pr) => `${pr.repository.id}:${pr.number}`)).toEqual([
            'repo-a:84',
        ]);
    });

    it('reads every pair of the window, and only them', async () => {
        const found = await read([
            { repositoryId: 'repo-a', pullRequestNumber: 84 },
            { repositoryId: 'repo-b', pullRequestNumber: 7 },
        ]);

        expect(
            found.map((pr) => `${pr.repository.id}:${pr.number}`).sort(),
        ).toEqual(['repo-a:84', 'repo-b:7']);
    });

    it('still matches the number alone for a reference with no repository', async () => {
        // The shape a message published before the pair existed is read with:
        // every repository that used the number answers.
        const found = await read([{ pullRequestNumber: 84 }]);

        expect(
            found.map((pr) => `${pr.repository.id}:${pr.number}`).sort(),
        ).toEqual(['repo-a:84', 'repo-b:84', 'repo-c:84']);
    });

    it('keeps a document stored before the repository id was captured', async () => {
        // Such a row stores `repository.id: ''`, and the pair clause alone
        // would make it unreachable: its reactions would stop being synced.
        const found = await read([
            { repositoryId: 'repo-a', pullRequestNumber: 55 },
        ]);

        expect(found.map((pr) => `${pr.repository.id}:${pr.number}`)).toEqual([
            ':55',
        ]);
    });

    it('asks nothing of the database when it has no reference', async () => {
        expect(await read([])).toEqual([]);
    });
});
