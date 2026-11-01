/**
 * Rules kept in another repository (#2329): how a finding that applies one is
 * cited in the comment, what a save of such a link must state, and how a
 * directory overrides it.
 * Fixture domain: an invented greenhouse-irrigation team and its rules repo.
 */
import { withDirectoryAgentLists } from '@libs/code-review/domain/custom-agents/directory-cascade';
import { knowledgeBudgets } from '@libs/code-review/domain/custom-agents/resolve-report';
import {
    knowledgeItemSchema,
    knowledgeSourceProblems,
    parseKnowledgeSourcePath,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import {
    findingCitation,
    repositoryFileUrl,
} from './custom-agent-presentation';

const RULES = 'greenhouse/irrigation-rules';
const source = {
    fullName: RULES,
    id: '20',
    name: 'irrigation-rules',
    ref: 'trunk',
    httpUrl: `https://github.com/${RULES}`,
};
const finding = (file: string) =>
    ({
        relevantFile: 'src/valves/open.ts',
        customAgent: { id: 'valves', name: 'Valves' },
        kind: 'convention',
        source: {
            file,
            quote: 'Every valve handler must log the zone id.',
        },
    }) as any;

describe('citing a rule of another repository', () => {
    it('links the file at the ref it was read on and quotes the rule', () => {
        expect(
            findingCitation(
                finding(`${RULES}:stack/node/rules/valves.md`),
                [],
                {
                    sources: [{ ...source, visibility: 'public' }],
                    platform: PlatformType.GITHUB,
                    reviewedIsPublic: true,
                },
            ),
        ).toBe(
            `\n\n**Rule** ([\`${RULES}:stack/node/rules/valves.md\`](https://github.com/${RULES}/blob/trunk/stack/node/rules/valves.md)):\n> Every valve handler must log the zone id.`,
        );
    });

    it('names a private rule without quoting it on a public repository', () => {
        const citation = findingCitation(
            finding(`${RULES}:stack/node/rules/valves.md`),
            [],
            {
                sources: [{ ...source, visibility: 'private' }],
                platform: PlatformType.GITHUB,
                reviewedIsPublic: true,
            },
        );

        expect(citation).toBe(
            `\n\n**Rule**: [\`${RULES}:stack/node/rules/valves.md\`](https://github.com/${RULES}/blob/trunk/stack/node/rules/valves.md)`,
        );
        expect(citation).not.toContain('zone id');
    });

    it('quotes a private rule on a private repository', () => {
        expect(
            findingCitation(
                finding(`${RULES}:stack/node/rules/valves.md`),
                [],
                {
                    sources: [{ ...source, visibility: 'private' }],
                    platform: PlatformType.GITHUB,
                    reviewedIsPublic: false,
                },
            ),
        ).toContain('> Every valve handler must log the zone id.');
    });

    it('cites a rule of the reviewed repository exactly as before', () => {
        expect(findingCitation(finding('docs/valves.md'))).toBe(
            '\n\n**Rule** (`docs/valves.md`):\n> Every valve handler must log the zone id.',
        );
    });

    it.each([
        [
            PlatformType.GITLAB,
            'https://gitlab.com/g/rules.git',
            'https://gitlab.com/g/rules/-/blob/v3/a%20b/c.md',
        ],
        [
            PlatformType.BITBUCKET,
            'https://bitbucket.org/g/rules',
            'https://bitbucket.org/g/rules/src/v3/a%20b/c.md',
        ],
        [
            PlatformType.AZURE_REPOS,
            'https://dev.azure.com/o/p/_git/rules',
            'https://dev.azure.com/o/p/_git/rules?path=/a%20b/c.md&version=GBv3',
        ],
        [
            PlatformType.BITBUCKET,
            'https://git.example.com/scm/g/rules.git',
            undefined,
        ],
        ['FORGEJO', 'https://forge.example.com/g/rules', undefined],
    ])(
        'builds the %s file link only where the URL shape is known',
        (platform, httpUrl, expected) => {
            expect(
                repositoryFileUrl({ httpUrl, ref: 'v3' }, 'a b/c.md', platform),
            ).toBe(expected);
        },
    );
});

describe('saving a skill or doc of another repository', () => {
    const item = (over: Record<string, unknown>) => ({
        path: 'stack/node/rules/valves.md',
        kind: 'doc',
        linkedTo: ['main-review'],
        ...over,
    });

    it('accepts owner/repo (and subgroups) with an optional branch or tag', () => {
        for (const repository of [
            RULES,
            'greenhouse/platform/rules',
            'Org/My Project/rules',
        ]) {
            expect(
                knowledgeItemSchema.safeParse(
                    item({ repository, ref: 'release/v3' }),
                ).success,
            ).toBe(true);
        }
    });

    it('rejects a repository or ref that could not name one', () => {
        for (const repository of [
            'rules',
            'greenhouse/rules:main',
            '-x/rules',
            'greenhouse//rules',
        ]) {
            expect(
                knowledgeItemSchema.safeParse(item({ repository })).success,
            ).toBe(false);
        }
        expect(
            knowledgeItemSchema.safeParse(
                item({ repository: RULES, ref: '--upload-pack=x' }),
            ).success,
        ).toBe(false);
    });

    it('refuses a ref without a repository, two refs for one repository, and duplicates', () => {
        expect(
            knowledgeSourceProblems([
                item({ ref: 'v3' }),
                item({ repository: RULES }),
                item({ repository: RULES, path: 'other.md', ref: 'v3' }),
                item({ repository: RULES }),
            ]),
        ).toEqual([
            "stack/node/rules/valves.md sets a ref but no repository; the reviewed repository is read on the pull request's target branch",
            `${RULES} is read at both "its default branch" and "v3"; use one branch or tag per repository`,
            `${RULES}:stack/node/rules/valves.md is listed twice`,
        ]);
    });

    it('treats the same path in two repositories as two entries', () => {
        expect(
            knowledgeSourceProblems([item({}), item({ repository: RULES })]),
        ).toEqual([]);
    });

    it('splits a qualified path back into repository and path', () => {
        expect(
            parseKnowledgeSourcePath(`${RULES}:stack/node/rules/valves.md`),
        ).toEqual({
            repository: RULES,
            path: 'stack/node/rules/valves.md',
        });
        expect(parseKnowledgeSourcePath('docs/valves.md')).toBeNull();
    });

    it('counts doc tokens per repository, not per path', () => {
        const items = [
            item({ linkedTo: [{ agentId: 'valves' }] }),
            item({ repository: RULES, linkedTo: [{ agentId: 'valves' }] }),
        ] as any;
        const [budget] = knowledgeBudgets(items, [
            {
                path: 'stack/node/rules/valves.md',
                kind: 'doc',
                found: true,
                issues: [],
                tokens: 100,
            },
            {
                path: 'stack/node/rules/valves.md',
                kind: 'doc',
                found: true,
                issues: [],
                tokens: 7,
                repository: RULES,
            },
        ]);

        expect(budget.docTokens).toBe(107);
    });
});

describe('a directory overriding knowledge', () => {
    it('replaces only the entry of the same repository and path', () => {
        const inherited = [
            { path: 'docs/valves.md', kind: 'doc', linkedTo: ['main-review'] },
            {
                path: 'docs/valves.md',
                kind: 'doc',
                repository: RULES,
                linkedTo: ['main-review'],
            },
        ];
        const directory = [
            {
                path: 'docs/valves.md',
                kind: 'doc',
                repository: RULES,
                linkedTo: [],
            },
        ];

        const result = withDirectoryAgentLists(
            {},
            { knowledge: inherited },
            { knowledge: directory },
        ) as {
            knowledge: unknown[];
        };

        expect(result.knowledge).toEqual([inherited[0], directory[0]]);
    });
});
