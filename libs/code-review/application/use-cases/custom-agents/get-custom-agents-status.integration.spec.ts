/**
 * The custom agents page counts, per agent, the PRs it acted on, the findings
 * it posted and dropped, and the guides its dropped findings cited without
 * following. Those numbers come from aggregations over the PR documents, and
 * must not depend on anything outside the fields the counts read.
 *
 * Runs the real use case against a REAL MongoDB.
 */
import mongoose, { Connection } from 'mongoose';

import { GetCustomAgentsStatusUseCase } from './get-custom-agents-status.use-case';
import { resolveMongoTestGate } from '../../../../../test/integration/mongo-test-uri';

// Runs in CI (TEST_MONGODB_URI); skips locally without it, fails in CI
// when the URI is missing instead of passing with nothing asserted.
const gate = resolveMongoTestGate();
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

(gate.shouldSkip ? describe.skip : describe)(
    'custom agents status (real MongoDB)',
    () => {
        let connection: Connection | null = null;
        let client: any = null;
        let available = false;

        beforeAll(async () => {
            // Connected through Mongoose: the bare mongodb 7.6 driver builds its
            // handshake metadata from a Map that serializes empty inside Jest's realm,
            // and the server rejects the connection.
            connection = await mongoose
                .createConnection(gate.mongoUri, {
                    serverSelectionTimeoutMS: 5000,
                })
                .asPromise();
            client = connection.getClient();
            available = true;
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
                    files: [
                        { path: 'b.ts', suggestions: [finding('agent-a')] },
                    ],
                },
                // Another repository: not counted.
                {
                    organizationId: 'org',
                    repository: { id: 'other' },
                    number: 3,
                    updatedAt: recent,
                    files: [
                        { path: 'c.ts', suggestions: [finding('agent-a')] },
                    ],
                },
            ]);
        });

        afterAll(async () => {
            if (available) await client!.db(TEST_DB).dropDatabase();
            await connection?.close();
        });

        it("counts each agent's PRs, posted and dropped findings, and cited guides", async () => {
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
    },
);
