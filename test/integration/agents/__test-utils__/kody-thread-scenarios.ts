/**
 * PR-thread scenarios where the conversation hands Kody an obvious action.
 *
 * Each scenario is a realistic `@kody` reply thread plus the write tool Kody
 * should offer once it has answered. Shared by the deterministic repro spec
 * (`kody-proactive-actions.integration.spec.ts`) and available to an
 * LLM-in-the-loop eval that judges the reply text itself.
 *
 * Reference: https://github.com/kodustech/kodus-ai/issues/1761
 */

export interface ThreadScenario {
    id: string;
    /** What the thread reveals, in one line. */
    signal: string;
    /** The developer's `@kody` message that triggers the turn. */
    userMessage: string;
    /** The write tool Kody should offer; null when it should stay quiet. */
    expectedOffer: string | null;
    prepareContext: Record<string, unknown>;
}

const ORG = {
    organizationId: 'org-11111111',
    teamId: 'team-22222222',
};

const REPOSITORY = {
    id: 'repo-33333333',
    name: 'billing-api',
    fullName: 'acme/billing-api',
};

const GIT_USER = { id: 44444444, username: 'dev-one' };

function thread(params: {
    userMessage: string;
    suggestionText: string;
    suggestionFilePath?: string;
    replies?: string[];
    suggestionCommentId?: number;
}): Record<string, unknown> {
    return {
        gitUser: GIT_USER,
        userQuestion: params.userMessage,
        platformType: 'GITHUB',
        repository: { ...REPOSITORY, defaultBranch: 'main' },
        pullRequestDescription: 'Adds retry handling to the invoice worker.',
        pullRequest: {
            pullRequestNumber: 812,
            headRef: 'feat/invoice-retry',
            baseRef: 'main',
        },
        codeManagementContext: {
            originalComment: {
                suggestionCommentId: params.suggestionCommentId ?? 5150,
                suggestionFilePath:
                    params.suggestionFilePath ?? 'src/worker/invoice.ts',
                suggestionText: params.suggestionText,
                diffHunk:
                    '@@ -12,6 +12,9 @@\n+    await retry(() => this.charge(invoice), { attempts: 3 });',
            },
            othersReplies: (params.replies ?? []).map((body) => ({
                historyConversationText: body,
            })),
        },
    };
}

export const ORGANIZATION_AND_TEAM_DATA = ORG;
export const THREAD_REPOSITORY = REPOSITORY;
export const THREAD_GIT_USER = GIT_USER;

export const THREAD_SCENARIOS: ThreadScenario[] = [
    {
        id: 'false-positive-on-kody-rule',
        signal: 'developer explains why a Kody Rule finding does not apply here',
        userMessage:
            '@kody this is a false positive — the retry wrapper already swallows the transient error, so the extra try/catch the rule asks for would just hide real failures.',
        expectedOffer: 'KODUS_CREATE_MEMORY',
        prepareContext: thread({
            userMessage: 'false positive',
            suggestionText:
                '![kody_rules](shield) Wrap the external call in a try/catch so transient failures are handled explicitly.',
        }),
    },
    {
        id: 'team-convention-stated',
        signal: 'developer states a durable team convention',
        userMessage:
            '@kody we always keep the raw provider payload on the entity in this module — it is intentional, downstream reconciliation reads it.',
        expectedOffer: 'KODUS_CREATE_MEMORY',
        prepareContext: thread({
            userMessage: 'team convention',
            suggestionText:
                'Avoid persisting untyped provider payloads on the entity.',
        }),
    },
    {
        id: 'rule-too-broad',
        signal: 'developer says the rule itself is too broad',
        userMessage:
            '@kody the rule fires on every file, but it should only apply to controllers. It is too broad as written.',
        expectedOffer: 'KODUS_UPDATE_KODY_RULE',
        prepareContext: thread({
            userMessage: 'rule too broad',
            suggestionText:
                '![kody_rules](shield) Validate the request body before using it.',
        }),
    },
    {
        id: 'real-but-out-of-scope',
        signal: 'developer agrees the finding is real but out of scope for this PR',
        userMessage:
            '@kody good catch, but that refactor is out of scope for this PR — it belongs to the billing cleanup.',
        expectedOffer: 'KODUS_CREATE_KODY_ISSUE',
        prepareContext: thread({
            userMessage: 'out of scope',
            suggestionText:
                'The invoice worker duplicates the charge logic already in BillingService.',
        }),
    },
    {
        id: 'already-fixed',
        signal: 'developer says the issue is already fixed elsewhere',
        userMessage:
            '@kody this was already fixed in the previous release, the open Kody issue for it is stale.',
        expectedOffer: 'KODUS_UPDATE_KODY_ISSUE_STATUS',
        prepareContext: thread({
            userMessage: 'already fixed',
            suggestionText: 'Unhandled promise rejection in the retry path.',
        }),
    },
    {
        id: 'miscategorized-finding',
        signal: 'developer says the finding is filed under the wrong category',
        userMessage:
            '@kody this is not a performance problem, it is an error-handling one — the category is wrong.',
        expectedOffer: 'KODUS_UPDATE_KODY_ISSUE_CATEGORY',
        prepareContext: thread({
            userMessage: 'miscategorized',
            suggestionText: 'Avoid awaiting inside the loop.',
        }),
    },
    {
        id: 'no-durable-signal',
        signal: 'plain question — nothing worth persisting',
        userMessage: '@kody what does this diff do?',
        expectedOffer: null,
        prepareContext: thread({
            userMessage: 'what does this do',
            suggestionText: 'Consider extracting the retry helper.',
        }),
    },
];

/**
 * Second turn of the false-positive thread: Kody offered to record a memory and
 * the developer accepted. The offer lives only in the conversation record — the
 * PR thread history strips Kody's own replies on every platform.
 */
export const CONFIRMATION_TURN = {
    scenarioId: 'false-positive-on-kody-rule',
    priorOffer:
        'Want me to record that as a memory so this rule stops flagging the retry wrapper?',
    userMessage: '@kody yes please, record it',
};
