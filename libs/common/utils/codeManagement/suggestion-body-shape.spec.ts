import {
    splitSentences,
    shapeSuggestionBody,
    shapeSuggestionBodyWithReport,
} from './suggestion-body-shape';

describe('shapeSuggestionBody', () => {
    it('removes fenced code from the body', () => {
        expect(
            shapeSuggestionBody({
                body: 'Reading name throws.\n\n```ts\nuser?.name\n```\n\nGuard it.',
                title: 'User can be null',
                capSentences: true,
            }),
        ).toBe('Reading name throws. Guard it.');
    });

    it('keeps inline code', () => {
        expect(
            shapeSuggestionBody({
                body: 'Reading `user.name` throws. Use `user?.name`.',
                title: 'User can be null',
                capSentences: true,
            }),
        ).toBe('Reading `user.name` throws. Use `user?.name`.');
    });

    it('drops a leading sentence that restates the title', () => {
        expect(
            shapeSuggestionBody({
                body: 'The user can be null when the account was deleted. Reading name throws a 500. Guard it.',
                title: 'User can be null when the account was deleted',
                capSentences: true,
            }),
        ).toBe('Reading name throws a 500. Guard it.');
    });

    it('keeps the only sentence even when it restates the title', () => {
        expect(
            shapeSuggestionBody({
                body: 'The user can be null when the account was deleted.',
                title: 'User can be null when the account was deleted',
                capSentences: true,
            }),
        ).toBe('The user can be null when the account was deleted.');
    });

    it('cuts the body to two sentences when asked', () => {
        expect(
            shapeSuggestionBody({
                body: 'Reading name throws. The request fails. Guard it. Add a test.',
                title: 'User can be null',
                capSentences: true,
            }),
        ).toBe('Reading name throws. The request fails.');
    });

    it('leaves length alone for teams with their own guidelines', () => {
        expect(
            shapeSuggestionBody({
                body: 'Reading name throws. The request fails. Guard it. Add a test.',
                title: 'User can be null',
                capSentences: false,
            }),
        ).toBe('Reading name throws. The request fails. Guard it. Add a test.');
    });

    it('does not split on a dot inside inline code or a file name', () => {
        expect(
            shapeSuggestionBody({
                body: '`config.retries` is ignored in client.ts. Use ?? instead. Add a test.',
                title: 'Zero falls through to the default',
                capSentences: true,
            }),
        ).toBe('`config.retries` is ignored in client.ts. Use ?? instead.');
    });

    it('does not end a sentence at e.g. or i.e. before inline code', () => {
        // Seen on 11 of 112 sent bodies: the cap cut "e.g. `fix`" after the
        // "e.g.", so the comment ended in a dangling lead-in.
        expect(
            shapeSuggestionBody({
                body: 'A negative offset turns into a 500. Clamp it the same way, e.g. `max(0, cursor.offset)`. Add a test.',
                title: 'Negative cursor offset is not clamped',
                capSentences: true,
            }),
        ).toBe(
            'A negative offset turns into a 500. Clamp it the same way, e.g. `max(0, cursor.offset)`.',
        );
        expect(
            shapeSuggestionBody({
                body: 'The flag is read twice. Read it once, i.e. `const on = isEnabled()`.',
                title: 'Feature check repeated per request',
                capSentences: true,
            }),
        ).toBe(
            'The flag is read twice. Read it once, i.e. `const on = isEnabled()`.',
        );
    });

    it('does not end a sentence at e.g. before a capital letter or a number', () => {
        expect(
            shapeSuggestionBody({
                body: 'The non-FIPS provider can win the tie. Give the providers distinct orders (e.g. FIPS 300, default 200) or fail loudly.',
                title: 'Providers share the top order',
                capSentences: true,
            }),
        ).toBe(
            'The non-FIPS provider can win the tie. Give the providers distinct orders (e.g. FIPS 300, default 200) or fail loudly.',
        );
    });

    it('returns the original when shaping would leave nothing', () => {
        expect(
            shapeSuggestionBody({
                body: '```ts\nuser?.name\n```',
                title: 'User can be null',
                capSentences: true,
            }),
        ).toBe('```ts\nuser?.name\n```');
    });
});

describe('shapeSuggestionBodyWithReport', () => {
    it('reports what it changed, for logging', () => {
        expect(
            shapeSuggestionBodyWithReport({
                body: 'The user can be null when the account was deleted. Reading name throws.\n\n```ts\nuser?.name\n```\n\nGuard it. Add a test.',
                title: 'User can be null when the account was deleted',
                capSentences: true,
            }),
        ).toEqual({
            body: 'Reading name throws. Guard it.',
            removedFences: true,
            droppedTitleRepeat: true,
            capped: true,
        });
    });

    it('reports nothing changed for a body already in shape', () => {
        expect(
            shapeSuggestionBodyWithReport({
                body: 'Reading name throws. Guard it.',
                title: 'User can be null',
                capSentences: true,
            }),
        ).toEqual({
            body: 'Reading name throws. Guard it.',
            removedFences: false,
            droppedTitleRepeat: false,
            capped: false,
        });
    });
});

describe('splitSentences', () => {
    it.each<[string, string, string[]]>([
        ['plain sentences', 'A is null. B throws.', ['A is null.', 'B throws.']],
        ['question and exclamation', 'Why does it fail? Because x is null! Guard it.', ['Why does it fail?', 'Because x is null!', 'Guard it.']],
        ['repeated punctuation', 'It fails!! Is it null?! Guard it.', ['It fails!!', 'Is it null?!', 'Guard it.']],
        ['no punctuation at all', 'no punctuation here', ['no punctuation here']],
        ['line breaks are spaces', 'Line one\nstill line one.', ['Line one still line one.']],
        ['abbreviation at the very end', 'Use a cache, e.g.', ['Use a cache, e.g.']],
        // Sentences that start lower case: the WHAT/WHY/HOW fallback keeps the
        // model's casing, and missing these makes the 2-sentence cap a no-op.
        ['lower-case sentence starts', 'a is null. b throws. add a guard.', ['a is null.', 'b throws.', 'add a guard.']],
        ['lower-case start after inline code', 'Read `config.retries`. it is ignored.', ['Read `config.retries`.', 'it is ignored.']],
        ['lower-case command after a sentence', 'Set the flag. npm then rebuilds it.', ['Set the flag.', 'npm then rebuilds it.']],
        // Abbreviations never end a sentence, whatever follows.
        ['e.g. before inline code', 'Guard it, e.g. `if (!x) return`. Then test.', ['Guard it, e.g. `if (!x) return`.', 'Then test.']],
        ['e.g. before a capital', 'Use a wrapper (e.g. Optional) instead. Done.', ['Use a wrapper (e.g. Optional) instead.', 'Done.']],
        ['e.g. before a lower-case word', 'Use a guard, e.g. this one. Done.', ['Use a guard, e.g. this one.', 'Done.']],
        ['e.g. with a trailing comma', 'Use a guard, e.g., a null check. Done.', ['Use a guard, e.g., a null check.', 'Done.']],
        ['i.e. before a lower-case word', 'Prefer composition, i.e. wrap the client. Then retry.', ['Prefer composition, i.e. wrap the client.', 'Then retry.']],
        ['upper-case E.G.', 'Use a guard, E.G. `x ?? 0`. Done.', ['Use a guard, E.G. `x ?? 0`.', 'Done.']],
        ['vs.', 'Compare Map vs. Set here. Then measure.', ['Compare Map vs. Set here.', 'Then measure.']],
        ['cf.', 'See cf. RFC 7231 for details. Retry.', ['See cf. RFC 7231 for details.', 'Retry.']],
        ['approx. before a number', 'It takes approx. 5 ms per call. Cache it.', ['It takes approx. 5 ms per call.', 'Cache it.']],
        ['incl. and esp.', 'All callers, incl. the worker, esp. on retry. Fix them.', ['All callers, incl. the worker, esp. on retry.', 'Fix them.']],
        ['et al.', 'Smith et al. in 2020 showed it. Cite it.', ['Smith et al. in 2020 showed it.', 'Cite it.']],
        ['w.r.t. and a.k.a.', 'Retries w.r.t. the timeout, a.k.a. the budget, are wrong. Fix.', ['Retries w.r.t. the timeout, a.k.a. the budget, are wrong.', 'Fix.']],
        // Ambiguous forms: keep them whole when a lower-case word follows,
        // split when a capital does.
        ['etc. mid-sentence', 'Handles strings, numbers, etc. and falls back to null. Fix it.', ['Handles strings, numbers, etc. and falls back to null.', 'Fix it.']],
        ['etc. ending a sentence', 'Handles strings, numbers, etc. The fallback is null.', ['Handles strings, numbers, etc.', 'The fallback is null.']],
        ['ellipsis mid-sentence', 'Wait... then it fails. Fix it.', ['Wait... then it fails.', 'Fix it.']],
        ['ellipsis ending a sentence', 'It hangs... The lock is never released.', ['It hangs...', 'The lock is never released.']],
        ['initials', 'Applies to U.S. users only. Gate it.', ['Applies to U.S. users only.', 'Gate it.']],
        ['inline numbered steps', 'Steps: 1. open the file 2. save it. Then run.', ['Steps: 1. open the file 2. save it.', 'Then run.']],
        // Numbers, versions and names with dots.
        ['number ending a sentence', 'The limit is 10. The retry loop ignores it.', ['The limit is 10.', 'The retry loop ignores it.']],
        ['number starting a sentence', 'It returns 500. 404 is expected here.', ['It returns 500.', '404 is expected here.']],
        ['decimal', 'The value is 3.14. Round it.', ['The value is 3.14.', 'Round it.']],
        ['version', 'Bump to v1.2.3. Then rebuild.', ['Bump to v1.2.3.', 'Then rebuild.']],
        ['dotted names', 'Node.js 22 and client.ts are fine. Upgrade.', ['Node.js 22 and client.ts are fine.', 'Upgrade.']],
        ['url', 'See https://kodus.io/docs/a.b. Then retry.', ['See https://kodus.io/docs/a.b.', 'Then retry.']],
        // Closing quotes, brackets and emphasis after the stop.
        ['closing quote', 'It logs "done." Then it exits.', ['It logs "done."', 'Then it exits.']],
        ['closing parenthesis', '(It returns null.) Then it crashes.', ['(It returns null.)', 'Then it crashes.']],
        ['bold label', '**Impact.** The cache grows. Evict it.', ['**Impact.**', 'The cache grows.', 'Evict it.']],
        // Inline code.
        ['punctuation inside inline code', 'The `a.b(). c` call fails. Fix it.', ['The `a.b(). c` call fails.', 'Fix it.']],
        ['?? inside and outside code', 'Use `a ?? b`. Use ?? instead. Done!', ['Use `a ?? b`.', 'Use ?? instead.', 'Done!']],
        ['dot right after inline code', 'The fix is `x = 1.`. Then run.', ['The fix is `x = 1.`.', 'Then run.']],
        // Seen in QA bodies: these are not sentence ends.
        ['predicate methods', 'Promotion#expired? and #not_started? do not check is_active?, causing drift. Fix it.', ['Promotion#expired? and #not_started? do not check is_active?, causing drift.', 'Fix it.']],
        ['quoted text inside a sentence', "It returns 'Redirecting to undefined.' instead of a 404. Fix it.", ["It returns 'Redirecting to undefined.' instead of a 404.", 'Fix it.']],
        ['exclamation inside a quote', "It shows 'Saved!' without saving. Fix it.", ["It shows 'Saved!' without saving.", 'Fix it.']],
        ['dash after an ellipsis in brackets', 'Tokens (glpat_...) — are hardcoded. Rotate them.', ['Tokens (glpat_...) — are hardcoded.', 'Rotate them.']],
        ['arrow after a stop', 'Rule "use HTTPS." → missing in code. Add it.', ['Rule "use HTTPS." → missing in code.', 'Add it.']],
        ['standalone operator', 'Negate it with ! instead. Done.', ['Negate it with ! instead.', 'Done.']],
        // An unmatched backtick must not swallow the rest of the text.
        ['unmatched backtick', 'The `value is wrong. It breaks. Fix it.', ['The `value is wrong.', 'It breaks.', 'Fix it.']],
    ])('%s', (_name, input, expected) => {
        expect(splitSentences(input)).toEqual(expected);
    });

    it('caps a lower-case fallback body at two sentences', () => {
        // The formatter can time out; the body is then the stripped finder
        // text, which keeps lower-case sentence starts.
        expect(
            shapeSuggestionBody({
                body: 'the guard is missing. it throws on null. add a check before the call.',
                title: 'Missing null guard in handler',
                capSentences: true,
            }),
        ).toBe('the guard is missing. it throws on null.');
    });
});
