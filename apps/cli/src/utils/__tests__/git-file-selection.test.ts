import { describe, expect, it } from 'vitest';
import {
    createFileSelectionFromModifiedFiles,
    createFileSelectionFromNameStatus,
    createFileSelectionFromPaths,
} from '../git-file-selection.js';

describe('createFileSelectionFromPaths', () => {
    it('uses explicit paths and leaves the status map empty', () => {
        expect(
            createFileSelectionFromPaths(['src/a.ts', 'src/b.ts']),
        ).toEqual({
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
