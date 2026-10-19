/**
 * Fixture domain: an invented greenhouse-irrigation service and its skills.
 */
jest.mock('./knowledge-resolver', () => {
    const actual = jest.requireActual('./knowledge-resolver');
    return {
        ...actual,
        KnowledgeResolver: jest.fn().mockImplementation(() => ({
            resolveAll: jest.fn().mockRejectedValue(new Error('ls-tree died')),
        })),
    };
});

import { resolveReviewKnowledge } from './review-knowledge';

describe('resolveReviewKnowledge', () => {
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
