import {
    buildContextBlock,
    buildSystemPrompt,
    buildUserPrompt,
    type ConversationThreadContext,
} from './conversation-prompt';

const ORG = { organizationId: 'org-1', teamId: 'team-1' };

const THREAD: ConversationThreadContext = {
    gitUser: { id: 7, username: 'dev-one' },
    platformType: 'GITHUB',
    repository: { id: 'repo-1', name: 'billing-api' },
    pullRequest: { pullRequestNumber: 812, headRef: 'feat/x', baseRef: 'main' },
    pullRequestDescription: 'Adds retry handling.',
    codeManagementContext: {
        originalComment: {
            suggestionCommentId: 5150,
            suggestionFilePath: 'src/worker/invoice.ts',
            suggestionText: 'Wrap the external call in a try/catch.',
        },
        othersReplies: [{ historyConversationText: 'that is intentional' }],
    },
};

const userPrompt = (
    over: Partial<Parameters<typeof buildUserPrompt>[0]> = {},
) =>
    buildUserPrompt({
        prompt: '@kody why?',
        userLanguage: 'en-US',
        prepareContext: THREAD,
        organizationAndTeamData: ORG,
        availableTools: ['KODUS_FIND_MEMORIES'],
        hasSandbox: false,
        ...over,
    });

describe('buildSystemPrompt', () => {
    it('pins the reply to the team language', () => {
        const prompt = buildSystemPrompt('pt-BR');

        expect(prompt).toContain('Write your ENTIRE response in pt-BR');
        expect(prompt).toContain('LANGUAGE REQUIREMENTS (NON-NEGOTIABLE)');
    });
});

describe('buildContextBlock', () => {
    it('renders the thread the agent is answering in', () => {
        const block = buildContextBlock(THREAD);

        expect(block).toContain(
            'Pull request #812 (feat/x → main) in billing-api',
        );
        expect(block).toContain(
            '### Original Kody suggestion (under discussion)',
        );
        expect(block).toContain('File: src/worker/invoice.ts');
        expect(block).toContain('- that is intentional');
    });

    it('renders nothing without a context', () => {
        expect(buildContextBlock(undefined)).toBe('');
    });
});

describe('buildUserPrompt', () => {
    it('carries the context, the tools and the user message', () => {
        const prompt = userPrompt();

        expect(prompt).toContain('## Conversation context');
        expect(prompt).toContain('KODUS_FIND_MEMORIES');
        expect(prompt).toContain('"repositoryId":"repo-1"');
        expect(prompt).toContain('USER MESSAGE:\n@kody why?');
    });

    it('omits the memory tool when MCP did not bind it', () => {
        expect(userPrompt({ availableTools: [] })).not.toContain(
            'KODUS_FIND_MEMORIES',
        );
    });

    it('lists the repo tools only when a sandbox is attached', () => {
        expect(userPrompt()).not.toContain('readFile');
        expect(userPrompt({ hasSandbox: true })).toContain('grep / readFile');
    });
});
