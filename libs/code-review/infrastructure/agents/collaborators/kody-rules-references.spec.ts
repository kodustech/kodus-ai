import {
    buildReferenceSection,
    collectLoadedReferences,
    loadRuleSourceReferences,
    mergeRuleReferences,
    RuleReference,
} from './kody-rules-references';

const sourceRef = (over: Partial<RuleReference> = {}): RuleReference => ({
    source: 'rule-source',
    filePath: 'CLAUDE.md',
    content: 'the convention',
    ...over,
});

const contextRef = (over: Partial<RuleReference> = {}): RuleReference => ({
    source: 'context-os',
    filePath: 'docs/conventions.md',
    content: 'context convention',
    ...over,
});

describe('loadRuleSourceReferences', () => {
    it('returns the sourcePath file per rule uuid without touching the rule text', async () => {
        const rules = [
            {
                uuid: 'r1',
                title: 't',
                rule: 'Follow the imports convention.',
                sourcePath: '.cursor/rules/imports.mdc',
                sourceAnchor: 'Imports',
            },
        ];
        const index = await loadRuleSourceReferences(rules, async (path) =>
            path === '.cursor/rules/imports.mdc'
                ? 'Do not import package:http/http.dart'
                : '',
        );

        expect(rules[0].rule).toBe('Follow the imports convention.');
        expect(index.get('r1')).toEqual([
            {
                source: 'rule-source',
                filePath: '.cursor/rules/imports.mdc',
                anchor: 'Imports',
                content: 'Do not import package:http/http.dart',
            },
        ]);
    });

    it('reads each path once, however many units or rules point at it', async () => {
        const read = jest.fn().mockResolvedValue('shared file');
        const atoms = Array.from({ length: 12 }, (_, i) => ({
            uuid: 'parent',
            title: `atom ${i}`,
            rule: `spec ${i}`,
            sourcePath: 'CLAUDE.md',
        }));
        const other = {
            uuid: 'other',
            title: 'o',
            rule: 'o',
            sourcePath: 'CLAUDE.md',
        };

        const index = await loadRuleSourceReferences([...atoms, other], read);

        expect(read).toHaveBeenCalledTimes(1);
        expect(index.get('parent')).toHaveLength(1);
        expect(index.get('other')).toHaveLength(1);
    });

    it('reads at most a few paths at a time', async () => {
        let inFlight = 0;
        let peak = 0;
        const read = jest.fn(async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setImmediate(resolve));
            inFlight--;
            return 'file';
        });
        const rules = Array.from({ length: 10 }, (_, i) => ({
            uuid: `r${i}`,
            title: 't',
            rule: 'r',
            sourcePath: `docs/${i}.md`,
        }));

        const index = await loadRuleSourceReferences(rules, read);

        expect(read).toHaveBeenCalledTimes(10);
        expect(index.size).toBe(10);
        expect(peak).toBeLessThanOrEqual(4);
    });

    it('cuts the content at maxRefChars', async () => {
        const index = await loadRuleSourceReferences(
            [{ uuid: 'r1', rule: 'r', sourcePath: 'big.md' }],
            async () => 'Z'.repeat(10_000),
            { maxRefChars: 100 },
        );
        expect(index.get('r1')![0].content).toBe('Z'.repeat(100));
    });

    it('skips a rule whose read throws, and warns once per path with the review it belongs to', async () => {
        const logger = { warn: jest.fn() };
        const logMetadata = {
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't-1' },
            prNumber: 7,
        };
        const index = await loadRuleSourceReferences(
            [
                { uuid: 'r1', rule: 'a', sourcePath: 'missing.md' },
                { uuid: 'r1', rule: 'b', sourcePath: 'missing.md' },
                { uuid: 'r2', rule: 'c', sourcePath: 'missing.md' },
            ],
            async () => {
                throw new Error('file not found');
            },
            { logger, logMetadata },
        );

        expect(index.size).toBe(0);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                context: 'kody-rules-sharded',
                metadata: expect.objectContaining({
                    ...logMetadata,
                    sourcePath: 'missing.md',
                    ruleUuids: ['r1', 'r2'],
                }),
            }),
        );
    });

    it('skips rules without a sourcePath, empty files, and a missing sandbox', async () => {
        const read = jest.fn().mockResolvedValue('   ');
        expect(
            (
                await loadRuleSourceReferences(
                    [
                        { uuid: 'r1', rule: 'plain' },
                        { uuid: 'r2', rule: 'x', sourcePath: 'empty.md' },
                    ],
                    read,
                )
            ).size,
        ).toBe(0);
        expect(
            (
                await loadRuleSourceReferences(
                    [{ uuid: 'r1', rule: 'x', sourcePath: 'x.md' }],
                    undefined,
                )
            ).size,
        ).toBe(0);
    });
});

describe('collectLoadedReferences', () => {
    const prRepository = { id: 'repo-1', name: 'repo' };

    it('maps each loaded file to a Context OS reference with its repository and range', () => {
        const index = collectLoadedReferences(
            new Map([
                [
                    'r1',
                    [
                        {
                            filePath: 'docs/a.md',
                            content: 'same repo',
                            repositoryId: 'repo-1',
                            repositoryName: 'repo',
                        },
                        {
                            filePath: 'docs/a.md',
                            content: 'other repo',
                            repositoryId: 'repo-2',
                            repositoryName: 'design-system',
                            lineRange: { start: 3, end: 9 },
                        },
                    ],
                ],
            ]),
            { prRepository },
        );

        expect(index.get('r1')).toEqual([
            {
                source: 'context-os',
                filePath: 'docs/a.md',
                content: 'same repo',
            },
            {
                source: 'context-os',
                filePath: 'docs/a.md',
                repository: 'design-system',
                repositoryId: 'repo-2',
                lineRange: { start: 3, end: 9 },
                content: 'other repo',
            },
        ]);
    });

    it('treats a repository named like the PR repository as the same repository', () => {
        const index = collectLoadedReferences(
            new Map([
                [
                    'r1',
                    [
                        {
                            filePath: 'a.md',
                            content: 'x',
                            repositoryName: 'owner/repo',
                        },
                    ],
                ],
            ]),
            { prRepository: { name: 'repo', fullName: 'owner/repo' } },
        );
        expect(index.get('r1')![0].repository).toBeUndefined();
    });

    it('treats a repository with another id as another repository, even when the names match', () => {
        const index = collectLoadedReferences(
            new Map([
                [
                    'r1',
                    [
                        {
                            filePath: 'a.md',
                            content: 'x',
                            repositoryId: 'repo-9',
                            repositoryName: 'repo',
                        },
                    ],
                ],
            ]),
            { prRepository },
        );
        expect(index.get('r1')![0]).toMatchObject({
            repository: 'repo',
            repositoryId: 'repo-9',
        });
    });

    it('keeps two rules on the same path in same-named repositories apart', () => {
        const index = collectLoadedReferences(
            new Map([
                [
                    'a',
                    [
                        {
                            filePath: 'docs/policy.md',
                            content: 'policy',
                            repositoryId: 'repo-1',
                            repositoryName: 'api',
                        },
                    ],
                ],
                [
                    'b',
                    [
                        {
                            filePath: 'docs/policy.md',
                            content: 'policy, and more',
                            repositoryId: 'repo-2',
                            repositoryName: 'api',
                        },
                    ],
                ],
            ]),
            { prRepository: { id: 'repo-1', name: 'api' } },
        );
        const section = buildReferenceSection(
            [
                { uuid: 'a', rule: 'a' },
                { uuid: 'b', rule: 'b' },
            ],
            index,
        );

        expect(section.idsByRule).toEqual([['R1'], ['R2']]);
        expect(section.stats.entries).toBe(2);
    });

    it('keeps two other repositories with one name apart by id', () => {
        const index = collectLoadedReferences(
            new Map([
                [
                    'a',
                    [
                        {
                            filePath: 'docs/policy.md',
                            content: 'policy',
                            repositoryId: 'repo-2',
                            repositoryName: 'api',
                        },
                    ],
                ],
                [
                    'b',
                    [
                        {
                            filePath: 'docs/policy.md',
                            content: 'policy, and more',
                            repositoryId: 'repo-3',
                            repositoryName: 'api',
                        },
                    ],
                ],
            ]),
            { prRepository: { id: 'repo-1', name: 'web' } },
        );
        const section = buildReferenceSection(
            [
                { uuid: 'a', rule: 'a' },
                { uuid: 'b', rule: 'b' },
            ],
            index,
        );

        expect(section.idsByRule).toEqual([['R1'], ['R2']]);
        expect(section.lines.join('\n')).toContain('policy, and more');
    });

    // The budget is per rule, across its files, and counts each file's
    // header as the inlined text always did.
    it('caps the total text per rule at maxRefChars across files, counting each file header', () => {
        const index = collectLoadedReferences(
            new Map([
                [
                    'r1',
                    [
                        { filePath: 'a.md', content: 'X'.repeat(100) },
                        { filePath: 'b.md', content: 'Y'.repeat(100) },
                    ],
                ],
            ]),
            { maxRefChars: 120 },
        );
        // a.md's header plus its 100 characters already pass 120, so b.md
        // gets nothing: the cut points of the text appended to rules before.
        expect(index.get('r1')!.map((r) => r.content)).toEqual([
            'X'.repeat(100),
        ]);
    });

    it('skips empty content and returns an empty index for an empty or absent map', () => {
        expect(
            collectLoadedReferences(
                new Map([['r1', [{ filePath: 'a.md', content: '  ' }]]]),
            ).size,
        ).toBe(0);
        expect(collectLoadedReferences(new Map()).size).toBe(0);
        expect(collectLoadedReferences(undefined).size).toBe(0);
    });

    it('logs what it collected, once per rule, with the review it belongs to', () => {
        const logger = { warn: jest.fn(), log: jest.fn() };
        collectLoadedReferences(
            new Map([['r1', [{ filePath: 'CLAUDE.md', content: 'c' }]]]),
            { logger, logMetadata: { prNumber: 7 } },
        );
        expect(logger.log).toHaveBeenCalledTimes(1);
        expect(logger.log.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                context: 'kody-rules-sharded',
                metadata: expect.objectContaining({
                    prNumber: 7,
                    ruleUuid: 'r1',
                    inlinedRefs: ['CLAUDE.md'],
                }),
            }),
        );
    });
});

describe('mergeRuleReferences', () => {
    it('puts the rule source file before the Context OS files of the same rule', () => {
        const merged = mergeRuleReferences(
            new Map([['r1', [sourceRef()]]]),
            new Map([
                ['r1', [contextRef()]],
                ['r2', [contextRef({ filePath: 'b.md' })]],
            ]),
        );
        expect(merged.get('r1')!.map((r) => r.source)).toEqual([
            'rule-source',
            'context-os',
        ]);
        expect(merged.get('r2')).toHaveLength(1);
    });
});

describe('buildReferenceSection', () => {
    it('prints nothing and links nothing when no rule has references', () => {
        const section = buildReferenceSection(
            [{ uuid: 'r1', rule: 'a' }],
            new Map(),
        );
        expect(section.lines).toEqual([]);
        expect(section.idsByRule).toEqual([[]]);
    });

    it('prints a file once for every unit of a rule that shares its uuid', () => {
        const atoms = Array.from({ length: 12 }, (_, i) => ({
            uuid: 'parent',
            rule: `spec ${i}`,
        }));
        const section = buildReferenceSection(
            atoms,
            new Map([['parent', [sourceRef(), contextRef()]]]),
        );
        const text = section.lines.join('\n');

        expect(text.split('the convention').length - 1).toBe(1);
        expect(text.split('context convention').length - 1).toBe(1);
        expect(section.idsByRule).toEqual(
            Array.from({ length: 12 }, () => ['R1', 'R2']),
        );
    });

    it('shares one entry between rules when one cut is a prefix of the other, keeping the longer', () => {
        const section = buildReferenceSection(
            [
                { uuid: 'a', rule: 'a' },
                { uuid: 'b', rule: 'b' },
            ],
            new Map([
                ['a', [sourceRef({ content: 'abc' })]],
                ['b', [sourceRef({ content: 'abcdef' })]],
            ]),
        );
        const text = section.lines.join('\n');

        expect(section.idsByRule).toEqual([['R1'], ['R1']]);
        expect(text).toContain('abcdef');
        expect(text).not.toMatch(/\[R2\]/);
    });

    it('keeps the same path from two repositories as two entries, naming the other repository', () => {
        const section = buildReferenceSection(
            [
                { uuid: 'a', rule: 'a' },
                { uuid: 'b', rule: 'b' },
            ],
            new Map([
                ['a', [contextRef({ content: 'ours' })]],
                [
                    'b',
                    [
                        contextRef({
                            content: 'theirs',
                            repository: 'design-system',
                        }),
                    ],
                ],
            ]),
        );
        const text = section.lines.join('\n');

        expect(section.idsByRule).toEqual([['R1'], ['R2']]);
        expect(text).toContain('ours');
        expect(text).toContain('theirs');
        expect(text).toContain('repository design-system');
    });

    it('never replaces one text with a conflicting one at the same path', () => {
        const section = buildReferenceSection(
            [
                { uuid: 'a', rule: 'a' },
                { uuid: 'b', rule: 'b' },
            ],
            new Map([
                ['a', [contextRef({ content: 'version one' })]],
                ['b', [contextRef({ content: 'version two' })]],
            ]),
        );
        const text = section.lines.join('\n');

        expect(section.idsByRule).toEqual([['R1'], ['R2']]);
        expect(text).toContain('version one');
        expect(text).toContain('version two');
    });

    it('keeps different line ranges of one file as separate entries', () => {
        const section = buildReferenceSection(
            [
                { uuid: 'a', rule: 'a' },
                { uuid: 'b', rule: 'b' },
            ],
            new Map([
                [
                    'a',
                    [
                        contextRef({
                            content: 'abc',
                            lineRange: { start: 1, end: 3 },
                        }),
                    ],
                ],
                [
                    'b',
                    [
                        contextRef({
                            content: 'abcdef',
                            lineRange: { start: 1, end: 9 },
                        }),
                    ],
                ],
            ]),
        );
        expect(section.idsByRule).toEqual([['R1'], ['R2']]);
        expect(section.lines.join('\n')).toContain('lines 1-9');
    });

    // The pull request edits the convention file: the rule source file is
    // read at the head, the Context OS copy at the base branch.
    it('keeps the head and base copies of one file apart, each labelled by source', () => {
        const section = buildReferenceSection(
            [{ uuid: 'r1', rule: 'r' }],
            new Map([
                [
                    'r1',
                    [
                        sourceRef({
                            filePath: 'CLAUDE.md',
                            content: 'edited in this PR',
                        }),
                        contextRef({
                            filePath: 'CLAUDE.md',
                            content: 'before this PR',
                        }),
                    ],
                ],
            ]),
        );
        const text = section.lines.join('\n');

        expect(section.idsByRule).toEqual([['R1', 'R2']]);
        expect(text).toMatch(
            /\[R1\] `CLAUDE\.md` \(the rule's source file, read at this pull request's head\)/,
        );
        expect(text).toMatch(
            /\[R2\] `CLAUDE\.md` \(referenced by the rule, read at the base branch\)/,
        );
        expect(text).toContain('edited in this PR');
        expect(text).toContain('before this PR');
    });

    it('wraps the entries in a References block', () => {
        const section = buildReferenceSection(
            [{ uuid: 'r1', rule: 'r' }],
            new Map([['r1', [sourceRef()]]]),
        );
        expect(section.lines[0]).toBe('<References>');
        expect(section.lines).toContain('</References>');
    });

    // Rules synced from one file each point at their own section of it: the
    // file is printed once, and each rule's link names its section.
    it('prints a file once for rules on different sections of it, naming each section on the link', () => {
        const section = buildReferenceSection(
            [
                { uuid: 'a', rule: 'a' },
                { uuid: 'b', rule: 'b' },
            ],
            new Map([
                ['a', [sourceRef({ anchor: 'Testing' })]],
                ['b', [sourceRef({ anchor: 'Logging' })]],
            ]),
        );
        const text = section.lines.join('\n');

        expect(section.idsByRule).toEqual([
            ['R1 (section: Testing)'],
            ['R1 (section: Logging)'],
        ]);
        expect(text.split('the convention').length - 1).toBe(1);
        expect(text).not.toContain('section:');
    });
});
