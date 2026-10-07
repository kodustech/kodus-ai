import { detectAuthor } from './run-mapping';

describe('detectAuthor', () => {
    it('names the coding agent from a Co-Authored-By trailer', () => {
        expect(
            detectAuthor(
                [
                    {
                        message:
                            'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
                        authorName: 'rafa',
                        authorEmail: 'rafa@example.com',
                    },
                ],
                'rafa',
            ),
        ).toEqual({ kind: 'agent', agent: 'Claude Code', login: 'rafa' });
    });

    it('names the agent that authored the commit', () => {
        expect(
            detectAuthor([
                { message: 'fix', authorName: 'copilot-swe-agent[bot]' },
            ]),
        ).toMatchObject({ kind: 'agent', agent: 'Copilot agent' });
    });

    it('is a person when no commit names an agent, and unknown without commits', () => {
        expect(
            detectAuthor([{ message: 'fix: y', authorName: 'nina' }]).kind,
        ).toBe('person');
        expect(detectAuthor(undefined).kind).toBe('unknown');
    });
});
