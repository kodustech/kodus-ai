import { ConfigService } from '@nestjs/config';

import { GithubService } from './github.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

/**
 * A suggestion comment reads: badges, a bold title, the short body, then the
 * fix inside a collapsed block. Code is visible only as a native committable
 * suggestion.
 */
const service = () =>
    new GithubService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        { get: jest.fn() } as unknown as ConfigService,
    );

const translations = {
    talkToKody: 'Talk to Kody by mentioning @kody',
    feedback: 'Was this suggestion helpful? React with 👍 or 👎',
};

const lineComment = (over: Record<string, any> = {}) => ({
    path: 'src/user.ts',
    start_line: 10,
    line: 12,
    body: {
        improvedCode: 'const name = user?.name;',
        suggestionContent: 'Reading name throws a 500. Guard it.',
    },
    suggestion: {
        severity: 'high',
        label: 'bug',
        language: 'typescript',
        oneSentenceSummary: 'User can be null when the account was deleted',
        llmPrompt:
            'User can be null when the account was deleted\n\nThe whole explanation.',
    },
    ...over,
});

const inline = (lc: any, copyPrompt = true, committable = false) =>
    service().formatBodyForGitHub(
        lc,
        { language: 'typescript' },
        translations,
        copyPrompt,
        committable,
    );

describe('GithubService.formatBodyForGitHub', () => {
    it('renders badges, the bold title, the body, then the collapsed agent prompt', () => {
        const body = inline(lineComment());

        const title = body.indexOf('**User can be null when the account was deleted**');
        const text = body.indexOf('Reading name throws a 500. Guard it.');
        const prompt = body.indexOf('<summary>Prompt for LLM</summary>');
        expect(body.indexOf('![kody code-review]')).toBe(0);
        expect(title).toBeGreaterThan(0);
        expect(text).toBeGreaterThan(title);
        expect(prompt).toBeGreaterThan(text);
        expect(body).toContain(
            'File src/user.ts, lines 10-12:\n\nUser can be null when the account was deleted\n\nThe whole explanation.\n\nSuggested code:\n\nconst name = user?.name;',
        );
        expect(body).toContain('<!-- kody-codereview -->');
    });

    it('shows no code outside the collapsed block', () => {
        const body = inline(lineComment());
        const outside = body.replace(/<details>[\s\S]*?<\/details>/g, '');

        expect(outside).not.toContain('```');
    });

    it('keeps the fix in a collapsed "Suggested fix" when the agent prompt is off', () => {
        const body = inline(lineComment(), false);

        expect(body).not.toContain('Prompt for LLM');
        expect(body).toContain(
            '<summary>Suggested fix</summary>\n\n````typescript\nconst name = user?.name;\n````',
        );
    });

    it('keeps a committable fix as a visible native suggestion', () => {
        const body = inline(
            lineComment({
                suggestion: {
                    ...lineComment().suggestion,
                    isCommittable: true,
                    validatedData: { code: 'const name = user?.name;', lineStart: 10, lineEnd: 12 },
                },
            }),
            true,
            true,
        );

        expect(body).toContain('```suggestion\nconst name = user?.name;\n```');
    });
});

describe('GithubService.formatReviewCommentBody (PR-level)', () => {
    const prLevel = {
        severity: 'high',
        label: 'kody_rules',
        oneSentenceSummary: 'PR description has no ticket reference',
        suggestionContent: 'Add the ticket ID.',
        fullExplanation: 'The rule requires a ticket ID like ABC-123 in the description.',
    };

    it('renders the title and builds the agent prompt from the full explanation', async () => {
        const body = await service().formatReviewCommentBody({
            suggestion: prLevel,
            repository: { name: 'repo', language: 'typescript' },
            includeHeader: true,
            includeFooter: false,
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            suggestionCopyPrompt: true,
        });

        expect(body).toContain('**PR description has no ticket reference**\n\nAdd the ticket ID.');
        expect(body).toContain('<summary>Prompt for LLM</summary>');
        expect(body).toContain(
            'PR description has no ticket reference\n\nThe rule requires a ticket ID like ABC-123 in the description.',
        );
    });
});
