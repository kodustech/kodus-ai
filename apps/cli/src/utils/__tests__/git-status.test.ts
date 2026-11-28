import { describe, expect, it } from 'vitest';
import {
    parseGitNameStatusOutput,
    parseGitStatus,
    parseTrackedGitStatus,
} from '../git-status.js';

describe('parseGitStatus', () => {
    it('maps A to added', () => {
        expect(parseGitStatus('A')).toBe('added');
    });

    it('maps D to deleted', () => {
        expect(parseGitStatus('D')).toBe('deleted');
    });

    it('maps R100 to renamed', () => {
        expect(parseGitStatus('R100')).toBe('renamed');
    });

    it('maps unknown char to modified', () => {
        expect(parseGitStatus('X')).toBe('modified');
    });
});

describe('parseTrackedGitStatus', () => {
    it('preserves the existing staged and modified selection', () => {
        const status = `${[
            ' M root.txt',
            'M  src/staged.txt',
            'MM src/both.txt',
            'A  src/added.txt',
            ' D src/deleted.txt',
            '?? untracked.txt',
            'R  src/renamed.txt',
            'src/old-name.txt',
            'RM src/renamed-modified.txt',
            'src/previous-name.txt',
        ].join('\0')}\0`;

        expect(parseTrackedGitStatus(status)).toEqual({
            staged: ['src/staged.txt', 'src/both.txt', 'src/added.txt'],
            modified: [
                'root.txt',
                'src/staged.txt',
                'src/both.txt',
                'src/renamed-modified.txt',
            ],
        });
    });

    it('consumes rename and copy source pathnames without changing selections', () => {
        const status = `${[
            ' R worktree-renamed.txt',
            ' M worktree-source.txt',
            'C  index-copied.txt',
            'M  index-source.txt',
            'M  index-source.txt',
        ].join('\0')}\0`;

        expect(parseTrackedGitStatus(status)).toEqual({
            staged: ['index-source.txt'],
            modified: ['index-source.txt'],
        });
    });

    it('excludes unmerged paths while retaining ordinary add/delete handling', () => {
        const status = `${[
            'DD both-deleted.txt',
            'AU added-by-us.txt',
            'UD deleted-by-them.txt',
            'UA added-by-them.txt',
            'DU deleted-by-us.txt',
            'AA both-added.txt',
            'UU both-modified.txt',
            'AD added-then-deleted.txt',
        ].join('\0')}\0`;

        expect(parseTrackedGitStatus(status)).toEqual({
            staged: ['added-then-deleted.txt'],
            modified: [],
        });
    });

    it('preserves whitespace in repository-relative paths', () => {
        const status = ' M  src /nested.txt \0';

        expect(parseTrackedGitStatus(status)).toEqual({
            staged: [],
            modified: [' src /nested.txt '],
        });
    });
});

describe('parseGitNameStatusOutput', () => {
    it('parses modified, added, and deleted files', () => {
        expect(
            parseGitNameStatusOutput(
                ['M\tsrc/app.ts', 'A\tsrc/new.ts', 'D\tsrc/old.ts'].join('\n'),
            ),
        ).toEqual([
            { file: 'src/app.ts', status: 'modified' },
            { file: 'src/new.ts', status: 'added' },
            { file: 'src/old.ts', status: 'deleted' },
        ]);
    });

    it('uses the new path for renames and copies', () => {
        expect(
            parseGitNameStatusOutput(
                ['R100\tsrc/old.ts\tsrc/new.ts', 'C100\tfoo.ts\tbar.ts'].join(
                    '\n',
                ),
            ),
        ).toEqual([
            { file: 'src/new.ts', status: 'renamed' },
            { file: 'bar.ts', status: 'modified' },
        ]);
    });

    it('ignores blank lines', () => {
        expect(parseGitNameStatusOutput('\n\nM\tsrc/app.ts\n')).toEqual([
            { file: 'src/app.ts', status: 'modified' },
        ]);
    });
});
