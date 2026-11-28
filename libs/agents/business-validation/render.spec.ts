import type { BusinessValidationOutcome } from './business-validation.types';
import { renderCliText, renderComment } from './render';

type Validated = Extract<BusinessValidationOutcome, { kind: 'validated' }>;

const outcome = (
    overrides: Partial<Validated['checks'][number]> = {},
): Validated => ({
    kind: 'validated',
    checks: [
        {
            task: {
                tracker: 'Azure DevOps',
                id: 'AB#8',
                title: 'Compact density toggle',
                url: 'https://dev.azure.com/acme/_workitems/edit/8',
            },
            verdict: {
                needsMoreInfo: false,
                summary: '',
                requirements: [
                    {
                        requirement: 'Persists per user',
                        source: 'AC #1',
                        state: 'met',
                        evidence: [{ file: 'settings/density.ts', line: 14 }],
                        confidence: 'high',
                    },
                    {
                        requirement: 'Defaults to comfortable',
                        state: 'missing',
                        evidence: [{ file: 'density.ts', line: 6 }],
                        note: 'Sets "compact" as the default.',
                        action: 'Change it to "comfortable".',
                        confidence: 'high',
                    },
                    {
                        requirement: 'Toggle visible | in the toolbar',
                        state: 'check_manually',
                        evidence: [],
                        confidence: 'medium',
                        downgraded: 'visual',
                    },
                ],
                outOfScope: [
                    {
                        change: 'Changes list pagination size',
                        evidence: [{ file: 'TicketList.tsx', line: 88 }],
                    },
                ],
            },
            passed: false,
            readAt: '2026-10-05T12:00:00.000Z',
            ...overrides,
        },
    ],
    thinTasks: [],
    passed: false,
    unseenFiles: [],
});

describe('renderComment', () => {
    it('lists every requirement with its state, evidence and the action', () => {
        const body = renderComment(outcome(), {
            headSha: 'a41c9e2ff',
            trigger: 'command',
        });

        expect(body).toContain(
            '[AB#8 · Compact density toggle](https://dev.azure.com/acme/_workitems/edit/8)',
        );
        expect(body).toContain(
            'To fix: 1 missing requirement · also open: 1 to check manually · 1 change not in the task',
        );
        expect(body).toContain(
            '✅ **MET** | Persists per user <sub>AC01</sub> | `settings/density.ts:14`',
        );
        expect(body).toContain('**Do:** Change it to "comfortable".');
        expect(body).toContain(
            '➕ **NOT IN TASK** | Changes list pagination size',
        );
        expect(body).toContain('re-checked on request at `a41c9e2`');
        // A pipe in a requirement would break the table.
        expect(body).toContain('Toggle visible \\| in the toolbar');
        // A backslash before a pipe must not undo its escape.
        const tricky = renderComment(
            outcome({
                verdict: {
                    needsMoreInfo: false,
                    summary: '',
                    requirements: [
                        {
                            requirement: 'Path C:\\temp\\| ends here',
                            state: 'missing',
                            evidence: [],
                            confidence: 'high',
                        },
                    ],
                    outOfScope: [],
                },
            }),
        );
        expect(tricky).toContain('Path C:\\\\temp\\\\\\| ends here');
    });

    it('says when the PR only delivers part of the task', () => {
        const body = renderComment(
            outcome({
                reference: {
                    kind: 'work_item',
                    id: '8',
                    raw: 'AB#8',
                    source: 'body',
                    intent: 'part_of',
                },
                passed: true,
            }),
        );
        expect(body).toContain('part of AB#8');
    });

    it('shows an accepted requirement with who accepted it and where it went', () => {
        const accepted = outcome();
        accepted.checks[0].verdict.requirements![1].accepted = {
            by: 'nina',
            movedTo: 'SAA-102',
            at: '2026-10-05T12:00:00.000Z',
        };
        expect(renderComment(accepted)).toContain(
            '☑️ **MISSING · ACCEPTED** | Defaults to comfortable | Accepted by @nina · moved to SAA-102',
        );
    });
});

// QA of #2681: the comment never said which files of the PR were not read.
describe('files too large to read', () => {
    it('names them, five at most', () => {
        const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
        const body = renderComment({ ...outcome(), unseenFiles: files });
        expect(body).toContain(
            'Too large to read with the rest of this PR: `a.ts`, `b.ts`, `c.ts`, `d.ts`, `e.ts` and 2 more.',
        );
    });

    it('names five without a count of more', () => {
        const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
        expect(renderComment({ ...outcome(), unseenFiles: files })).toContain(
            '`e.ts`.</sub>\n\n<sub>Disagree',
        );
    });

    it('says nothing when every file was read, or a run kept no list', () => {
        for (const unseenFiles of [[], undefined as unknown as string[]]) {
            const lines = renderComment({ ...outcome(), unseenFiles }).split(
                '\n',
            );
            expect(lines.join('\n')).not.toContain('Too large to read');
            // The task section, a blank line, then the footer.
            expect(lines.at(-2)).toBe('');
            expect(lines.at(-1)).toMatch(/^<sub>Disagree/);
        }
    });

    it('names the rest of a diff with no file headers as it is', () => {
        expect(
            renderComment({
                ...outcome(),
                unseenFiles: ['(rest of the diff)'],
            }),
        ).toContain('this PR: (rest of the diff).');
    });
});

describe('the trail of earlier commits', () => {
    it('shows how the PR got here, with the commit this check read', () => {
        const comment = renderComment(outcome(), {
            headSha: 'ccc3333ffff',
            trigger: 'push',
            history: [
                { headSha: 'aaa1111ffff', met: 1, total: 3, passed: false },
                { headSha: 'bbb2222ffff', met: 2, total: 3, passed: false },
            ],
        });
        expect(comment).toContain('re-checked after the push of `ccc3333`');
        expect(comment).toContain(
            'Earlier checks: `aaa1111` 1/3 met ✗ → `bbb2222` 2/3 met ✗',
        );
    });

    it('keeps the line short on a long-lived PR and leaves it out on the first check', () => {
        const history = Array.from({ length: 8 }, (_, i) => ({
            headSha: `${i}`.repeat(7),
            met: i,
            total: 8,
        }));
        const comment = renderComment(outcome(), { history });
        expect(comment).not.toContain('`2222222`');
        expect(comment).toContain('`3333333` 3/8 met → ');
        expect(renderComment(outcome())).not.toContain('Earlier checks');
    });
});

describe('AC sources are labels, not issue or PR numbers', () => {
    it('renders legacy AC sources safely in comments, CLI and met summaries', () => {
        for (const [source, expected] of [
            ['AC #1', 'AC01'],
            ['AC #02', 'AC02'],
            ['AC#10', 'AC10'],
            ['AC #123', 'AC123'],
        ]) {
            const sample = outcome();
            sample.checks[0].verdict.requirements![0].source = source;
            const comment = renderComment(sample);
            expect(comment).toContain(`<sub>${expected}</sub>`);
            expect(comment).not.toContain(`<sub>${source}</sub>`);
            expect(renderCliText(sample)).toContain(
                `${expected} Persists per user`,
            );

            const met = outcome({ passed: true });
            met.passed = true;
            met.checks[0].verdict.requirements = [
                { ...met.checks[0].verdict.requirements![0], source },
            ];
            met.checks[0].verdict.outOfScope = [];
            expect(renderComment(met)).toContain(`met: ${expected}`);
        }
    });

    it('does not rewrite unrelated labels or actual tracker references', () => {
        for (const source of ['Description', 'Parent', 'AB#8', 'AC #2 extra']) {
            const sample = outcome();
            sample.checks[0].verdict.requirements![0].source = source;
            expect(renderComment(sample)).toContain(`<sub>${source}</sub>`);
            expect(renderCliText(sample)).toContain(
                `${source} Persists per user`,
            );
        }
    });
});

describe('renderCliText', () => {
    it('prints one line per requirement for an agent to act on (UC-41)', () => {
        const text = renderCliText(outcome());
        expect(text).toContain(
            'MISSING        Defaults to comfortable density.ts:6',
        );
        expect(text).toContain('→ Change it to "comfortable".');
        expect(text).toContain('status: issues_found');
    });
});

describe('a met task', () => {
    it('says it in one line and lists only what to check by hand', () => {
        const met = outcome({ passed: true });
        met.passed = true;
        const reqs = met.checks[0].verdict.requirements!;
        met.checks[0].verdict.requirements = reqs.filter(
            (r) => r.state !== 'missing',
        );
        met.checks[0].verdict.outOfScope = [];
        const comment = renderComment(met);
        expect(comment).toContain('✅ 1 of 2 met: AC01');
        expect(comment).not.toContain('Persists per user');
        expect(comment).toContain('CHECK MANUALLY');
    });

    it('names a met parent requirement by its words, not "Parent"', () => {
        const met = outcome({ passed: true });
        met.passed = true;
        const reqs = met.checks[0].verdict.requirements!;
        met.checks[0].verdict.requirements = reqs
            .filter((r) => r.state !== 'missing')
            .map((r) => (r.state === 'met' ? { ...r, source: 'Parent' } : r));
        met.checks[0].verdict.outOfScope = [];
        const comment = renderComment(met);
        const metReq = reqs.find((r) => r.state === 'met')!.requirement;
        expect(comment).toContain(`✅ 1 of 2 met: ${metReq.slice(0, 40)}`);
        expect(comment).not.toContain('met: Parent');
    });
});

describe('the met summary names each row once', () => {
    it('names two rows by their own words when their labels read the same (AC #1 and AC01)', () => {
        const met = outcome({ passed: true });
        met.passed = true;
        const [first] = met.checks[0].verdict.requirements!;
        met.checks[0].verdict.requirements = [
            {
                ...first,
                state: 'met',
                source: 'AC #1',
                requirement: 'Persists per user',
            },
            {
                ...first,
                state: 'met',
                source: 'AC01',
                requirement: 'Defaults to comfortable',
            },
        ];
        met.checks[0].verdict.outOfScope = [];
        const comment = renderComment(met);
        expect(comment).not.toContain('AC01, AC01');
        expect(comment).toContain('Persists per user');
        expect(comment).toContain('Defaults to comfortable');
    });
});

describe('one criterion, however the model spells it', () => {
    it('reads AC1, AC-1, AC #1 and AC01 as the same criterion, AC01', () => {
        for (const source of ['AC1', 'AC-1', 'AC #1', 'ac#01', 'AC01']) {
            const sample = outcome();
            sample.checks[0].verdict.requirements![0].source = source;
            expect(renderComment(sample)).toContain('<sub>AC01</sub>');
        }
    });

    it('reads a long run of zeros that is no criterion without stalling', () => {
        const sample = outcome();
        // The model writes `source` freely: `AC` + 30k zeros + `x` took 5.9s
        // under the old `0*(\\d+)` pattern, 0ms now.
        const source = `AC${'0'.repeat(30_000)}x`;
        sample.checks[0].verdict.requirements![0].source = source;
        const started = Date.now();
        expect(renderComment(sample)).toContain(source);
        expect(Date.now() - started).toBeLessThan(1_000);
        sample.checks[0].verdict.requirements![0].source = 'AC007';
        expect(renderComment(sample)).toContain('<sub>AC07</sub>');
    });

    it('names two met rows apart when their words share a long beginning', () => {
        const met = outcome({ passed: true });
        met.passed = true;
        const [first] = met.checks[0].verdict.requirements!;
        const given =
            'Given a signed-in user on the account settings page, when they ';
        met.checks[0].verdict.requirements = [
            {
                ...first,
                state: 'met',
                source: 'AC1',
                requirement: `${given}save, the name is stored`,
            },
            {
                ...first,
                state: 'met',
                source: 'AC01',
                requirement: `${given}cancel, nothing changes`,
            },
        ];
        met.checks[0].verdict.outOfScope = [];
        const summary = renderComment(met)
            .split('\n')
            .find((line) => line.includes(' met: '))!;
        expect(
            summary.split('Given a signed-in user').length - 1,
        ).toBeLessThanOrEqual(1);
        expect(summary).toContain('save');
        expect(summary).toContain('cancel');
    });

    it('names three met rows apart when two of them differ only late', () => {
        const met = outcome({ passed: true });
        met.passed = true;
        const [first] = met.checks[0].verdict.requirements!;
        const page =
            'Given a signed-in user on the account settings page when they ';
        const save = `${page}save their profile after validating the submitted fields then the `;
        met.checks[0].verdict.requirements = [
            `${save}display name is persisted`,
            `${save}timezone is persisted`,
            `${page}cancel the edit then no changes are persisted`,
        ].map((requirement) => ({
            ...first,
            state: 'met' as const,
            source: 'Parent',
            requirement,
        }));
        met.checks[0].verdict.outOfScope = [];
        const summary = renderComment(met)
            .split('\n')
            .find((line) => line.includes(' met: '))!;
        const names = summary
            .slice(summary.indexOf(' met: ') + 6)
            .split(/, (?=…)/);
        expect(names).toHaveLength(3);
        expect(new Set(names).size).toBe(3);
    });
});
