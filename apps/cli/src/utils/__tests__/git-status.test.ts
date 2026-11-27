import { describe, expect, it } from 'vitest';
import { parseGitNameStatusOutput, parseGitStatus } from '../git-status.js';

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

    it('uses the new path for renames and copies while preserving oldFile on renames', () => {
        expect(
            parseGitNameStatusOutput(
                ['R100\tsrc/old.ts\tsrc/new.ts', 'C100\tfoo.ts\tbar.ts'].join(
                    '\n',
                ),
            ),
        ).toEqual([
            {
                file: 'src/new.ts',
                oldFile: 'src/old.ts',
                status: 'renamed',
            },
            { file: 'bar.ts', status: 'modified' },
        ]);
    });

    it('preserves oldFile on NUL-separated -z rename entries', () => {
        expect(
            parseGitNameStatusOutput(
                [
                    'R085',
                    'src/old.ts',
                    'src/new.ts',
                    'C100',
                    'a.ts',
                    'b.ts',
                    '',
                ].join('\0'),
            ),
        ).toEqual([
            {
                file: 'src/new.ts',
                oldFile: 'src/old.ts',
                status: 'renamed',
            },
            { file: 'b.ts', status: 'modified' },
        ]);
    });

    it('ignores blank lines', () => {
        expect(parseGitNameStatusOutput('\n\nM\tsrc/app.ts\n')).toEqual([
            { file: 'src/app.ts', status: 'modified' },
        ]);
    });
});
