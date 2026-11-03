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
