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

    it('names the rule behind the finding so it can be updated', () => {
        const block = buildContextBlock({
            ...THREAD,
            codeManagementContext: {
                ...THREAD.codeManagementContext,
                originalComment: {
                    ...THREAD.codeManagementContext!.originalComment,
                    suggestionId: 'sug-9',
                    label: 'kody_rules',
                    brokenKodyRulesIds: ['rule-abc', 'rule-def'],
                },
            },
        });

        expect(block).toContain('kody_rules');
        expect(block).toContain('rule-abc');
        expect(block).toContain('rule-def');
        expect(block).toContain('sug-9');
    });

    it('renders nothing without a context', () => {
        expect(buildContextBlock(undefined)).toBe('');
    });
});

describe('identifiers', () => {
    it('exposes every id a write tool needs to be callable', () => {
        const prompt = userPrompt();

        expect(prompt).toContain('organizationId: org-1');
        expect(prompt).toContain('teamId: team-1');
        expect(prompt).toContain('repositoryId: repo-1');
        expect(prompt).toContain('platformType: GITHUB');
        expect(prompt).toContain('pullRequestNumber: 812');
        expect(prompt).toContain('originalKodyCommentId: 5150');
        expect(prompt).toContain('dev-one');
        expect(prompt).toContain('7');
    });

    it('renders only the ids the thread actually carries', () => {
        const prompt = userPrompt({ prepareContext: undefined });

        expect(prompt).toContain('organizationId: org-1');
        expect(prompt).not.toContain('platformType:');
        expect(prompt).not.toContain('repositoryId:');
    });
});

const ALL_WRITE_TOOLS = [
    'KODUS_FIND_MEMORIES',
    'KODUS_CREATE_MEMORY',
    'KODUS_CREATE_KODY_RULE',
    'KODUS_UPDATE_KODY_RULE',
    'KODUS_DELETE_KODY_RULE',
    'KODUS_CREATE_KODY_ISSUE',
    'KODUS_UPDATE_KODY_ISSUE_STATUS',
    'KODUS_UPDATE_KODY_ISSUE_CATEGORY',
    'KODUS_DELETE_KODY_ISSUE',
];

describe('proactive actions', () => {
    it('names each bound write tool and when to offer it', () => {
        const prompt = userPrompt({ availableTools: ALL_WRITE_TOOLS });

        expect(prompt).toContain('KODUS_CREATE_MEMORY');
        expect(prompt).toContain('KODUS_UPDATE_KODY_RULE');
        expect(prompt).toContain('KODUS_CREATE_KODY_ISSUE');
        expect(prompt).toContain('KODUS_UPDATE_KODY_ISSUE_STATUS');
        expect(prompt).toContain('KODUS_UPDATE_KODY_ISSUE_CATEGORY');
        expect(prompt).toMatch(/false positive/i);
        expect(prompt).toMatch(/out of scope/i);
    });

    it('tells the agent to evaluate whether the exchange is worth persisting', () => {
        const prompt = userPrompt({ availableTools: ALL_WRITE_TOOLS });

        expect(prompt).toMatch(/durable/i);
        expect(prompt).toMatch(/offer/i);
    });

    it('keeps the write path opt-in behind the developer confirmation', () => {
        const prompt = userPrompt({ availableTools: ALL_WRITE_TOOLS });

        expect(prompt).toMatch(/NEVER call/);
        expect(prompt).toMatch(/confirm/i);
    });

    it('never advertises the destructive tools', () => {
        const prompt = userPrompt({ availableTools: ALL_WRITE_TOOLS });

        expect(prompt).not.toContain('KODUS_DELETE_KODY_RULE');
        expect(prompt).not.toContain('KODUS_DELETE_KODY_ISSUE');
    });

    it('says nothing about acting when MCP bound no write tool', () => {
        const prompt = userPrompt({ availableTools: ['KODUS_FIND_MEMORIES'] });

        expect(prompt).not.toMatch(/PROACTIVE ACTIONS/);
        expect(prompt).not.toContain('KODUS_CREATE_MEMORY');
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
