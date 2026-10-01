import { GitlabService } from '@libs/platform/infrastructure/adapters/services/gitlab.service';
import { AzureReposService } from '@libs/platform/infrastructure/adapters/services/azureRepos/azureRepos.service';
import { ForgejoService } from '@libs/platform/infrastructure/adapters/services/forgejo.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

/**
 * Every host renders a suggestion the same way: badges, a bold title, the
 * short body, then the fix inside a collapsed block. No code is visible
 * outside that block (Azure's 👍/👎 vote blocks are not code).
 */
const translations = {
    talkToKody: 'Talk to Kody by mentioning @kody',
    feedback: 'Was this suggestion helpful? React with 👍 or 👎',
};

const lineComment = {
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
};

const hosts: Array<[string, any, string]> = [
    ['GitLab', GitlabService, 'formatBodyForGitLab'],
    ['Azure Repos', AzureReposService, 'formatBodyForAzure'],
    ['Forgejo', ForgejoService, 'formatBodyForForgejo'],
];

const visibleCode = (body: string) =>
    body
        .replace(/<details>[\s\S]*?<\/details>/g, '')
        .replace(/```\n(👍|👎)\n```/g, '');

describe.each(hosts)('%s inline suggestion body', (_name, Service, method) => {
    const render = (copyPrompt: boolean) =>
        Object.create(Service.prototype)[method](
            lineComment,
            { language: 'typescript' },
            translations,
            copyPrompt,
        ) as string;

    it('puts the bold title before the body and the collapsed agent prompt after it', () => {
        const body = render(true);

        const title = body.indexOf('**User can be null when the account was deleted**');
        expect(title).toBeGreaterThan(0);
        expect(body.indexOf('Reading name throws a 500. Guard it.')).toBeGreaterThan(title);
        expect(body).toContain('<summary>Prompt for LLM</summary>');
        expect(body).toContain('Suggested code:\n\nconst name = user?.name;');
        expect(body).toContain('<!-- kody-codereview -->');
    });

    it('shows no code outside the collapsed block', () => {
        expect(visibleCode(render(true))).not.toContain('```');
    });

    it('falls back to a collapsed "Suggested fix" when the agent prompt is off', () => {
        const body = render(false);

        expect(body).not.toContain('Prompt for LLM');
        expect(body).toContain('<summary>Suggested fix</summary>');
        expect(visibleCode(body)).not.toContain('```');
    });
});

describe.each([
    ['GitLab', GitlabService],
    ['Azure Repos', AzureReposService],
])('%s PR-level suggestion body', (_name, Service) => {
    it('renders the title and the agent prompt from the full explanation', async () => {
        const body: string = await Object.create(
            (Service as any).prototype,
        ).formatReviewCommentBody({
            suggestion: {
                severity: 'high',
                label: 'kody_rules',
                oneSentenceSummary: 'PR description has no ticket reference',
                suggestionContent: 'Add the ticket ID.',
                fullExplanation: 'The rule requires a ticket ID like ABC-123.',
            },
            repository: { name: 'repo', language: 'typescript' },
            includeHeader: true,
            includeFooter: false,
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            suggestionCopyPrompt: true,
        });

        expect(body).toContain('**PR description has no ticket reference**\n\nAdd the ticket ID.');
        expect(body).toContain(
            'PR description has no ticket reference\n\nThe rule requires a ticket ID like ABC-123.',
        );
    });
});
