import { describe, expect, it } from 'vitest';
import {
    createFileSelectionFromModifiedFiles,
    createFileSelectionFromNameStatus,
    createFileSelectionFromPaths,
} from '../git-file-selection.js';

describe('createFileSelectionFromPaths', () => {
    it('uses explicit paths and leaves the status map empty', () => {
        expect(createFileSelectionFromPaths(['src/a.ts', 'src/b.ts'])).toEqual({
            filesToRead: ['src/a.ts', 'src/b.ts'],
            fileStatusMap: new Map(),
        });
    });
});

describe('createFileSelectionFromNameStatus', () => {
    it('builds file names and status map from git name-status output', () => {
        const result = createFileSelectionFromNameStatus(
            ['M\tsrc/app.ts', 'R100\tsrc/old.ts\tsrc/new.ts'].join('\n'),
        );

        expect(result.filesToRead).toEqual(['src/app.ts', 'src/new.ts']);
        expect(Array.from(result.fileStatusMap.entries())).toEqual([
            ['src/app.ts', 'modified'],
            ['src/new.ts', 'renamed'],
        ]);
        expect(Array.from(result.fileOldPathMap.entries())).toEqual([
            ['src/new.ts', 'src/old.ts'],
        ]);
    });

    it('parses NUL-separated -z name-status output with non-ASCII and special characters', () => {
        const result = createFileSelectionFromNameStatus(
            [
                'M',
                'src/ação.ts',
                'R100',
                'src/old.ts',
                'src/a "quoted"\tname.ts',
                'A',
                'src/plain.ts',
                '',
            ].join('\0'),
        );

        expect(result.filesToRead).toEqual([
            'src/ação.ts',
            'src/a "quoted"\tname.ts',
            'src/plain.ts',
        ]);
        expect(Array.from(result.fileStatusMap.entries())).toEqual([
            ['src/ação.ts', 'modified'],
            ['src/a "quoted"\tname.ts', 'renamed'],
            ['src/plain.ts', 'added'],
        ]);
        expect(Array.from(result.fileOldPathMap.entries())).toEqual([
            ['src/a "quoted"\tname.ts', 'src/old.ts'],
        ]);
    });

    it('prepends pathPrefix to files, status map, and rename sources when provided', () => {
        const result = createFileSelectionFromNameStatus(
            ['M', 'nested.ts', 'R080', 'old.ts', 'new.ts', ''].join('\0'),
            'packages/app/',
        );

        expect(result.filesToRead).toEqual([
            'packages/app/nested.ts',
            'packages/app/new.ts',
        ]);
        expect(Array.from(result.fileStatusMap.entries())).toEqual([
            ['packages/app/nested.ts', 'modified'],
            ['packages/app/new.ts', 'renamed'],
        ]);
        expect(Array.from(result.fileOldPathMap.entries())).toEqual([
            ['packages/app/new.ts', 'packages/app/old.ts'],
        ]);
    });
});

describe('createFileSelectionFromModifiedFiles', () => {
    it('builds file names and status map from modified file entries', () => {
        const result = createFileSelectionFromModifiedFiles([
            {
                file: 'src/app.ts',
                status: 'modified',
                additions: 1,
                deletions: 0,
                diff: '+const x = 1;',
            },
            {
                file: 'src/new.ts',
                status: 'added',
                additions: 3,
                deletions: 0,
                diff: '+const y = 2;',
            },
        ]);

        expect(result.filesToRead).toEqual(['src/app.ts', 'src/new.ts']);
        expect(Array.from(result.fileStatusMap.entries())).toEqual([
            ['src/app.ts', 'modified'],
            ['src/new.ts', 'added'],
        ]);
    });
});
