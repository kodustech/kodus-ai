/**
 * readReference reads the reviewed repository, the linked ones, and the
 * repositories the review's skills and docs live in. A skill or doc counts as
 * another repository's only when the knowledge reader routes it there: a path
 * of the reviewed repository can hold a colon too.
 */
import { MultiRepositoryKnowledgeReader } from '@libs/code-review/infrastructure/agents/knowledge/base-branch-reader';

import { knowledgeRepositories } from './base-code-review-agent.provider';

const local = {
    ref: 'main',
    readFile: async () => ({ status: 'missing' as const }),
    listFiles: async () => [],
    matchFiles: async () => [],
};
const reader = new MultiRepositoryKnowledgeReader(local, [
    {
        source: {
            fullName: 'acme/rules',
            id: 'r1',
            name: 'rules',
            ref: 'main',
        },
        reader: local,
    },
]);

const knowledge = (paths: { skills?: string[]; docs?: string[] }) =>
    ({
        ref: 'main',
        skills: (paths.skills ?? []).map((path) => ({ path })),
        docs: (paths.docs ?? []).map((path) => ({ path })),
        warnings: [],
    }) as any;

describe('readReference repositories from the review knowledge', () => {
    it('takes the repository a linked skill lives in', () => {
        expect(
            knowledgeRepositories(
                knowledge({ skills: ['acme/rules:skills/money/SKILL.md'] }),
                reader,
            ),
        ).toEqual(['acme/rules']);
    });

    it('takes none from a doc of the reviewed repository whose path holds a colon', () => {
        expect(
            knowledgeRepositories(
                knowledge({ docs: ['docs/payments:2024.md'] }),
                reader,
            ),
        ).toEqual([]);
    });

    it('takes none without a knowledge reader', () => {
        expect(
            knowledgeRepositories(
                knowledge({ skills: ['acme/rules:skills/money/SKILL.md'] }),
                undefined,
            ),
        ).toEqual([]);
    });
});
