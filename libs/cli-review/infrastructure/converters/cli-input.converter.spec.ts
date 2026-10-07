import { CliInputConverter } from './cli-input.converter';

const base = {
    relevantFile: 'src/user.ts',
    relevantLinesStart: 10,
    relevantLinesEnd: 12,
    severity: 'high',
    label: 'bug',
    improvedCode: 'const name = user?.name;',
    oneSentenceSummary: 'User can be null when the account was deleted',
    suggestionContent: 'The user can be null. Guard it.',
};

describe('CliInputConverter.convertToCliResponse', () => {
    it('gives agents the full explanation and the title, not the short body', () => {
        const { issues } = new CliInputConverter().convertToCliResponse(
            [
                {
                    ...base,
                    fullExplanation:
                        'The user can be null when the account was deleted. Reading name throws. Guard it.',
                },
            ],
            1,
            Date.now(),
        );

        expect(issues[0].message).toBe(
            'The user can be null when the account was deleted. Reading name throws. Guard it.',
        );
        expect(issues[0].title).toBe(
            'User can be null when the account was deleted',
        );
    });

    it('falls back to the body for suggestions without a full explanation', () => {
        const { issues } = new CliInputConverter().convertToCliResponse(
            [base],
            1,
            Date.now(),
        );

        expect(issues[0].message).toBe('The user can be null. Guard it.');
    });
});
