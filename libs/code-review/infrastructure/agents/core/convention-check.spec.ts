/**
 * The deterministic quote gate for convention findings — zero LLM.
 * Fixture domain: an invented greenhouse-irrigation service and its team guide.
 */
import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import type { FinderSuggestion } from '@libs/code-review/infrastructure/agents/core/finder.agent';
import {
    AstGrepOutputLog,
    checkConventionQuotes,
    findQuoteSection,
    isLinkedGuide,
    isProvenByAstGrep,
    makeTargetBranchGuideLister,
    makeTargetBranchGuideReader,
    normalizeQuoteText,
    QUOTE_NOT_FOUND,
    recordAstGrepOutputs,
} from '@libs/code-review/infrastructure/agents/core/convention-check';

const GUIDE = 'docs/guides/valve-api.md';
const GUIDE_TEXT = `# Valve API guide

## Handlers

Every valve handler **must** log the zone id
before it opens a valve.

Handlers return \`ValveResult\`, never a bare boolean.

## Tests

Test helpers may skip logging.
`;

function conv(
    quote: string,
    over: Partial<FinderSuggestion> = {},
): FinderSuggestion {
    return {
        relevantFile: 'src/valves/open-valve.handler.ts',
        suggestionContent:
            'The handler opens the valve without logging the zone id.',
        existingCode: 'await valve.open();',
        improvedCode: 'logger.info({ zoneId }); await valve.open();',
        kind: 'convention',
        source: { file: GUIDE, section: 'Handlers', quote },
        ...over,
    };
}

const reader = (files: Record<string, string>) =>
    jest.fn(async (file: string) => files[file] ?? null);

describe('normalizeQuoteText', () => {
    it('collapses whitespace and drops markdown emphasis on both sides', () => {
        expect(normalizeQuoteText('must  **log**\n the `zone id`')).toBe(
            'must log the zone id',
        );
        expect(normalizeQuoteText('“quoted” it’s')).toBe('"quoted" it\'s');
    });
});

describe('findQuoteSection', () => {
    it('returns the heading section that holds a quote spanning a line break', () => {
        const section = findQuoteSection(
            GUIDE_TEXT,
            'Every valve handler must log the zone id before it opens a valve.',
        );
        expect(section).toContain('## Handlers');
        expect(section).toContain('ValveResult');
        expect(section).not.toContain('Test helpers');
    });

    it('returns null for a paraphrase', () => {
        expect(
            findQuoteSection(
                GUIDE_TEXT,
                'Handlers should always log the zone before opening.',
            ),
        ).toBeNull();
    });
});

describe('checkConventionQuotes in a skill with rule files', () => {
    const SKILL = '.claude/skills/valve-rules/SKILL.md';
    const RULE = '.claude/skills/valve-rules/rules/zones.md';
    const OTHER = '.claude/skills/pump-rules/rules/zones.md';
    const files = {
        [SKILL]:
            '# Valve rules\n\nRead the file under rules/ that matches the change.\n',
        [RULE]: '# Zones\n\n## Opening\n\nA valve opens only after its zone lock is held.\n',
        [OTHER]: '# Pumps\n\nA pump starts only after its circuit is armed.\n',
    };
    const list = jest.fn(async (dir: string) =>
        Object.keys(files).filter((f) => f.startsWith(`${dir}/`)),
    );

    it('finds a quote cited to SKILL.md in the skill file it came from', async () => {
        const r = await checkConventionQuotes(
            [
                conv('A valve opens only after its zone lock is held.', {
                    source: {
                        file: SKILL,
                        section: 'Opening',
                        quote: 'A valve opens only after its zone lock is held.',
                    },
                }),
            ],
            reader(files),
            [SKILL],
            list,
        );
        expect(r.rejected).toEqual([]);
        expect(r.passed[0].sectionText).toContain('## Opening');
        expect(r.passed[0].finding.source?.file).toBe(RULE);
        expect(list).toHaveBeenCalledWith('.claude/skills/valve-rules');
    });

    it('never takes a quote from another skill', async () => {
        const r = await checkConventionQuotes(
            [
                conv('A pump starts only after its circuit is armed.', {
                    source: {
                        file: SKILL,
                        section: 'Pumps',
                        quote: 'A pump starts only after its circuit is armed.',
                    },
                }),
            ],
            reader(files),
            [SKILL],
            list,
        );
        expect(r.passed).toEqual([]);
        expect(r.rejected[0].reason).toBe(QUOTE_NOT_FOUND);
    });

    it('does not look in files deeper than the references the skill serves', async () => {
        const DEEP = '.claude/skills/valve-rules/rules/archive/old.md';
        const deepFiles = {
            ...files,
            [DEEP]: '# Old\n\nA valve may open before its zone lock is held.\n',
        };
        const read = reader(deepFiles);
        const r = await checkConventionQuotes(
            [
                conv('A valve may open before its zone lock is held.', {
                    source: {
                        file: SKILL,
                        section: 'Old',
                        quote: 'A valve may open before its zone lock is held.',
                    },
                }),
            ],
            read,
            [SKILL],
            jest.fn(async () => Object.keys(deepFiles)),
        );
        expect(r.passed).toEqual([]);
        expect(read).not.toHaveBeenCalledWith(DEEP);
    });

    it('reads a bounded number of skill files when the quote is missing', async () => {
        const many: Record<string, string> = { [SKILL]: files[SKILL] };
        for (let i = 0; i < 100; i++) {
            many[`.claude/skills/valve-rules/rules/zone-${i}.md`] = '# Zone\n';
        }
        const read = reader(many);
        const r = await checkConventionQuotes(
            [
                conv('A valve opens only after its zone lock is held.', {
                    source: {
                        file: SKILL,
                        section: 'Opening',
                        quote: 'A valve opens only after its zone lock is held.',
                    },
                }),
            ],
            read,
            [SKILL],
            jest.fn(async () => Object.keys(many)),
        );
        expect(r.passed).toEqual([]);
        expect(read.mock.calls.length).toBeLessThanOrEqual(1 + 40);
    });

    it('keeps rejecting without a lister', async () => {
        const r = await checkConventionQuotes(
            [
                conv('A valve opens only after its zone lock is held.', {
                    source: {
                        file: SKILL,
                        section: 'Opening',
                        quote: 'A valve opens only after its zone lock is held.',
                    },
                }),
            ],
            reader(files),
            [SKILL],
        );
        expect(r.passed).toEqual([]);
    });
});

describe('checkConventionQuotes', () => {
    describe("a rule quoted from the agent's own instructions", () => {
        const INSTRUCTIONS =
            'Valve rules:\n- Every valve handler must log the zone id before it opens a valve.\n- Close valves in a finally block.';
        const fromInstructions = (quote: string) =>
            conv(quote, {
                source: { file: 'TeamInstructions', section: '', quote },
            });

        it('passes when the quote is in the instructions, with no guide file read', async () => {
            const read = reader({});
            const r = await checkConventionQuotes(
                [
                    fromInstructions(
                        'Every valve handler must log the zone id before it opens a valve.',
                    ),
                ],
                read,
                [GUIDE],
                undefined,
                INSTRUCTIONS,
            );
            expect(r.rejected).toEqual([]);
            expect(r.passed).toHaveLength(1);
            expect(r.passed[0].sectionText).toBe(INSTRUCTIONS);
            expect(read).not.toHaveBeenCalled();
        });

        it.each([
            'TeamInstructions',
            'Team instructions (Duplicate code CLI QA)',
            'instructions',
        ])('reads %s as the instructions', async (file) => {
            const quote =
                'Every valve handler must log the zone id before it opens a valve.';
            const r = await checkConventionQuotes(
                [conv(quote, { source: { file, section: '', quote } })],
                reader({}),
                [],
                undefined,
                INSTRUCTIONS,
            );
            expect(r.passed).toHaveLength(1);
        });

        it.each(['TeamInstructions.md', 'team-instructions/rules.md'])(
            'treats %s as a repository file, not the instructions',
            async (file) => {
                const quote = 'Every gate valve reports its pressure reading.';
                const r = await checkConventionQuotes(
                    [conv(quote, { source: { file, section: '', quote } })],
                    reader({ [file]: `# Rules\n\n${quote}\n` }),
                    [file],
                    undefined,
                    INSTRUCTIONS,
                );
                expect(r.rejected).toEqual([]);
                expect(r.passed[0].sectionText).toContain(quote);
            },
        );

        it('accepts the display-name form of the instructions', async () => {
            const quote = 'Close valves in a finally block.';
            const r = await checkConventionQuotes(
                [
                    conv(quote, {
                        source: {
                            file: 'Team instructions (Valve agent)',
                            section: '',
                            quote,
                        },
                    }),
                ],
                reader({}),
                [GUIDE],
                undefined,
                INSTRUCTIONS,
            );
            expect(r.rejected).toEqual([]);
        });

        it('drops a quote the instructions do not hold', async () => {
            const r = await checkConventionQuotes(
                [
                    fromInstructions(
                        'Valves must emit a metric on each opening.',
                    ),
                ],
                reader({}),
                [],
                undefined,
                INSTRUCTIONS,
            );
            expect(r.passed).toEqual([]);
            expect(r.rejected[0].detail).toContain(
                "quote not found in the agent's instructions",
            );
        });

        it('judges a convention finding with no source against the instructions', async () => {
            // The model marked the finding as a convention and cited nothing;
            // dropping it lost every finding of an instructions-only agent.
            const read = reader({});
            const r = await checkConventionQuotes(
                [conv('', { source: undefined })],
                read,
                [],
                undefined,
                INSTRUCTIONS,
            );
            expect(r.rejected).toEqual([]);
            expect(r.passed[0].sectionText).toBe(INSTRUCTIONS);
            expect(r.passed[0].finding.source?.file).toBe('TeamInstructions');
            expect(read).not.toHaveBeenCalled();
        });

        it('still drops a sourceless convention finding of an agent without instructions', async () => {
            const r = await checkConventionQuotes(
                [conv('', { source: undefined })],
                reader({}),
                [],
            );
            expect(r.passed).toEqual([]);
        });

        it('drops it when the agent has no instructions to quote', async () => {
            const r = await checkConventionQuotes(
                [
                    fromInstructions(
                        'Every valve handler must log the zone id before it opens a valve.',
                    ),
                ],
                reader({}),
                [],
            );
            expect(r.passed).toEqual([]);
        });
    });

    it('passes a verbatim quote (whitespace-normalized) with its section', async () => {
        const read = reader({ [GUIDE]: GUIDE_TEXT });
        const r = await checkConventionQuotes(
            [
                conv(
                    'Every valve handler must log the zone id before it opens a valve.',
                ),
            ],
            read,
            [GUIDE],
        );
        expect(r.rejected).toEqual([]);
        expect(r.passed).toHaveLength(1);
        expect(r.passed[0].sectionText).toContain('## Handlers');
        expect(read).toHaveBeenCalledWith(GUIDE);
    });

    it('drops an invented or paraphrased quote as quote-not-found', async () => {
        const r = await checkConventionQuotes(
            [conv('Valve handlers must emit a metric for each opening.')],
            reader({ [GUIDE]: GUIDE_TEXT }),
            [GUIDE],
        );
        expect(r.passed).toEqual([]);
        expect(r.rejected).toHaveLength(1);
        expect(r.rejected[0].reason).toBe(QUOTE_NOT_FOUND);
        expect(r.rejected[0].detail).toContain('quote not found');
    });

    it('drops a quote from a guide missing on the target branch', async () => {
        const r = await checkConventionQuotes(
            [
                conv(
                    'Every valve handler must log the zone id before it opens a valve.',
                ),
            ],
            reader({}),
            [GUIDE],
        );
        expect(r.rejected[0].detail).toContain(
            'not found on the target branch',
        );
    });

    it('drops a quote from a file that is not a linked guide', async () => {
        const r = await checkConventionQuotes(
            [
                conv(
                    'Every valve handler must log the zone id before it opens a valve.',
                    {
                        source: {
                            file: 'README.md',
                            quote: 'Every valve handler must log the zone id before it opens a valve.',
                        },
                    },
                ),
            ],
            reader({ 'README.md': GUIDE_TEXT }),
            [GUIDE],
        );
        expect(r.rejected[0].detail).toContain('not a guide linked');
    });

    it('accepts any file when no guide list is given', async () => {
        const r = await checkConventionQuotes(
            [
                conv('x', {
                    source: {
                        file: 'README.md',
                        quote: 'Handlers return ValveResult, never a bare boolean.',
                    },
                }),
            ],
            reader({ 'README.md': GUIDE_TEXT }),
        );
        expect(r.passed).toHaveLength(1);
    });

    it('drops a finding without a source or with a trivially short quote', async () => {
        const r = await checkConventionQuotes(
            [conv('x', { source: undefined }), conv('must log')],
            reader({ [GUIDE]: GUIDE_TEXT }),
            [GUIDE],
        );
        expect(r.passed).toEqual([]);
        expect(r.rejected.map((x) => x.detail)).toEqual([
            'convention finding without source file or quote',
            'quote too short to identify a rule',
        ]);
    });

    it('drops when the reader throws instead of crashing the review', async () => {
        const r = await checkConventionQuotes(
            [
                conv(
                    'Every valve handler must log the zone id before it opens a valve.',
                ),
            ],
            async () => {
                throw new Error('sandbox gone');
            },
            [GUIDE],
        );
        expect(r.rejected).toHaveLength(1);
    });

    it('drops a finding that cites an ast-grep rule (unproven by this run)', async () => {
        const r = await checkConventionQuotes(
            [
                conv('x', {
                    source: {
                        file: 'ast-grep:no-bare-boolean',
                        quote: 'no bare boolean return',
                    },
                }),
            ],
            reader({}),
        );
        expect(r.rejected[0].detail).toContain('ast-grep');
    });

    it('reads each guide once', async () => {
        const read = reader({ [GUIDE]: GUIDE_TEXT });
        await checkConventionQuotes(
            [
                conv(
                    'Every valve handler must log the zone id before it opens a valve.',
                ),
                conv('Handlers return ValveResult, never a bare boolean.'),
            ],
            read,
            [GUIDE],
        );
        expect(read).toHaveBeenCalledTimes(1);
    });
});

describe('isLinkedGuide', () => {
    it('accepts files beside a linked SKILL.md and under a linked directory', () => {
        expect(
            isLinkedGuide('skills/valves/reference/limits.md', [
                'skills/valves/SKILL.md',
            ]),
        ).toBe(true);
        expect(isLinkedGuide('docs/guides/a.md', ['docs/guides/'])).toBe(true);
        expect(isLinkedGuide('./docs/guides/valve-api.md', [GUIDE])).toBe(true);
        expect(
            isLinkedGuide('docs/other.md', [GUIDE, 'skills/valves/SKILL.md']),
        ).toBe(false);
    });
});

describe('ast-grep proof', () => {
    const finding = conv('x', {
        relevantFile: 'src/valves/close-valve.handler.ts',
        source: { file: 'ast-grep:no-bare-boolean', quote: 'no bare boolean' },
    });

    it('records only successful ast-grep outputs and leaves other tools alone', async () => {
        const readFile = {
            name: 'readFile',
            description: 'r',
            inputSchema: {},
            execute: jest.fn(async () => ({
                output: 'no-bare-boolean src/valves/close-valve.handler.ts',
            })),
        };
        const results = [
            { output: 'no-bare-boolean src/valves/close-valve.handler.ts:12' },
            {
                output: 'no-bare-boolean src/valves/open-valve.handler.ts:3',
                isError: true,
            },
        ];
        const astGrep = {
            name: 'astGrep',
            description: 'a',
            inputSchema: {},
            execute: jest.fn(async () => results.shift()!),
        };
        const log = new AstGrepOutputLog();
        const wrapped = recordAstGrepOutputs(
            new InMemoryToolRegistry([readFile, astGrep] as any),
            log,
        );

        expect(wrapped.get('readFile')).toBe(readFile);
        await wrapped.get('readFile')!.execute({}, { runId: 't' });
        await wrapped.get('astGrep')!.execute({}, { runId: 't' });
        await wrapped.get('astGrep')!.execute({}, { runId: 't' });
        expect(log.outputs).toEqual([
            'no-bare-boolean src/valves/close-valve.handler.ts:12',
        ]);
    });

    it('returns the registry unchanged when there is no ast-grep tool', () => {
        const registry = new InMemoryToolRegistry([]);
        expect(recordAstGrepOutputs(registry, new AstGrepOutputLog())).toBe(
            registry,
        );
    });

    // The astGrep tool's output: `file:line:column [rule] message`, then the text.
    const out = (...records: string[]) =>
        ['1 match for the rules:', ...records.flatMap((r) => [r, '  x'])].join(
            '\n',
        );

    it('is proven only when an ast-grep output matched the rule in the finding file', () => {
        expect(
            isProvenByAstGrep(finding, [
                out(
                    'src/valves/close-valve.handler.ts:12:5 [no-bare-boolean] Use ValveResult',
                ),
            ]),
        ).toBe(true);
        expect(
            isProvenByAstGrep(finding, [
                out('src/valves/open-valve.handler.ts:3:1 [no-bare-boolean]'),
            ]),
        ).toBe(false);
        expect(
            isProvenByAstGrep(finding, [
                out('src/valves/close-valve.handler.ts:12:5 [other-rule]'),
            ]),
        ).toBe(false);
        expect(isProvenByAstGrep(finding, [])).toBe(false);
        // A quoted guide finding is never "proven" by ast-grep output.
        expect(
            isProvenByAstGrep(conv('Every valve handler must log'), [
                'anything',
            ]),
        ).toBe(false);
    });

    it('needs the rule, the exact file and the line in the same match', () => {
        // Rule matched in one file, the finding's file listed in another record.
        expect(
            isProvenByAstGrep(finding, [
                out(
                    'src/valves/open-valve.handler.ts:3:1 [no-bare-boolean]',
                    'src/valves/close-valve.handler.ts:12:5 [other-rule]',
                ),
            ]),
        ).toBe(false);
        // A longer path or rule id that contains the finding's.
        expect(
            isProvenByAstGrep(finding, [
                out(
                    'legacy/src/valves/close-valve.handler.ts:12:5 [no-bare-boolean]',
                ),
            ]),
        ).toBe(false);
        expect(
            isProvenByAstGrep(finding, [
                out(
                    'src/valves/close-valve.handler.ts:12:5 [no-bare-boolean-v2]',
                ),
            ]),
        ).toBe(false);
        // A match elsewhere in the file does not prove the reported lines.
        const onLines = {
            ...finding,
            relevantLinesStart: 40,
            relevantLinesEnd: 42,
        };
        expect(
            isProvenByAstGrep(onLines, [
                out('src/valves/close-valve.handler.ts:12:5 [no-bare-boolean]'),
            ]),
        ).toBe(false);
        expect(
            isProvenByAstGrep(onLines, [
                out('src/valves/close-valve.handler.ts:41:5 [no-bare-boolean]'),
            ]),
        ).toBe(true);
    });

    it('accepts the sgconfig marker form', () => {
        const f = conv('x', {
            relevantFile: 'src/a.ts',
            source: { file: 'sgconfig.yml#no-bare-boolean', quote: 'q' },
        });
        expect(
            isProvenByAstGrep(f, [out('src/a.ts:1:1 [no-bare-boolean]')]),
        ).toBe(true);
    });
});

describe('makeTargetBranchGuideReader', () => {
    it('reads from origin/<base>, never the PR head, and quotes the path', async () => {
        const exec = jest.fn(async () => ({
            stdout: GUIDE_TEXT,
            stderr: '',
            exitCode: 0,
        }));
        const read = makeTargetBranchGuideReader(
            {
                exec,
                grep: jest.fn(),
                read: jest.fn(),
                listDir: jest.fn(),
            } as any,
            'main',
        )!;
        expect(await read(GUIDE)).toBe(GUIDE_TEXT);
        expect(exec).toHaveBeenCalledWith(
            `git show 'refs/remotes/origin/main:${GUIDE}'`,
        );

        await read("docs/it's.md");
        expect(exec).toHaveBeenLastCalledWith(
            `git show 'refs/remotes/origin/main:docs/it'\\''s.md'`,
        );
    });

    it('reads the base guide even when a tag named like the base ref points at the head', async () => {
        // A fetch auto-follows tags, and `origin/main` resolves a tag
        // `refs/tags/origin/main` before the remote-tracking branch.
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-tag-'));
        const git = (...args: string[]) =>
            execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
        try {
            git('init', '-q', '-b', 'main');
            git('config', 'user.email', 'dev@example.test');
            git('config', 'user.name', 'Dev');
            git('config', 'commit.gpgsign', 'false');
            fs.mkdirSync(path.join(repo, 'docs'));
            fs.writeFileSync(path.join(repo, 'docs/guide.md'), 'BASE RULE');
            git('add', '-A');
            git('commit', '-q', '-m', 'base');
            git('update-ref', 'refs/remotes/origin/main', 'HEAD');
            git('checkout', '-q', '-b', 'feature');
            fs.writeFileSync(path.join(repo, 'docs/guide.md'), 'HEAD RULE');
            git('commit', '-q', '-am', 'head');
            git('tag', 'origin/main', 'feature');

            const exec = async (command: string) => {
                try {
                    const stdout = execSync(command, {
                        cwd: repo,
                        shell: '/bin/sh',
                        stdio: 'pipe',
                    }).toString();
                    return { stdout, stderr: '', exitCode: 0 };
                } catch (error: any) {
                    return {
                        stdout: '',
                        stderr: String(error.stderr ?? ''),
                        exitCode: error.status ?? 1,
                    };
                }
            };
            const read = makeTargetBranchGuideReader({ exec } as any, 'main')!;

            expect(await read('docs/guide.md')).toBe('BASE RULE');
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    it('returns null when git fails or the path escapes', async () => {
        const exec = jest.fn(async () => ({
            stdout: '',
            stderr: 'fatal',
            exitCode: 128,
        }));
        const read = makeTargetBranchGuideReader({ exec } as any, 'main')!;
        expect(await read(GUIDE)).toBeNull();
        expect(await read('../secrets.md')).toBeNull();
        expect(exec).toHaveBeenCalledTimes(1);
    });

    it('is undefined without exec or base branch', () => {
        expect(makeTargetBranchGuideReader(undefined, 'main')).toBeUndefined();
        expect(
            makeTargetBranchGuideReader({ exec: jest.fn() } as any, undefined),
        ).toBeUndefined();
    });
});

describe('makeTargetBranchGuideLister', () => {
    it('lists a skill directory on origin/<base>, not files only on the PR head', async () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-list-'));
        const git = (...args: string[]) =>
            execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
        try {
            git('init', '-q', '-b', 'main');
            git('config', 'user.email', 'dev@example.test');
            git('config', 'user.name', 'Dev');
            git('config', 'commit.gpgsign', 'false');
            const skill = path.join(repo, '.claude/skills/valve-rules');
            fs.mkdirSync(path.join(skill, 'rules'), { recursive: true });
            fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Valve rules');
            fs.writeFileSync(path.join(skill, 'rules/zones.md'), '# Zones');
            fs.writeFileSync(path.join(skill, 'rules/sécurité.md'), '# Sûreté');
            git('add', '-A');
            git('commit', '-q', '-m', 'base');
            git('update-ref', 'refs/remotes/origin/main', 'HEAD');
            git('checkout', '-q', '-b', 'feature');
            fs.writeFileSync(path.join(skill, 'rules/head-only.md'), '# New');
            git('add', '-A');
            git('commit', '-q', '-m', 'head');

            const exec = async (command: string) => {
                try {
                    const stdout = execSync(command, {
                        cwd: repo,
                        shell: '/bin/sh',
                        stdio: 'pipe',
                    }).toString();
                    return { stdout, stderr: '', exitCode: 0 };
                } catch (error: any) {
                    return {
                        stdout: '',
                        stderr: String(error.stderr ?? ''),
                        exitCode: error.status ?? 1,
                    };
                }
            };
            const list = makeTargetBranchGuideLister({ exec } as any, 'main')!;

            expect((await list('.claude/skills/valve-rules')).sort()).toEqual([
                '.claude/skills/valve-rules/SKILL.md',
                '.claude/skills/valve-rules/rules/sécurité.md',
                '.claude/skills/valve-rules/rules/zones.md',
            ]);
            expect(await list('../etc')).toEqual([]);
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    it('is undefined without exec or base branch', () => {
        expect(makeTargetBranchGuideLister(undefined, 'main')).toBeUndefined();
    });
});
