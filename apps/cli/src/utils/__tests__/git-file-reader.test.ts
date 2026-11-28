import { describe, expect, it } from 'vitest';
import {
    buildFileContentReadPlan,
    buildFileDiffReadPlan,
} from '../git-file-reader.js';

describe('buildFileDiffReadPlan', () => {
    it('builds a branch diff plan', () => {
        expect(buildFileDiffReadPlan('src/app.ts', { branch: 'main' })).toEqual(
            {
                mode: 'single-diff',
                args: ['main...HEAD', '--', 'src/app.ts'],
            },
        );
    });

    it('builds a commit diff plan', () => {
        expect(
            buildFileDiffReadPlan('src/app.ts', { commit: 'abc123' }),
        ).toEqual({
            mode: 'single-diff',
            args: ['abc123^', 'abc123', '--', 'src/app.ts'],
        });
    });

    it('builds a staged diff plan with top,literal pathspec', () => {
        expect(buildFileDiffReadPlan('src/app.ts', { staged: true })).toEqual({
            mode: 'single-diff',
            args: ['--cached', '--', ':(top,literal)src/app.ts'],
        });
    });

    it('includes both old and new top,literal pathspecs for a staged rename', () => {
        expect(
            buildFileDiffReadPlan('src/new.ts', {
                staged: true,
                oldFilePath: 'src/old.ts',
            }),
        ).toEqual({
            mode: 'single-diff',
            args: [
                '--cached',
                '--',
                ':(top,literal)src/old.ts',
                ':(top,literal)src/new.ts',
            ],
        });
    });

    it('builds a working tree diff plan', () => {
        expect(buildFileDiffReadPlan('src/app.ts')).toEqual({
            mode: 'working-tree-diff',
            stagedArgs: ['--cached', '--', 'src/app.ts'],
            unstagedArgs: ['--', 'src/app.ts'],
        });
    });
});

describe('buildFileContentReadPlan', () => {
    it('reads commit content from the selected commit', () => {
        expect(
            buildFileContentReadPlan('src/app.ts', { commit: 'abc123' }),
        ).toEqual({
            mode: 'git-show',
            args: ['abc123:src/app.ts'],
        });
    });

    it('reads branch comparison content from HEAD', () => {
        expect(
            buildFileContentReadPlan('src/app.ts', { branch: 'main' }),
        ).toEqual({
            mode: 'git-show',
            args: ['HEAD:src/app.ts'],
        });
    });

    it('reads staged content from stage 0 of the git index', () => {
        expect(
            buildFileContentReadPlan('src/app.ts', { staged: true }),
        ).toEqual({
            mode: 'git-show',
            args: [':0:src/app.ts'],
        });
        expect(
            buildFileContentReadPlan('1:sample.txt', { staged: true }),
        ).toEqual({
            mode: 'git-show',
            args: [':0:1:sample.txt'],
        });
    });

    it('reads working tree content from disk', () => {
        expect(buildFileContentReadPlan('src/app.ts')).toEqual({
            mode: 'fs',
            path: 'src/app.ts',
            encoding: 'utf-8',
        });
    });
});
