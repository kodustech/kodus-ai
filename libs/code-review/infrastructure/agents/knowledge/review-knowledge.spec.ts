/**
 * Fixture domain: an invented greenhouse-irrigation service and its skills.
 */
const mockResolveAll = jest.fn();
jest.mock('./knowledge-resolver', () => {
    const actual = jest.requireActual('./knowledge-resolver');
    return {
        ...actual,
        KnowledgeResolver: jest.fn().mockImplementation(() => ({
            resolveAll: mockResolveAll,
        })),
    };
});
const mockWarn = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: (...args: unknown[]) => mockWarn(...args),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

import { resolveReviewKnowledge } from './review-knowledge';

const params = () => ({
    items: [
        {
            kind: 'skill',
            path: '.claude/skills/valve-rules',
            targets: ['main-review'],
        } as any,
    ],
    customAgents: [],
    changedFiles: [{ filename: 'src/valves/open.ts' }],
    baseBranch: 'main',
    sandbox: undefined,
    codeManagement: {} as any,
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' } as any,
    repository: { id: 'repo-1', name: 'greenhouse' },
    logContext: 'spec',
    prNumber: 7,
});

describe('resolveReviewKnowledge', () => {
    beforeEach(() => {
        mockWarn.mockClear();
        mockResolveAll.mockReset();
        mockResolveAll.mockRejectedValue(new Error('ls-tree died'));
    });

    it('logs each skill or doc that could not be read, by code and path, with the review ids', async () => {
        mockResolveAll.mockResolvedValue(
            new Map([
                [
                    'agent-1',
                    {
                        skills: [],
                        docs: [],
                        warnings: [
                            {
                                code: 'DOC_NOT_FOUND',
                                path: 'docs/valves.md',
                                detail: 'secret body text',
                            },
                        ],
                    },
                ],
            ]),
        );

        await resolveReviewKnowledge(params());

        expect(mockWarn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    teamId: 'team-1',
                    repositoryId: 'repo-1',
                    prNumber: 7,
                    problems: [
                        {
                            target: 'agent-1',
                            code: 'DOC_NOT_FOUND',
                            path: 'docs/valves.md',
                        },
                    ],
                }),
            }),
        );
    });

    it('reports a warning when no skill or doc could be read, instead of reviewing silently without them', async () => {
        const result = await resolveReviewKnowledge({
            items: [
                {
                    kind: 'skill',
                    path: '.claude/skills/valve-rules',
                    targets: ['main-review'],
                } as any,
            ],
            customAgents: [],
            changedFiles: [{ filename: 'src/valves/open.ts' }],
            baseBranch: 'main',
            sandbox: undefined,
            codeManagement: {} as any,
            organizationAndTeamData: { organizationId: 'org-1' } as any,
            repository: { id: 'repo-1', name: 'greenhouse' },
            logContext: 'spec',
        });

        expect(result.byTarget).toBeUndefined();
        expect(result.warnings).toEqual([
            expect.objectContaining({
                kind: 'KNOWLEDGE_UNAVAILABLE',
                reason: 'knowledge',
            }),
        ]);
    });
});
