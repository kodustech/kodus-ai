import { CliInputConverter } from '@libs/cli-review/infrastructure/converters/cli-input.converter';

import { FormatCliOutputStage } from './format-cli-output.stage';

describe('FormatCliOutputStage', () => {
    // QA M18 on #2420: a Kody Rule finding that cites no line is routed to
    // the PR-level list, which the CLI never read, so it vanished from
    // `issues[]`.
    it('lists a line-less Kody Rule finding from the PR-level list on its file', async () => {
        const stage = new FormatCliOutputStage(new CliInputConverter());

        const out = await stage.execute({
            correlationId: 'c-1',
            startTime: Date.now(),
            changedFiles: [{ filename: 'src/CheckinReport.cs' }],
            validSuggestions: [
                {
                    relevantFile: 'src/a.ts',
                    relevantLinesStart: 3,
                    relevantLinesEnd: 3,
                    label: 'bug',
                    severity: 'high',
                    suggestionContent: 'A bug.',
                },
            ],
            validSuggestionsByPR: [
                {
                    id: 'p-1',
                    relevantFile: 'src/CheckinReport.cs',
                    label: 'kody_rules',
                    severity: 'medium',
                    oneSentenceSummary: 'Name lacks the qa2420_ prefix.',
                    suggestionContent: 'Rename the file with the prefix.',
                    brokenKodyRulesIds: ['rule-d'],
                },
            ],
        } as never);

        expect(out.cliResponse.issues).toEqual([
            expect.objectContaining({ file: 'src/a.ts', line: 3 }),
            expect.objectContaining({
                file: 'src/CheckinReport.cs',
                line: 0,
                category: 'kody_rules',
            }),
        ]);
    });
});
