import { resolveSuggestionLabel } from '@libs/code-review/infrastructure/agents/collaborators/finding-mapper';

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
});

// Discarded findings were once tagged with the agent label ('generalist'),
// overwriting the bug/security/performance label the model emitted. The policy
// is built the way base-code-review-agent.provider builds it before mapping.
describe('GeneralistAgentProvider — finding label policy', () => {
    const resolve = (label: unknown, input: any = {}) =>
        resolveSuggestionLabel({ label } as any, {
            categoryLabel: (provider as any).getCategoryLabel(),
            allowedLabels: allowed(input),
            supportsMixed: (provider as any).supportsMixedLabels(),
        });

    it('keeps the label the model emitted, case-normalized', () => {
        expect(resolve('security')).toBe('security');
        expect(resolve('PERFORMANCE')).toBe('performance');
    });

    it('never labels a finding "generalist"; a missing or unknown label falls back to the first allowed one', () => {
        expect(resolve('generalist')).toBe('bug');
        expect(resolve(undefined)).toBe('bug');
        expect(resolve(null)).toBe('bug');
    });

    it('falls back inside the requested categories when the label is outside them', () => {
        const narrow = { requestedCategories: ['security', 'performance'] };
        expect(resolve('bug', narrow)).toBe('security');
        expect(resolve('performance', narrow)).toBe('performance');
    });
});
