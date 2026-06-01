import { describe, expect, it } from 'vitest';
import {
    buildFileStatusMap,
    listFilesFromNameStatus,
} from '../git-file-targets.js';

describe('listFilesFromNameStatus', () => {
    it('returns file names in order from name-status output', () => {
        const nameStatus = [
            'M\tsrc/app.ts',
            'A\tsrc/new.ts',
            'R100\tsrc/old.ts\tsrc/renamed.ts',
        ].join('\n');

        expect(listFilesFromNameStatus(nameStatus)).toEqual([
            'src/app.ts',
            'src/new.ts',
            'src/renamed.ts',
        ]);
    });
});

describe('buildFileStatusMap', () => {
    it('maps each parsed file to its normalized status', () => {
        const nameStatus = [
            'M\tsrc/app.ts',
            'A\tsrc/new.ts',
            'D\tsrc/old.ts',
            'R100\tsrc/a.ts\tsrc/b.ts',
        ].join('\n');

        expect(Array.from(buildFileStatusMap(nameStatus).entries())).toEqual([
            ['src/app.ts', 'modified'],
            ['src/new.ts', 'added'],
            ['src/old.ts', 'deleted'],
            ['src/b.ts', 'renamed'],
        ]);
    });
});
