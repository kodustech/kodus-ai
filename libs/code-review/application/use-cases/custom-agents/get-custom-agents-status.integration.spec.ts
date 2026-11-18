/**
 * The custom agents page counts, per agent, the PRs it acted on, the findings
 * it posted and dropped, and the guides its dropped findings cited without
 * following. Those numbers come from aggregations over the PR documents, and
 * must not depend on anything outside the fields the counts read.
 *
 * Runs the real use case against a REAL MongoDB; skipped when none is
 * reachable. Point it at one with CUSTOM_AGENTS_IT_MONGO_URI (or MONGODB_URI).
 */
import { MongoClient } from 'mongodb';

import { buildMongoUri } from '@libs/core/infrastructure/database/mongo/mongo-migration-client';

import { GetCustomAgentsStatusUseCase } from './get-custom-agents-status.use-case';

const TEST_DB = 'kodus_custom_agents_status_it';
const now = new Date('2026-11-18T12:00:00Z');
const recent = new Date('2026-11-10T12:00:00Z');

const finding = (agentId: string, over: Record<string, unknown> = {}) => ({
    id: `${agentId}-${Math.random()}`,
    customAgent: { id: agentId },
    deliveryStatus: 'sent',
    suggestionContent: 'x'.repeat(2000),
    ...over,
});

describe('custom agents status (real MongoDB)', () => {
    let client: MongoClient | null = null;
    let available = false;

    beforeAll(async () => {
        try {
            client = new MongoClient(
                process.env.CUSTOM_AGENTS_IT_MONGO_URI ??
                    process.env.MONGODB_URI ??
                    buildMongoUri(),
                { serverSelectionTimeoutMS: 2000 },
            );
            await client.connect();
            available = true;
        } catch {
            console.warn(
                '[custom-agents-status-it] no Mongo reachable — skipping',
            );
            return;
        }
        const prs = client.db(TEST_DB).collection('pullRequests');
        await prs.deleteMany({});
        await prs.insertMany([
            {
                organizationId: 'org',
                repository: { id: 'repo' },
                number: 1,
                updatedAt: recent,
                files: [
                    {
                        path: 'a.ts',
                        patch: '@@\n'.repeat(500),
                        suggestions: [
                            finding('agent-a'),
                            finding('agent-a', {
                                deliveryStatus: 'not_sent',
                                priorityStatus: 'discarded_by_safeguard',
                                discardReason:
                                    '`docs/style.md` is not a guide linked to this review',
                            }),
                            { id: 'plain', deliveryStatus: 'sent' },
                        ],
                    },
                ],
                prLevelSuggestions: [finding('agent-b')],
            },
            {
                organizationId: 'org',
                repository: { id: 'repo' },
                number: 2,
                updatedAt: recent,
                files: [{ path: 'b.ts', suggestions: [finding('agent-a')] }],
            },
            // Another repository: not counted.
            {
                organizationId: 'org',
                repository: { id: 'other' },
                number: 3,
                updatedAt: recent,
                files: [{ path: 'c.ts', suggestions: [finding('agent-a')] }],
            },
        ]);
    });

    afterAll(async () => {
        if (available) await client!.db(TEST_DB).dropDatabase();
        await client?.close();
    });

    it("counts each agent's PRs, posted and dropped findings, and cited guides", async () => {
        if (!available) return;
        const useCase = new GetCustomAgentsStatusUseCase({
            getNativeCollection: () =>
                client!.db(TEST_DB).collection('pullRequests'),
        } as any);

        const result = await useCase.execute({
            organizationId: 'org',
            repositoryId: 'repo',
            now,
        });
        const byAgent = Object.fromEntries(
            result.agents.map((agent: any) => [agent.agentId, agent]),
        );

        expect(Object.keys(byAgent).sort()).toEqual(['agent-a', 'agent-b']);
        expect(byAgent['agent-a']).toMatchObject({
            pullRequests: 2,
            posted: 2,
            dropped: 1,
            unfollowedCitations: [
                { file: 'docs/style.md', findings: 1, pullRequests: 1 },
            ],
        });
        expect(byAgent['agent-b']).toMatchObject({
            pullRequests: 1,
            posted: 1,
            dropped: 0,
        });
    });
});
