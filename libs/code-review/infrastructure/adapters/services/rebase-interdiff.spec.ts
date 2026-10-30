import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { rebaseInterdiff } from './rebase-interdiff';

const file = (
    filename: string,
    patch: string | undefined,
    extra: Partial<FileChange> = {},
): FileChange =>
    ({
        filename,
        status: 'modified',
        additions: 0,
        deletions: 0,
        changes: 0,
        patch,
        ...extra,
    }) as FileChange;

const hunk = (header: string, ...lines: string[]) =>
    [header, ...lines].join('\n');

describe('rebaseInterdiff', () => {
    const hunkA = hunk(
        '@@ -10,4 +10,5 @@ function a()',
        ' const x = 1;',
        '-return x;',
        '+const y = 2;',
        '+return x + y;',
        ' }',
    );
    const hunkB = hunk(
        '@@ -40,3 +41,4 @@ function b()',
        ' const z = 3;',
        '+log(z);',
        ' return z;',
    );

    it('drops every file when the PR diff is the same as before the rebase', () => {
        const previous = [file('src/a.ts', `${hunkA}\n${hunkB}`)];
        const current = [file('src/a.ts', `${hunkA}\n${hunkB}`)];

        const result = rebaseInterdiff(current, previous);

        expect(result.files).toEqual([]);
        expect(result.unchangedFiles).toEqual(['src/a.ts']);
        expect(result.hunksDropped).toBe(2);
        expect(result.hunksKept).toBe(0);
    });

    it('treats a hunk whose line numbers and farther context moved as unchanged', () => {
        const previous = [
            file(
                'src/a.ts',
                hunk(
                    '@@ -10,5 +10,6 @@ function a()',
                    ' const x = 1;',
                    '-return x;',
                    '+const y = 2;',
                    '+return x + y;',
                    ' }',
                    ' const after = 1;',
                ),
            ),
        ];
        const shifted = hunk(
            '@@ -25,5 +25,6 @@ function a()',
            ' const x = 1;',
            '-return x;',
            '+const y = 2;',
            '+return x + y;',
            ' }',
            ' const after = 2; // edited on main',
        );

        const result = rebaseInterdiff([file('src/a.ts', shifted)], previous);

        expect(result.files).toEqual([]);
    });

    it('keeps only the hunk the rebase rewrote, with its own header', () => {
        const previous = [file('src/a.ts', `${hunkA}\n${hunkB}`)];
        const rewrittenB = hunk(
            '@@ -40,3 +41,4 @@ function b()',
            ' const z = 3;',
            '+log(z, "resolved");',
            ' return z;',
        );

        const result = rebaseInterdiff(
            [file('src/a.ts', `${hunkA}\n${rewrittenB}`)],
            previous,
        );

        expect(result.files).toHaveLength(1);
        expect(result.files[0].patch).toBe(rewrittenB);
        expect(result.files[0].additions).toBe(1);
        expect(result.files[0].deletions).toBe(0);
        expect(result.files[0].changes).toBe(1);
        expect(result.partialFiles).toEqual(['src/a.ts']);
        expect(result.hunksKept).toBe(1);
        expect(result.hunksDropped).toBe(1);
    });

    it('shows lines already reviewed as context, like a normal push, when new lines join their block', () => {
        const before = hunk(
            '@@ -7,3 +7,9 @@ export function available()',
            ' }',
            '+',
            '+function reserve() {',
            '+    take();',
            '+}',
        );
        const after = hunk(
            '@@ -7,3 +7,13 @@ export function available()',
            ' }',
            '+',
            '+function reserve() {',
            '+    take();',
            '+}',
            '+',
            '+function release() {',
            '+    give();',
            '+}',
        );

        const result = rebaseInterdiff(
            [file('src/inventory.ts', after)],
            [file('src/inventory.ts', before)],
        );

        expect(result.files).toHaveLength(1);
        expect(result.files[0].patch).toBe(
            hunk(
                '@@ -7,5 +7,13 @@ export function available()',
                ' }',
                ' ',
                ' function reserve() {',
                '     take();',
                ' }',
                '+',
                '+function release() {',
                '+    give();',
                '+}',
            ),
        );
        expect(result.files[0].additions).toBe(4);
        expect(result.files[0].deletions).toBe(0);
        expect(result.partialFiles).toEqual(['src/inventory.ts']);
    });

    it('drops a removed line that was already reviewed from a hunk that stays', () => {
        const before = hunk('@@ -1,3 +1,3 @@', ' a', '-old', '+mid', ' c');
        const after = hunk('@@ -1,3 +1,3 @@', ' a', '-old', '+new', ' c');

        const result = rebaseInterdiff(
            [file('src/a.ts', after)],
            [file('src/a.ts', before)],
        );

        expect(result.files[0].patch).toBe(
            hunk('@@ -1,2 +1,3 @@', ' a', '+new', ' c'),
        );
        expect(result.files[0].deletions).toBe(0);
    });

    it('keeps a whole file too rewritten to compare cheaply, and names it', () => {
        const lines = (prefix: string) =>
            Array.from({ length: 5000 }, (_, i) => `+${prefix}${i}`);
        const before = hunk('@@ -0,0 +1,5000 @@', ...lines('old'));
        const after = hunk('@@ -0,0 +1,5000 @@', ...lines('new'));
        const current = file('package-lock.json', after);

        const result = rebaseInterdiff(
            [current],
            [file('package-lock.json', before)],
        );

        expect(result.files).toEqual([current]);
        expect(result.uncomparedFiles).toEqual(['package-lock.json']);
    });

    it('keeps an empty context line at the end of a hunk', () => {
        const after = hunk('@@ -1,2 +1,4 @@', ' a', '+b', '+c', ' ');
        // b was reviewed under the same lines; c is new.

        const result = rebaseInterdiff(
            [file('src/a.ts', `${after}\n`)],
            [file('src/a.ts', hunk('@@ -1,2 +1,3 @@', ' a', '+b', ' '))],
        );

        expect(result.files[0].patch).toBe(
            hunk('@@ -1,3 +1,4 @@', ' a', ' b', '+c', ' '),
        );
    });

    it('keeps a file the PR did not touch before the rebase', () => {
        const added = file('src/new.ts', hunkB, { status: 'added' });

        const result = rebaseInterdiff([added], [file('src/a.ts', hunkA)]);

        expect(result.files).toEqual([added]);
        expect(result.unchangedFiles).toEqual([]);
    });

    it('compares a file renamed by the rebase with its old name', () => {
        const renamed = file('src/b.ts', hunkA, {
            status: 'renamed',
            previous_filename: 'src/a.ts',
        });

        const result = rebaseInterdiff([renamed], [file('src/a.ts', hunkA)]);

        expect(result.files).toEqual([]);
    });

    it('treats two hunks that merged into one as unchanged when each change was there before', () => {
        const previous = [
            file(
                'src/a.ts',
                `${hunk('@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c')}\n${hunk('@@ -9,3 +9,3 @@', ' g', '-h', '+H', ' i')}`,
            ),
        ];
        const merged = hunk(
            '@@ -1,7 +1,7 @@',
            ' a',
            '-b',
            '+B',
            ' c',
            ' g',
            '-h',
            '+H',
            ' i',
        );

        const result = rebaseInterdiff([file('src/a.ts', merged)], previous);

        expect(result.files).toEqual([]);
    });

    it('reviews a change the rebase moved to another place in the file', () => {
        // The same line, now under another function: a normal push would show
        // it removed from one place and added to the other.
        const before = hunk(
            '@@ -1,2 +1,3 @@',
            ' function a() {',
            '+return true;',
        );
        const after = hunk(
            '@@ -9,2 +9,3 @@',
            ' function b() {',
            '+return true;',
        );

        const result = rebaseInterdiff(
            [file('src/a.ts', after)],
            [file('src/a.ts', before)],
        );

        expect(result.files).toHaveLength(1);
        expect(result.files[0].patch).toBe(after);
    });

    it('reviews a change moved to another function under the same blank line', () => {
        // The context line above is blank in both places; the hunk header's
        // section (the enclosing function, on GitHub and GitLab) tells them
        // apart.
        const previous = [
            file(
                'src/auth.ts',
                hunk(
                    '@@ -10,4 +10,5 @@ export function updateProfile(user) {',
                    '   const input = parse(user);',
                    ' ',
                    '+  assertOwner(user);',
                    '   return save(input);',
                ),
            ),
        ];
        const current = [
            file(
                'src/auth.ts',
                hunk(
                    '@@ -40,4 +40,5 @@ export function deleteAccount(user) {',
                    '   const input = parse(user);',
                    ' ',
                    '+  assertOwner(user);',
                    '   return remove(input);',
                ),
            ),
        ];

        expect(rebaseInterdiff(current, previous).unchangedFiles).toEqual([]);
    });

    it('reviews a change moved to another function when only the hunk names the function', () => {
        // No section in the header (Azure, Bitbucket DC): the function line
        // inside the hunk tells the two places apart.
        const before = hunk(
            '@@ -1,4 +1,5 @@',
            ' export function f3(arg) {',
            '     validate(arg);',
            '+    // TODO',
            '     return x;',
        );
        const after = hunk(
            '@@ -9,4 +9,5 @@',
            ' export function f2(arg) {',
            '     validate(arg);',
            '+    // TODO',
            '     return x;',
        );

        const result = rebaseInterdiff(
            [file('src/a.ts', after)],
            [file('src/a.ts', before)],
        );

        expect(result.unchangedFiles).toEqual([]);
    });

    it('reviews a change moved within its function past a line like the one above it', () => {
        const before = hunk(
            '@@ -10,4 +10,4 @@ export function f1(arg) {',
            '     await flush();',
            '-    const input = parse(arg);',
            '+    assertOwner(arg);',
            ' }',
        );
        const after = hunk(
            '@@ -9,5 +9,5 @@ export function f1(arg) {',
            '     await flush();',
            '+    assertOwner(arg);',
            '     return save(input);',
            '     await flush();',
            '-    const input = parse(arg);',
            ' }',
        );

        const result = rebaseInterdiff(
            [file('src/a.ts', after)],
            [file('src/a.ts', before)],
        );

        expect(result.files).toHaveLength(1);
        expect(result.files[0].patch).toContain('+    assertOwner(arg);');
    });

    it('takes the function a change sits in, not the one the hunk header names', () => {
        // Git names a hunk after the last function line before its first
        // line; a function that starts inside the hunk is the one that counts.
        const before = hunk(
            '@@ -4,7 +4,8 @@ export function a() {',
            ' }',
            ' ',
            ' export function b() {',
            '   const y = 1;',
            '+  log(y);',
            '   return y;',
        );
        const after = hunk(
            '@@ -4,7 +4,8 @@ export function a() {',
            ' }',
            ' ',
            ' export function c() {',
            '   const y = 1;',
            '+  log(y);',
            '   return y;',
        );

        const result = rebaseInterdiff(
            [file('src/a.ts', after)],
            [file('src/a.ts', before)],
        );

        expect(result.unchangedFiles).toEqual([]);
    });

    it('reviews a block moved between two methods of one class', () => {
        // Methods are indented, so the enclosing scope is the nearest line
        // above with less indentation, not the class line at column 0.
        const before = hunk(
            '@@ -13,6 +13,6 @@ export class Service {',
            '     m2(arg) {',
            '         ',
            '-        count++;',
            '+        await flush();',
            '     }',
        );
        const after = hunk(
            '@@ -1,6 +1,7 @@ export class Service {',
            '     m0(arg) {',
            '         ',
            '+        await flush();',
            '     }',
        );

        const result = rebaseInterdiff(
            [file('src/a.ts', after)],
            [file('src/a.ts', before)],
        );

        expect(result.unchangedFiles).toEqual([]);
    });

    it('still matches a change in the same method under the same lines', () => {
        const before = hunk(
            '@@ -13,6 +13,6 @@ export class Service {',
            '     m2(arg) {',
            '         ',
            '+        await flush();',
            '     }',
        );
        const after = hunk(
            '@@ -40,6 +40,6 @@ export class Service {',
            '     m2(arg) {',
            '         ',
            '+        await flush();',
            '     }',
        );

        const result = rebaseInterdiff(
            [file('src/a.ts', after)],
            [file('src/a.ts', before)],
        );

        expect(result.unchangedFiles).toEqual(['src/a.ts']);
    });

    it('still matches a change whose hunk header carries no section', () => {
        const before = hunk('@@ -1,2 +1,3 @@', ' a', '+b');
        const after = hunk('@@ -30,2 +30,3 @@', ' a', '+b');

        const result = rebaseInterdiff(
            [file('src/a.ts', after)],
            [file('src/a.ts', before)],
        );

        expect(result.unchangedFiles).toEqual(['src/a.ts']);
    });

    it('reviews a change again when the line right above it changed', () => {
        // The price of telling moved changes apart: the target branch editing
        // the line above a change makes that change read as new.
        const before = hunk('@@ -1,2 +1,3 @@', ' const x = 1;', '+use(x);');
        const after = hunk('@@ -1,2 +1,3 @@', ' const x = 2;', '+use(x);');

        const result = rebaseInterdiff(
            [file('src/a.ts', after)],
            [file('src/a.ts', before)],
        );

        expect(result.files).toHaveLength(1);
    });

    it('keeps the second copy of a change that appeared once before', () => {
        const once = hunk('@@ -1,2 +1,2 @@', ' a', '-b', '+B');
        const twice = hunk('@@ -20,2 +20,2 @@', ' z', '-b', '+B');

        const result = rebaseInterdiff(
            [file('src/a.ts', `${once}\n${twice}`)],
            [file('src/a.ts', once)],
        );

        expect(result.files).toHaveLength(1);
        expect(result.files[0].patch).toBe(twice);
    });

    it('keeps a whole file whose diff either side could not provide', () => {
        const noCurrentPatch = file('src/big.ts', undefined);
        const noPreviousPatch = file('src/c.ts', hunkA);

        const result = rebaseInterdiff(
            [noCurrentPatch, noPreviousPatch],
            [file('src/big.ts', hunkA), file('src/c.ts', undefined)],
        );

        expect(result.files).toEqual([noCurrentPatch, noPreviousPatch]);
    });

    it('ignores what comes before the first hunk and "no newline" markers', () => {
        const withHeader = [
            'diff --git a/src/a.ts b/src/a.ts',
            'index 1111111..2222222 100644',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            hunkA,
            '\\ No newline at end of file',
        ].join('\n');

        const result = rebaseInterdiff(
            [file('src/a.ts', hunkA)],
            [file('src/a.ts', withHeader)],
        );

        expect(result.files).toEqual([]);
    });

    it('ignores carriage returns at the end of a line', () => {
        const crlf = hunkA.split('\n').join('\r\n');

        const result = rebaseInterdiff(
            [file('src/a.ts', hunkA)],
            [file('src/a.ts', crlf)],
        );

        expect(result.files).toEqual([]);
    });
});
