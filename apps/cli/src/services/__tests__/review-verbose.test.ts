import { describe, expect, it } from 'vitest';
import {
    createAnalyzeApiRequestVerboseMessages,
    createAnalyzeApiResponseVerboseMessages,
    createAnalyzeStartVerboseMessages,
    createFullFileContentsVerboseMessages,
    createTrialAnalyzeResponseVerboseMessages,
    createTrialAnalyzeStartVerboseMessages,
} from '../review-verbose.js';

describe('review verbose message builders', () => {
    it('builds analyze start messages', () => {
        expect(createAnalyzeStartVerboseMessages({ diff: 'abcd', rulesOnly: true, fast: false })).toEqual([
            '[verbose] Review config: rulesOnly=true, fast=false',
            '[verbose] Diff size: 4 characters',
        ]);
    });

    it('builds full file content messages including file details', () => {
        expect(
            createFullFileContentsVerboseMessages([
                {
                    path: 'src/a.ts',
                    content: 'const a = 1;',
                    status: 'modified',
                    diff: '+const a = 1;',
                },
            ]),
        ).toEqual([
            '[verbose] Full file contents: 1 file(s)',
            '[verbose]   - src/a.ts: 12 chars, status=modified',
        ]);
    });

    it('builds analyze request messages for team-key mode', () => {
        expect(
            createAnalyzeApiRequestVerboseMessages({
                diff: 'abcd',
                reviewConfig: { rulesOnly: true, fast: false },
                mode: 'team-key',
                gitInfo: {
                    branch: 'main',
                    remote: 'git@github.com:org/repo.git',
                },
            }),
        ).toEqual([
            '[verbose] Using team key with metrics',
            '[verbose] Git info: branch=main, remote=git@github.com:org/repo.git',
            '[verbose] Sending to API:',
            '[verbose]   - diff length: 4 chars',
            '[verbose]   - config: {"rulesOnly":true,"fast":false}',
        ]);
    });

    it('builds analyze response messages', () => {
        expect(
            createAnalyzeApiResponseVerboseMessages({
                summary: 'ok',
                issuesCount: 2,
                filesAnalyzed: 5,
            }),
        ).toEqual([
            '[verbose] API response:',
            '[verbose]   - summary: ok',
            '[verbose]   - issues: 2',
            '[verbose]   - filesAnalyzed: 5',
        ]);
    });

    it('builds trial analyze start and response messages', () => {
        expect(createTrialAnalyzeStartVerboseMessages('x'.repeat(350))).toEqual([
            '[verbose] Running trial analyze',
            '[verbose] Diff size: 350 characters',
            `[verbose] Diff preview:\n${'x'.repeat(300)}\n... (truncated)`,
        ]);
        expect(
            createTrialAnalyzeResponseVerboseMessages({
                summary: 'ok',
                issuesCount: 1,
                filesAnalyzed: 3,
            }),
        ).toEqual([
            '[verbose] Trial API response:',
            '[verbose]   - summary: ok',
            '[verbose]   - issues: 1',
            '[verbose]   - filesAnalyzed: 3',
        ]);
    });
});
