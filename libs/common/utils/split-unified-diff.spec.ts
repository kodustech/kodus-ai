import { splitUnifiedDiff } from './split-unified-diff';

describe('splitUnifiedDiff', () => {
    it('splits a multi-file git diff into one patch per file, from its first hunk', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            'index 1111111..2222222 100644',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,2 +1,2 @@',
            ' a',
            '-b',
            '+B',
            'diff --git a/src/new.ts b/src/new.ts',
            'new file mode 100644',
            'index 0000000..3333333',
            '--- /dev/null',
            '+++ b/src/new.ts',
            '@@ -0,0 +1 @@',
            '+n',
            '',
        ].join('\n');

        expect(splitUnifiedDiff(diff)).toEqual([
            {
                filename: 'src/a.ts',
                status: 'modified',
                patch: '@@ -1,2 +1,2 @@\n a\n-b\n+B',
                additions: 1,
                deletions: 1,
            },
            {
                filename: 'src/new.ts',
                status: 'added',
                patch: '@@ -0,0 +1 @@\n+n',
                additions: 1,
                deletions: 0,
            },
        ]);
    });

    it('reads renames and deletions from the extended headers', () => {
        const diff = [
            'diff --git a/old.ts b/renamed.ts',
            'similarity index 90%',
            'rename from old.ts',
            'rename to renamed.ts',
            '--- a/old.ts',
            '+++ b/renamed.ts',
            '@@ -1 +1 @@',
            '-x',
            '+y',
            'diff --git a/gone.ts b/gone.ts',
            'deleted file mode 100644',
            '--- a/gone.ts',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-z',
        ].join('\n');

        expect(splitUnifiedDiff(diff)).toEqual([
            expect.objectContaining({
                filename: 'renamed.ts',
                previous_filename: 'old.ts',
                status: 'renamed',
            }),
            expect.objectContaining({
                filename: 'gone.ts',
                status: 'removed',
                deletions: 1,
            }),
        ]);
    });

    it('keeps a file with no hunks (binary, mode change) with an empty patch', () => {
        const diff = [
            'diff --git a/logo.png b/logo.png',
            'index 1111111..2222222 100644',
            'Binary files a/logo.png and b/logo.png differ',
        ].join('\n');

        expect(splitUnifiedDiff(diff)).toEqual([
            expect.objectContaining({ filename: 'logo.png', patch: '' }),
        ]);
    });

    it('returns nothing for an empty diff', () => {
        expect(splitUnifiedDiff('')).toEqual([]);
    });

    it('keys a path that contains " b/" by its full name', () => {
        const diff = [
            'diff --git a/src/a b/f.ts b/src/a b/f.ts',
            'index 1111111..2222222 100644',
            '--- a/src/a b/f.ts\t',
            '+++ b/src/a b/f.ts\t',
            '@@ -1 +1 @@',
            '-x',
            '+y',
        ].join('\n');

        expect(splitUnifiedDiff(diff).map((f) => f.filename)).toEqual([
            'src/a b/f.ts',
        ]);
    });

    it('decodes a quoted non-ASCII path', () => {
        const diff = [
            'diff --git "a/docs/caf\\303\\251.md" "b/docs/caf\\303\\251.md"',
            'index 1111111..2222222 100644',
            '--- "a/docs/caf\\303\\251.md"',
            '+++ "b/docs/caf\\303\\251.md"',
            '@@ -1 +1 @@',
            '-x',
            '+y',
        ].join('\n');

        expect(splitUnifiedDiff(diff).map((f) => f.filename)).toEqual([
            'docs/café.md',
        ]);
    });

    it('keys a change with no ---/+++ lines from the git header', () => {
        const diff = [
            'diff --git a/bin/run me.sh b/bin/run me.sh',
            'old mode 100644',
            'new mode 100755',
            'diff --git "a/img/\\303\\251.png" "b/img/\\303\\251.png"',
            'index 1111111..2222222 100644',
            'Binary files "a/img/\\303\\251.png" and "b/img/\\303\\251.png" differ',
        ].join('\n');

        expect(splitUnifiedDiff(diff).map((f) => f.filename)).toEqual([
            'bin/run me.sh',
            'img/é.png',
        ]);
    });
});

describe('splitUnifiedDiff — which line names the file', () => {
    const names = (...lines: string[]) =>
        splitUnifiedDiff(lines.join('\n')).map((f) => f.filename);

    it('takes the +++ path over the git header', () => {
        expect(
            names(
                'diff --git a/header.ts b/header.ts',
                '--- a/header.ts',
                '+++ b/plus.ts',
                '@@ -1 +1 @@',
                '-x',
                '+y',
            ),
        ).toEqual(['plus.ts']);
    });

    it('takes the --- path for a deletion, not the git header', () => {
        expect(
            names(
                'diff --git a/header.ts b/header.ts',
                'deleted file mode 100644',
                '--- a/minus.ts',
                '+++ /dev/null',
                '@@ -1 +0,0 @@',
                '-x',
            ),
        ).toEqual(['minus.ts']);
    });

    it('takes "rename to" when there are no ---/+++ lines', () => {
        // A pure rename of a path with " b/" in it: the git header alone
        // would be cut at the last " b/".
        expect(
            names(
                'diff --git a/docs/a b/old.md b/docs/a b/new.md',
                'similarity index 100%',
                'rename from docs/a b/old.md',
                'rename to docs/a b/new.md',
            ),
        ).toEqual(['docs/a b/new.md']);
    });

    it('takes "copy to" when there are no ---/+++ lines', () => {
        expect(
            names(
                'diff --git a/docs/a b/src.md b/docs/a b/copy.md',
                'similarity index 100%',
                'copy from docs/a b/src.md',
                'copy to docs/a b/copy.md',
            ),
        ).toEqual(['docs/a b/copy.md']);
    });

    it('splits a same-path git header in the middle, " b/" in the path or not', () => {
        expect(
            names(
                'diff --git a/src/a b/f.ts b/src/a b/f.ts',
                'old mode 100644',
                'new mode 100755',
            ),
        ).toEqual(['src/a b/f.ts']);
        expect(
            names(
                'diff --git a/x.sh b/x.sh',
                'old mode 100644',
                'new mode 100755',
            ),
        ).toEqual(['x.sh']);
    });

    it('falls back to the last " b/" of a git header naming two paths', () => {
        expect(
            names(
                'diff --git a/img/old.png b/img/new.png',
                'Binary files a/img/old.png and b/img/new.png differ',
            ),
        ).toEqual(['img/new.png']);
    });

    it('drops a section it cannot name, and keeps the rest', () => {
        const files = splitUnifiedDiff(
            [
                'diff --git nothing-to-split',
                'Binary files differ',
                'diff --git a/kept.ts b/kept.ts',
                '--- a/kept.ts',
                '+++ b/kept.ts',
                '@@ -1 +1 @@',
                '-x',
                '+y',
            ].join('\n'),
        );
        expect(files.map((f) => f.filename)).toEqual(['kept.ts']);
    });

    it('ignores text before the first "diff --git", even if it looks like a diff', () => {
        expect(
            names(
                'From 1234 Mon Sep 17 00:00:00 2001',
                'Subject: notes',
                '+++ b/notes.txt',
                'diff --git a/real.ts b/real.ts',
                '--- a/real.ts',
                '+++ b/real.ts',
                '@@ -1 +1 @@',
                '-x',
                '+y',
            ),
        ).toEqual(['real.ts']);
    });

    it('drops the trailing tab git adds to a name with a space', () => {
        expect(
            names(
                'diff --git a/my file.ts b/my file.ts',
                '--- a/my file.ts\t',
                '+++ b/my file.ts\t',
                '@@ -1 +1 @@',
                '-x',
                '+y',
            ),
        ).toEqual(['my file.ts']);
    });
});

describe('splitUnifiedDiff — quoted paths', () => {
    const plusName = (quoted: string) =>
        splitUnifiedDiff(
            [
                `diff --git ${quoted.replace('b/', 'a/')} ${quoted}`,
                `+++ ${quoted}`,
                '@@ -1 +1 @@',
                '+y',
            ].join('\n'),
        )[0]?.filename;

    it.each([
        ['an octal UTF-8 sequence', '"b/caf\\303\\251.ts"', 'café.ts'],
        ['a tab', '"b/a\\tb.ts"', 'a\tb.ts'],
        ['a backslash', '"b/a\\\\b.ts"', 'a\\b.ts'],
        ['a double quote', '"b/a\\"b.ts"', 'a"b.ts'],
        ['an unknown escape, kept as written', '"b/a\\qb.ts"', 'a\\qb.ts'],
    ])('decodes %s', (_label, quoted, expected) => {
        expect(plusName(quoted)).toBe(expected);
    });

    it('reads a quoted git header with an escaped quote when there are no ---/+++ lines', () => {
        expect(
            splitUnifiedDiff(
                [
                    'diff --git "a/q\\"x.png" "b/q\\"x.png"',
                    'Binary files "a/q\\"x.png" and "b/q\\"x.png" differ',
                ].join('\n'),
            ).map((f) => f.filename),
        ).toEqual(['q"x.png']);
    });

    it('leaves an unquoted path that merely ends with a quote alone', () => {
        expect(
            splitUnifiedDiff(
                [
                    'diff --git a/say" b/say"',
                    '--- a/say"',
                    '+++ b/say"',
                    '@@ -1 +1 @@',
                    '+y',
                ].join('\n'),
            )[0]?.filename,
        ).toBe('say"');
    });
});
