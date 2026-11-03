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

import {
    mainReviewLinksDropped,
    resolveReviewKnowledge,
} from './review-knowledge';

const params = () => ({
    items: [
        {
            kind: 'skill',
            path: '.claude/skills/valve-rules',
            linkedTo: ['main-review'],
        } as any,
    ],
    customAgents: [],
    changedFiles: [{ filename: 'src/valves/open.ts' }],
    baseBranch: 'main',
    sandbox: undefined,
    codeManagement: {} as any,
    organizationAndTeamData: {
        organizationId: 'org-1',
        teamId: 'team-1',
    } as any,
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
                    linkedTo: ['main-review'],
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

describe('a guide of another repository linked to the main review', () => {
    const RULES = 'greenhouse/irrigation-rules';
    const local = {
        kind: 'doc' as const,
        path: 'docs/valves.md',
        linkedTo: ['main-review' as const],
    };
    const remote = (linkedTo: any[]) => ({
        kind: 'doc' as const,
        path: 'stack/node/pumps.md',
        repository: RULES,
        linkedTo,
    });
    const notRead = expect.objectContaining({
        kind: 'KNOWLEDGE_UNAVAILABLE',
        detail: `${RULES}:stack/node/pumps.md: guides of another repository are for custom agents only, so the main review did not read it`,
    });

    beforeEach(() => {
        mockResolveAll.mockReset();
        mockResolveAll.mockResolvedValue(new Map());
    });

    it('keeps its custom-agent links and drops only the main-review one', () => {
        const { items, outsideMainReview } = mainReviewLinksDropped([
            local,
            remote(['main-review', { agentId: 'pumps' }]),
            remote([{ agentId: 'valves' }]),
        ]);

        expect(items).toEqual([
            local,
            remote([{ agentId: 'pumps' }]),
            remote([{ agentId: 'valves' }]),
        ]);
        expect(outsideMainReview).toEqual([notRead]);
    });

    it('never reaches the built-in agents in a review, and the review says so', async () => {
        const result = await resolveReviewKnowledge({
            ...params(),
            items: [local, remote(['main-review'])],
        });

        expect(mockResolveAll).toHaveBeenCalledWith(
            expect.objectContaining({ items: [local] }),
        );
        expect(result.warnings).toEqual([notRead]);
    });

    it('says so even when it was the only skill or doc', async () => {
        const result = await resolveReviewKnowledge({
            ...params(),
            items: [remote(['main-review'])],
        });

        expect(mockResolveAll).not.toHaveBeenCalled();
        expect(result.warnings).toEqual([notRead]);
    });
});
