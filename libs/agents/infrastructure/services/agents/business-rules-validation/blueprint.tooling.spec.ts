import {
    classifyTaskQuality,
    classifyTaskQualityFromSources,
    resolvePullRequestDescription,
    resolveTaskContext,
} from './blueprint.tooling';
import type {
    BusinessRulesContext,
    TaskContextNormalized,
    TaskQuality,
} from './types';

// Minimal helper: build a context carrying only a prepareContext payload.
function ctxWithPrepare(
    prepareContext: Record<string, unknown> | undefined,
): BusinessRulesContext {
    return { prepareContext } as unknown as BusinessRulesContext;
}

describe('resolvePullRequestDescription', () => {
    it('returns the string description verbatim when present', () => {
        expect(
            resolvePullRequestDescription(
                ctxWithPrepare({ pullRequestDescription: 'Fixes the bug' }),
            ),
        ).toBe('Fixes the bug');
    });

    it('returns the empty string (not the default fallback path) when description is an empty string', () => {
        // Empty string is still a string, so the typeof branch returns it directly.
        expect(
            resolvePullRequestDescription(
                ctxWithPrepare({ pullRequestDescription: '' }),
            ),
        ).toBe('');
    });

    it('falls back to empty string when description is missing', () => {
        expect(resolvePullRequestDescription(ctxWithPrepare({}))).toBe('');
    });

    it('falls back to empty string when prepareContext is undefined', () => {
        expect(resolvePullRequestDescription(ctxWithPrepare(undefined))).toBe(
            '',
        );
    });

    it('falls back to empty string when description is a non-string value', () => {
        expect(
            resolvePullRequestDescription(
                ctxWithPrepare({ pullRequestDescription: 42 }),
            ),
        ).toBe('');
    });
});

describe('resolveTaskContext', () => {
    it('returns the string task context verbatim when present', () => {
        expect(
            resolveTaskContext(
                ctxWithPrepare({ taskContext: 'Ticket ABC-1 body' }),
            ),
        ).toBe('Ticket ABC-1 body');
    });

    it('falls back to empty string when task context is missing', () => {
        expect(resolveTaskContext(ctxWithPrepare({}))).toBe('');
    });

    it('falls back to empty string when prepareContext is undefined', () => {
        expect(resolveTaskContext(ctxWithPrepare(undefined))).toBe('');
    });

    it('falls back to empty string when task context is a non-string value', () => {
        expect(
            resolveTaskContext(ctxWithPrepare({ taskContext: { a: 1 } })),
        ).toBe('');
    });
});

describe('classifyTaskQuality (delegation to classifyTaskQualityFromSources)', () => {
    it('classifies an empty string as EMPTY', () => {
        expect(classifyTaskQuality('')).toBe('EMPTY');
    });

    it('classifies a rich section-based string as COMPLETE', () => {
        const text = 'Title: Login\nAcceptance Criteria:\n- user can log in';
        expect(classifyTaskQuality(text)).toBe('COMPLETE');
    });
});

describe('classifyTaskQualityFromSources — normalized task path', () => {
    function normalized(partial: Partial<TaskContextNormalized>): {
        taskContextNormalized: TaskContextNormalized;
    } {
        return { taskContextNormalized: partial as TaskContextNormalized };
    }

    it('returns EMPTY when title, description, and acceptance criteria are all blank', () => {
        expect(
            classifyTaskQualityFromSources(
                normalized({
                    title: '',
                    description: '',
                    acceptanceCriteria: [],
                }),
            ),
        ).toBe('EMPTY');
    });

    it('returns EMPTY for an empty normalized object (stays on normalized path)', () => {
        expect(classifyTaskQualityFromSources(normalized({}))).toBe('EMPTY');
    });

    it('treats whitespace-only fields as blank (EMPTY)', () => {
        expect(
            classifyTaskQualityFromSources(
                normalized({
                    title: '   ',
                    description: '\t\n',
                    acceptanceCriteria: ['  ', ''],
                }),
            ),
        ).toBe('EMPTY');
    });

    it('returns COMPLETE when acceptance criteria plus a title are present', () => {
        expect(
            classifyTaskQualityFromSources(
                normalized({
                    title: 'Add login',
                    acceptanceCriteria: ['User can log in with valid creds'],
                }),
            ),
        ).toBe('COMPLETE');
    });

    it('returns COMPLETE when acceptance criteria plus a description are present (no title)', () => {
        expect(
            classifyTaskQualityFromSources(
                normalized({
                    description: 'Some description',
                    acceptanceCriteria: ['User can log in'],
                }),
            ),
        ).toBe('COMPLETE');
    });

    it('returns MINIMAL when only acceptance criteria are present (no title, no description)', () => {
        expect(
            classifyTaskQualityFromSources(
                normalized({
                    acceptanceCriteria: ['A meaningful criterion here'],
                }),
            ),
        ).toBe('MINIMAL');
    });

    it('returns PARTIAL when title and description are present but no acceptance criteria', () => {
        expect(
            classifyTaskQualityFromSources(
                normalized({ title: 'T', description: 'short desc' }),
            ),
        ).toBe('PARTIAL');
    });

    it('returns PARTIAL over COMPLETE when acceptance criteria is an empty array', () => {
        // Empty array => .some(...) is false => not COMPLETE, falls to title&&description.
        expect(
            classifyTaskQualityFromSources(
                normalized({
                    title: 'T',
                    description: 'd',
                    acceptanceCriteria: [],
                }),
            ),
        ).toBe('PARTIAL');
    });

    it('returns PARTIAL when acceptance criteria contains only blank strings', () => {
        // Kills a mutation that replaces `.some(hasMeaningfulText)` with `.some(() => true)`.
        expect(
            classifyTaskQualityFromSources(
                normalized({
                    title: 'T',
                    description: 'd',
                    acceptanceCriteria: ['  ', ''],
                }),
            ),
        ).toBe('PARTIAL');
    });

    it('returns MINIMAL when only a title is present', () => {
        expect(
            classifyTaskQualityFromSources(normalized({ title: 'Only title' })),
        ).toBe('MINIMAL');
    });

    it('does not throw and returns MINIMAL when acceptanceCriteria is not an array (Array.isArray guard)', () => {
        expect(
            classifyTaskQualityFromSources(
                normalized({
                    title: 'Only title',
                    acceptanceCriteria: 'not-an-array' as unknown as string[],
                }),
            ),
        ).toBe('MINIMAL');
    });

    it('returns PARTIAL for a description-only task whose trimmed length is exactly 80', () => {
        const desc = '  ' + 'a'.repeat(80) + '  '; // trims to exactly 80
        expect(
            classifyTaskQualityFromSources(normalized({ description: desc })),
        ).toBe('PARTIAL');
    });

    it('returns MINIMAL for a description-only task whose trimmed length is 79 (boundary below 80)', () => {
        const desc = 'a'.repeat(79);
        expect(
            classifyTaskQualityFromSources(normalized({ description: desc })),
        ).toBe('MINIMAL');
    });
});

describe('classifyTaskQualityFromSources — raw string path', () => {
    function classify(taskContext: string | undefined): TaskQuality {
        return classifyTaskQualityFromSources({ taskContext });
    }

    it('returns EMPTY for an undefined task context (?? default)', () => {
        expect(classify(undefined)).toBe('EMPTY');
    });

    it('returns EMPTY for a whitespace-only task context (trimmed to empty)', () => {
        expect(classify('   \n\t ')).toBe('EMPTY');
    });

    it('returns COMPLETE for acceptance-criteria section plus a title section', () => {
        const text = 'Title: Login\nAcceptance Criteria:\n- user can log in';
        expect(classify(text)).toBe('COMPLETE');
    });

    it('matches the acceptance-criteria section case-insensitively', () => {
        const text = 'title: Login\nACCEPTANCE CRITERIA: something';
        expect(classify(text)).toBe('COMPLETE');
    });

    it('returns COMPLETE for two bullet-like requirements when total length is exactly 120', () => {
        const base = '- implement the login feature\n- write integration tests';
        const text = base + 'x'.repeat(120 - base.length);
        expect(text.length).toBe(120);
        expect(classify(text)).toBe('COMPLETE');
    });

    it('returns PARTIAL (not COMPLETE) for two bullets when total length is 119 (boundary below 120)', () => {
        const base = '- implement the login feature\n- write integration tests';
        const text = base + 'x'.repeat(119 - base.length);
        expect(text.length).toBe(119);
        // Two bullets satisfy the first half, but length 119 < 120 and no
        // title/description section => not COMPLETE; length >= 80 => PARTIAL.
        expect(classify(text)).toBe('PARTIAL');
    });

    it('returns PARTIAL (not COMPLETE) for a single bullet even when long (bulletCount >= 2 boundary)', () => {
        const base = '- implement the whole login feature end to end';
        const text = base + 'x'.repeat(140 - base.length);
        expect(text.length).toBe(140);
        // Only one bullet => first condition false => PARTIAL via length >= 80.
        expect(classify(text)).toBe('PARTIAL');
    });

    it('does not count checkbox-only bullets toward requirements', () => {
        // Two checkbox lines => 0 requirements => not COMPLETE despite two bullet lines.
        const text = 'short intro\n- [ ]\n- [x]';
        expect(classify(text)).toBe('MINIMAL');
    });

    it('does not count bullet lines shorter than the 10-char content minimum', () => {
        // Both bullets have < 10 chars of content => 0 requirements, short text => MINIMAL.
        const text = '- short\n- tiny';
        expect(classify(text)).toBe('MINIMAL');
    });

    it('returns PARTIAL for a description section without acceptance criteria', () => {
        expect(classify('Description: this implements the feature')).toBe(
            'PARTIAL',
        );
    });

    it('returns PARTIAL for plain prose whose length is exactly 80 (boundary)', () => {
        const text = 'a'.repeat(80);
        expect(text.length).toBe(80);
        expect(classify(text)).toBe('PARTIAL');
    });

    it('returns MINIMAL for plain prose whose length is 79 (boundary below 80)', () => {
        const text = 'a'.repeat(79);
        expect(text.length).toBe(79);
        expect(classify(text)).toBe('MINIMAL');
    });

    it('returns MINIMAL for short prose with no sections and no bullets', () => {
        expect(classify('just a quick note')).toBe('MINIMAL');
    });
});

describe('classifyTaskQualityFromSources — mutation-killing edge cases', () => {
    function classify(taskContext: string): TaskQuality {
        return classifyTaskQualityFromSources({ taskContext });
    }
    function normalized(partial: Partial<TaskContextNormalized>): {
        taskContextNormalized: TaskContextNormalized;
    } {
        return { taskContextNormalized: partial as TaskContextNormalized };
    }

    // ---- normalized path ----

    it('returns COMPLETE when title, description, and acceptance criteria are all present', () => {
        // Exercises the AC && (title || description) branch with every flag true.
        expect(
            classifyTaskQualityFromSources(
                normalized({
                    title: 'Add login',
                    description: 'Implements the login flow',
                    acceptanceCriteria: ['User can log in'],
                }),
            ),
        ).toBe('COMPLETE');
    });

    it('returns MINIMAL (not PARTIAL) for a description-only task whose trimmed length is exactly 79', () => {
        // Guards the >= 80 vs > 80 boundary precisely one below the threshold.
        const desc = 'a'.repeat(79);
        expect(desc.length).toBe(79);
        expect(
            classifyTaskQualityFromSources(normalized({ description: desc })),
        ).toBe('MINIMAL');
    });

    // ---- raw string path: the && joining the two COMPLETE halves ----

    it('returns MINIMAL for an acceptance-criteria section alone when text is short (first half true, second half false)', () => {
        // Kills a mutant that turns the `&&` between the two COMPLETE halves into `||`:
        // AC section satisfies the first half, but no title/description section and
        // length < 120 leaves the second half false => must NOT be COMPLETE.
        const text = 'Acceptance Criteria: do the login work';
        expect(text.length).toBeLessThan(120);
        expect(classify(text)).toBe('MINIMAL');
    });

    it('returns MINIMAL for a title section alone when text is short (second half true, first half false)', () => {
        // Kills the same `&&`->`||` mutant from the other direction: the title
        // section satisfies the second half, but no AC section and < 2 bullets
        // leaves the first half false => must NOT be COMPLETE.
        const text = 'Title: Login page';
        expect(text.length).toBeLessThan(120);
        expect(classify(text)).toBe('MINIMAL');
    });

    it('returns COMPLETE for an acceptance-criteria section plus a description section (short text)', () => {
        // Isolates the description-section branch of the second half (title absent,
        // length < 120) so a mutant dropping hasDescriptionSection is caught.
        const text =
            'Description: implements it\nAcceptance Criteria: user logs in';
        expect(text.length).toBeLessThan(120);
        expect(classify(text)).toBe('COMPLETE');
    });

    // ---- raw string path: bullet marker alternatives ----

    it('counts asterisk-prefixed bullets as requirements', () => {
        // Kills removal of the `*` alternative from the [-*] marker class.
        const base =
            '* implement the login feature\n* write the tests thoroughly';
        const text = base + 'x'.repeat(120 - base.length);
        expect(text.length).toBe(120);
        expect(classify(text)).toBe('COMPLETE');
    });

    it('counts numbered-list items as requirements', () => {
        // Kills removal of the `\d+\.\s+` alternative from the marker regex.
        const base =
            '1. implement the login feature\n2. write the tests thoroughly';
        const text = base + 'x'.repeat(120 - base.length);
        expect(text.length).toBe(120);
        expect(classify(text)).toBe('COMPLETE');
    });

    // ---- raw string path: the .{10,} content-length boundary ----

    it('counts bullets whose content is exactly 10 chars as requirements (>= 10 boundary)', () => {
        // Two bullets with exactly 10 content chars each => 2 requirements.
        // A title section satisfies the second half, so this is COMPLETE only if
        // the .{10,} bound counts 10 (a `{11,}` mutant would drop both to 0).
        const text = 'Title: X\n- 0123456789\n- abcdefghij';
        expect(classify(text)).toBe('COMPLETE');
    });

    it('does not count bullets whose content is 9 chars (below the 10-char minimum)', () => {
        // Two 9-char bullets must NOT count (a `{9,}` mutant would make them count
        // => COMPLETE). With no length >= 80 the correct result is MINIMAL.
        const text = 'Title: X\n- 012345678\n- 876543210';
        expect(classify(text)).toBe('MINIMAL');
    });
});
