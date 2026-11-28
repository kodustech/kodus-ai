import { estimateTextTokens } from '@libs/llm/token-estimate';

import {
    buildContextBlock,
    buildSystemPrompt,
    buildUserPrompt,
    DESCRIPTION_LEFT_OUT,
    fitConversationPrompt,
    fitUserPrompt,
    type ConversationThreadContext,
    type UserPromptInput,
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

    it('does not repeat a turn that the conversation record already carries', () => {
        const prompt = buildUserPrompt({
            prompt: '@kody why?',
            userLanguage: 'en-US',
            organizationAndTeamData: ORG,
            availableTools: [],
            hasSandbox: false,
            prepareContext: {
                ...THREAD,
                codeManagementContext: {
                    ...THREAD.codeManagementContext,
                    othersReplies: [
                        { historyConversationText: 'that is intentional' },
                        {
                            historyConversationText:
                                'unrelated drive-by comment',
                        },
                    ],
                },
            },
            priorTurns: [
                { role: 'user', content: 'that is intentional' },
                { role: 'assistant', content: 'Understood.' },
            ],
        });

        // Present once, attributed, in the one place the thread is rendered.
        expect(prompt.match(/that is intentional/g)).toHaveLength(1);
        expect(prompt).toContain('Developer: that is intentional');
        expect(prompt).toContain('You: Understood.');
        // A comment nobody replayed is still context worth keeping.
        expect(prompt).toContain('unrelated drive-by comment');
        // One heading for the conversation, not one per source.
        expect(prompt.match(/### Conversation so far/g)).toHaveLength(1);
        expect(prompt).not.toContain('Earlier turns');
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

// Shaped like what MCP reports for the Kodus tools — the guard spec in
// libs/mcp-server/tools pins the real declarations.
const ORG_TOOL_METADATA = {
    KODUS_FIND_MEMORIES: { readOnlyHint: true },
    KODUS_CREATE_MEMORY: {
        readOnlyHint: false,
        destructiveHint: false,
        proactiveHint: 'the developer explains a false positive',
    },
    KODUS_CREATE_KODY_RULE: {
        readOnlyHint: false,
        destructiveHint: false,
        proactiveHint: 'the developer states a standard to enforce',
    },
    KODUS_UPDATE_KODY_RULE: {
        readOnlyHint: false,
        destructiveHint: false,
        proactiveHint: 'the developer says a rule is too broad',
    },
    KODUS_DELETE_KODY_RULE: { readOnlyHint: false, destructiveHint: true },
    KODUS_CREATE_KODY_ISSUE: {
        readOnlyHint: false,
        destructiveHint: false,
        proactiveHint: 'the finding is real but out of scope for this PR',
    },
    KODUS_UPDATE_KODY_ISSUE_STATUS: {
        readOnlyHint: false,
        destructiveHint: false,
        proactiveHint: 'a tracked issue is already fixed',
    },
    KODUS_UPDATE_KODY_ISSUE_CATEGORY: {
        readOnlyHint: false,
        destructiveHint: false,
        proactiveHint: 'a finding is filed under the wrong category',
    },
    KODUS_DELETE_KODY_ISSUE: { readOnlyHint: false, destructiveHint: true },
};

const ALL_WRITE_TOOLS = Object.keys(ORG_TOOL_METADATA);

const withOrgTools = {
    availableTools: ALL_WRITE_TOOLS,
    toolMetadata: ORG_TOOL_METADATA,
};

describe('proactive actions', () => {
    it('names each bound write tool and when to offer it', () => {
        const prompt = userPrompt(withOrgTools);

        expect(prompt).toContain('KODUS_CREATE_MEMORY');
        expect(prompt).toContain('KODUS_UPDATE_KODY_RULE');
        expect(prompt).toContain('KODUS_CREATE_KODY_ISSUE');
        expect(prompt).toContain('KODUS_UPDATE_KODY_ISSUE_STATUS');
        expect(prompt).toContain('KODUS_UPDATE_KODY_ISSUE_CATEGORY');
        expect(prompt).toMatch(/false positive/i);
        expect(prompt).toMatch(/out of scope/i);
    });

    it('never advertises the destructive tools', () => {
        const prompt = userPrompt(withOrgTools);

        expect(prompt).not.toContain('KODUS_DELETE_KODY_RULE');
        expect(prompt).not.toContain('KODUS_DELETE_KODY_ISSUE');
    });

    it('offers a tool the org adds later without touching this code', () => {
        const prompt = userPrompt({
            availableTools: ['KODUS_ARCHIVE_THREAD'],
            toolMetadata: {
                KODUS_ARCHIVE_THREAD: {
                    readOnlyHint: false,
                    proactiveHint: 'the developer says the thread is settled',
                },
            },
        });

        expect(prompt).toContain('KODUS_ARCHIVE_THREAD');
        expect(prompt).toContain('the developer says the thread is settled');
    });

    it('says nothing about acting when MCP bound no write tool', () => {
        const prompt = userPrompt({
            availableTools: ['KODUS_FIND_MEMORIES'],
            toolMetadata: { KODUS_FIND_MEMORIES: { readOnlyHint: true } },
        });

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

// Review of #2793, round 3: cut from its middle, the context kept the start of
// a long PR description and lost the Kody suggestion under discussion (its
// text, hunk and suggestionId), which no tool can read again, and the
// identifiers after it.
describe('a reply under a Kody suggestion on a small slot', () => {
    const question = 'Is this really a bug? The sibling count starts at 1.';
    const reply = (descriptionLines: number): UserPromptInput => ({
        prompt: question,
        userLanguage: 'en-US',
        prepareContext: {
            pullRequest: {
                pullRequestNumber: 37,
                headRef: 'feat',
                baseRef: 'main',
            },
            repository: { id: 'r1', name: 'school' },
            platformType: 'GITHUB',
            pullRequestDescription: Array.from(
                { length: descriptionLines },
                (_, i) =>
                    `- Step ${i + 1}: the enrollment fee service reads the sibling table, applies the discount and rounds the total to two decimals.`,
            ).join('\n'),
            codeManagementContext: {
                originalComment: {
                    suggestionCommentId: 9001,
                    suggestionFilePath: 'src/enrollment/discount-lookup.ts',
                    suggestionText:
                        'The discount is applied twice when a family has two siblings.',
                    diffHunk:
                        '@@ -10,2 +10,2 @@\n-return fee;\n+return fee - fee * 0.1;',
                    suggestionId: 'sugg-7f3a',
                },
            },
        },
        organizationAndTeamData: { organizationId: 'o1', teamId: 't1' },
        availableTools: ['KODUS_FIND_MEMORIES', 'KODUS_CREATE_KODY_RULE'],
        toolMetadata: {
            KODUS_CREATE_KODY_RULE: {
                proactiveHint:
                    'the developer states a convention the team should follow on every PR',
            },
        } as never,
        hasSandbox: true,
    });
    const budget = 1_300;

    it('cuts the PR description and keeps the suggestion, the identifiers and the question', () => {
        const input = reply(40);
        const whole = buildUserPrompt(input);
        expect(estimateTokens(whole)).toBeGreaterThan(budget);
        const fitted = fitConversationPrompt(input, budget);
        expect(estimateTokens(fitted)).toBeLessThanOrEqual(budget);
        expect(fitted).toContain('suggestionId: sugg-7f3a');
        expect(fitted).toContain('The discount is applied twice');
        expect(fitted).toContain('- originalKodyCommentId: 9001');
        expect(fitted.endsWith(`USER MESSAGE:\n${question}`)).toBe(true);
        expect(fitted).toContain('- Step 1:');
        expect(fitted).toContain('…[truncated]…');
    });

    it('is what the cut of the whole context lost', () => {
        const fitted = fitUserPrompt(buildUserPrompt(reply(40)), budget);
        expect(fitted).not.toContain('suggestionId: sugg-7f3a');
    });

    it('leaves the description out, and only then cuts the rest', () => {
        const input = reply(40);
        const noDescription = buildUserPrompt({
            ...input,
            prepareContext: {
                ...input.prepareContext,
                pullRequestDescription: DESCRIPTION_LEFT_OUT,
            },
        });
        const tight = estimateTokens(noDescription);
        expect(fitConversationPrompt(input, tight)).toBe(noDescription);
        expect(fitConversationPrompt(input, tight - 1)).toBe(
            fitUserPrompt(noDescription, tight - 1),
        );
    });

    it('sends what the whole cut sends when no description fits at all', () => {
        const input = reply(40);
        const noDescription = buildUserPrompt({
            ...input,
            prepareContext: {
                ...input.prepareContext,
                pullRequestDescription: DESCRIPTION_LEFT_OUT,
            },
        });
        expect(fitConversationPrompt(input, 10)).toBe(
            fitUserPrompt(noDescription, 10),
        );
    });

    it('cuts the rest as before on a PR with no description', () => {
        const input = reply(40);
        const noDescription: UserPromptInput = {
            ...input,
            prepareContext: {
                ...input.prepareContext,
                pullRequestDescription: undefined,
            },
        };
        const whole = buildUserPrompt(noDescription);
        expect(fitConversationPrompt(noDescription, 400)).toBe(
            fitUserPrompt(whole, 400),
        );
        expect(fitConversationPrompt(noDescription, 400)).not.toBe(whole);
        const noThread = { ...input, prepareContext: undefined };
        expect(fitConversationPrompt(noThread, 200)).toBe(
            fitUserPrompt(buildUserPrompt(noThread), 200),
        );
    });

    it('leaves a prompt that fits as it is', () => {
        const input = reply(2);
        const whole = buildUserPrompt(input);
        expect(fitConversationPrompt(input, estimateTokens(whole))).toBe(whole);
    });
});

/** Counted as `fitUserPrompt` counts: the serialized message, at its worst. */
function estimateTokens(text: string): number {
    return estimateTextTokens(JSON.stringify({ role: 'user', content: text }), {
        worstCase: true,
    });
}
