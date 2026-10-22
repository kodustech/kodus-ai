import { GeneralistAgentProvider } from './generalist-agent.provider';

const provider = new GeneralistAgentProvider({} as any, {} as any);
const allowed = (input: any) =>
    (provider as any).getAllowedSuggestionLabels(input);
const categoryPrompt = (input: any) =>
    (provider as any).getCategoryPrompt(input);

const instructions = {
    files: [
        {
            path: 'CLAUDE.md',
            content: 'Use the logger.',
            appliesTo: '**',
            truncated: false,
        },
    ],
    otherFiles: [],
    dropped: [],
    truncated: false,
    indexedCount: 1,
};

describe('GeneralistAgentProvider — coding-agent instructions', () => {
    it('allows repo_instruction only when instructions were collected', () => {
        expect(allowed({})).toEqual(['bug', 'security', 'performance']);
        expect(allowed({ repoInstructions: instructions })).toEqual([
            'bug',
            'security',
            'performance',
            'repo_instruction',
        ]);
        expect(
            allowed({ repoInstructions: { ...instructions, files: [] } }),
        ).toEqual(['bug', 'security', 'performance']);
    });

    it('keeps requested categories and adds repo_instruction after them', () => {
        expect(
            allowed({
                requestedCategories: ['security'],
                repoInstructions: instructions,
            }),
        ).toEqual(['security', 'repo_instruction']);
    });

    it('adds the repo_instruction category to the category prompt only when instructions were collected', () => {
        expect(categoryPrompt({})).not.toContain('repo_instruction');
        expect(categoryPrompt({ repoInstructions: instructions })).toContain(
            'repo_instruction',
        );
    });

    it('keeps three review lenses when instructions were collected', () => {
        const prompt = categoryPrompt({ repoInstructions: instructions });
        expect(prompt).toContain('Run three explicit review lenses');
        expect(prompt).not.toContain('repository-instructions lens');
    });
});
