/**
 * What the agent page says about an agent's recent runs: that it is failing
 * and why, and which files its dropped findings cited without following them.
 * Fixture domain: an invented greenhouse-irrigation team and its rules repo.
 */
import type { CustomAgentRunRecord } from '@libs/code-review/domain/custom-agents/contracts';
import { toCustomAgentRunRecords } from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-summary';

import {
    GetCustomAgentsStatusUseCase,
    summarizeCustomAgentRuns,
    summarizeUnfollowedCitations,
} from './get-custom-agents-status.use-case';

const run = (
    over: Partial<CustomAgentRunRecord> & Pick<CustomAgentRunRecord, 'at'>,
): CustomAgentRunRecord => ({
    organizationId: 'org-1',
    repositoryId: 'repo-1',
    prNumber: 1,
    agentId: 'valves',
    status: 'ran',
    ...over,
});

describe('summarizeCustomAgentRuns', () => {
    it('counts the failed runs in a row from the newest, and the pull requests that failed', () => {
        const health = summarizeCustomAgentRuns([
            run({ at: new Date('2026-10-01T10:00:00Z'), prNumber: 1 }),
            run({
                at: new Date('2026-10-03T10:00:00Z'),
                prNumber: 3,
                status: 'failed',
                reason: 'MODEL_NOT_FOUND (HTTP 404)',
            }),
            run({
                at: new Date('2026-10-02T10:00:00Z'),
                prNumber: 2,
                status: 'incomplete',
                reason: 'max-steps',
            }),
            run({
                at: new Date('2026-10-03T11:00:00Z'),
                prNumber: 3,
                status: 'failed',
                reason: 'MODEL_NOT_FOUND (HTTP 404)',
            }),
        ]).get('valves');

        expect(health).toEqual({
            runs: 4,
            failedPullRequests: 2,
            last: {
                status: 'failed',
                reason: 'MODEL_NOT_FOUND (HTTP 404)',
                at: '2026-10-03T11:00:00.000Z',
                prNumber: 3,
            },
            streak: 3,
        });
    });

    it('has no streak once the newest run finished', () => {
        const health = summarizeCustomAgentRuns([
            run({ at: new Date('2026-10-01T10:00:00Z'), status: 'failed' }),
            run({ at: new Date('2026-10-02T10:00:00Z') }),
        ]).get('valves');

        expect(health?.streak).toBe(0);
        expect(health?.last.status).toBe('ran');
    });
});

describe('summarizeUnfollowedCitations', () => {
    const row = (reason: string, findings: number, prNumbers: number[]) => ({
        agentId: 'valves',
        reason,
        findings,
        prNumbers,
    });

    it('offers guide files, most cited first, merging the pull requests', () => {
        const cited = summarizeUnfollowedCitations([
            row(
                'irrigation-rules/stack/node/rules/valves.md is not a guide linked to this review',
                11,
                [1, 2],
            ),
            row(
                '`stack/node/rules/valves.md` is not a guide linked to this review',
                6,
                [2, 3],
            ),
            row('CLAUDE.md is not a guide linked to this review', 2, [4]),
            row(
                'irrigation-rules/stack/node/rules/valves.md is not a guide linked to this review',
                1,
                [5],
            ),
        ]).get('valves');

        expect(cited).toEqual([
            {
                file: 'irrigation-rules/stack/node/rules/valves.md',
                findings: 12,
                pullRequests: 3,
            },
            {
                file: 'stack/node/rules/valves.md',
                findings: 6,
                pullRequests: 2,
            },
            { file: 'CLAUDE.md', findings: 2, pullRequests: 1 },
        ]);
    });

    it('does not offer code files, tickets or other drop reasons', () => {
        expect(
            summarizeUnfollowedCitations([
                row(
                    'src/valves/open.ts is not a guide linked to this review',
                    3,
                    [1],
                ),
                row(
                    'Linear issue IRR-12 is not a guide linked to this review',
                    1,
                    [1],
                ),
                row('quote not found in docs/valves.md', 4, [1]),
            ]).get('valves'),
        ).toBeUndefined();
    });

    it('offers a skill by its SKILL.md and keeps the five most cited', () => {
        const cited = summarizeUnfollowedCitations([
            // The most cited, so the cap keeps it: it must be offered.
            row(
                'irrigation-rules/skills/pumps/SKILL.md is not a guide linked to this review',
                7,
                [1],
            ),
            ...[2, 3, 4, 5, 6].map((n) =>
                row(`docs/g${n}.md is not a guide linked to this review`, n, [
                    n,
                ]),
            ),
        ]).get('valves');

        expect(cited?.map((c) => c.file)).toEqual([
            'irrigation-rules/skills/pumps/SKILL.md',
            'docs/g6.md',
            'docs/g5.md',
            'docs/g4.md',
            'docs/g3.md',
        ]);
    });
});

describe('toCustomAgentRunRecords', () => {
    it('keeps the agents that started, with their reason, and not the ones with no files', () => {
        const at = new Date('2026-10-03T10:00:00Z');

        expect(
            toCustomAgentRunRecords({
                organizationId: 'org-1',
                repositoryId: 'repo-1',
                prNumber: 7,
                at,
                runs: [
                    { id: 'valves', status: 'ran' },
                    {
                        id: 'pumps',
                        status: 'failed',
                        reason: 'QUOTA_EXCEEDED (HTTP 429)',
                    },
                    { id: 'tanks', status: 'no-matching-files' },
                ],
            }),
        ).toEqual([
            {
                organizationId: 'org-1',
                repositoryId: 'repo-1',
                prNumber: 7,
                agentId: 'valves',
                status: 'ran',
                at,
            },
            {
                organizationId: 'org-1',
                repositoryId: 'repo-1',
                prNumber: 7,
                agentId: 'pumps',
                status: 'failed',
                reason: 'QUOTA_EXCEEDED (HTTP 429)',
                at,
            },
        ]);
    });
});

describe('GetCustomAgentsStatusUseCase with run records', () => {
    const empty = { toArray: async () => [] };

    it('lists an agent whose runs all failed, with why, and the files it cited', async () => {
        const aggregate = jest
            .fn()
            .mockReturnValueOnce(empty)
            .mockReturnValueOnce(empty)
            .mockReturnValueOnce({
                toArray: async () => [
                    {
                        agentId: 'valves',
                        reason: 'CLAUDE.md is not a guide linked to this review',
                        findings: 2,
                        prNumbers: [4],
                    },
                ],
            });
        const listSince = jest.fn(async () => [
            run({
                at: new Date('2026-10-03T10:00:00Z'),
                status: 'failed',
                reason: 'MODEL_ACCESS_DENIED (HTTP 403)',
                prNumber: 4,
            }),
        ]);
        const useCase = new GetCustomAgentsStatusUseCase(
            { getNativeCollection: () => ({ aggregate }) } as any,
            { record: jest.fn(), listSince },
        );

        const result = await useCase.execute({
            organizationId: 'org-1',
            repositoryId: 'repo-1',
            now: new Date('2026-10-17T00:00:00Z'),
        });

        expect(listSince).toHaveBeenCalledWith({
            organizationId: 'org-1',
            repositoryId: 'repo-1',
            since: new Date('2026-09-17T00:00:00Z'),
        });
        expect(result.agents).toEqual([
            {
                agentId: 'valves',
                pullRequests: 0,
                posted: 0,
                dropped: 0,
                health: {
                    runs: 1,
                    failedPullRequests: 1,
                    last: {
                        status: 'failed',
                        reason: 'MODEL_ACCESS_DENIED (HTTP 403)',
                        at: '2026-10-03T10:00:00.000Z',
                        prNumber: 4,
                    },
                    streak: 1,
                },
                unfollowedCitations: [
                    { file: 'CLAUDE.md', findings: 2, pullRequests: 1 },
                ],
            },
        ]);
        expect(result.runsUnavailable).toBeUndefined();
    });

    it('still shows the findings when the run records cannot be read', async () => {
        const aggregate = jest
            .fn()
            .mockReturnValueOnce({
                toArray: async () => [
                    { agentId: 'valves', prNumber: 1, deliveryStatus: 'sent' },
                ],
            })
            .mockReturnValue(empty);
        const useCase = new GetCustomAgentsStatusUseCase(
            { getNativeCollection: () => ({ aggregate }) } as any,
            {
                record: jest.fn(),
                listSince: jest.fn(async () => {
                    throw new Error('mongo down');
                }),
            },
        );

        const result = await useCase.execute({
            organizationId: 'org-1',
            repositoryId: 'repo-1',
        });

        expect(result.agents).toEqual([
            { agentId: 'valves', pullRequests: 1, posted: 1, dropped: 0 },
        ]);
        // Not an empty history: the page says the runs were not read.
        expect(result.runsUnavailable).toBe(true);
    });
});
