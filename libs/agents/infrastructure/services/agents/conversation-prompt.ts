/**
 * Prompt assembly for the conversation agent ("chat with Kody").
 *
 * Kept as pure functions outside the provider so the wording — which is the
 * agent's whole behavior contract — can be asserted directly instead of through
 * a mocked model.
 */
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

/**
 * The PR comment thread the agent is answering in, as assembled by
 * `ChatWithKodyFromGitUseCase.prepareContext`. Every field is optional — the
 * agent also runs in threads that carry almost none of it.
 */
export interface ConversationThreadContext {
    gitUser?: { id?: number | string; username?: string };
    userQuestion?: string;
    platformType?: string;
    repository?: {
        id?: number | string;
        name?: string;
        fullName?: string;
        defaultBranch?: string;
    };
    pullRequestDescription?: string;
    customInstructions?: string;
    pullRequest?: {
        pullRequestNumber?: number;
        headRef?: string;
        baseRef?: string;
    };
    codeManagementContext?: {
        originalComment?: {
            suggestionCommentId?: number | string;
            suggestionFilePath?: string;
            suggestionText?: string;
            diffHunk?: string;
        };
        othersReplies?: Array<{ historyConversationText?: string }>;
    };
}

/**
 * The actions the agent may OFFER once the thread has revealed something worth
 * keeping. Read-only and destructive tools are deliberately absent: the first
 * need no offer, the second must never be proposed by the agent itself.
 */
const PROACTIVE_ACTIONS: Array<{ tool: string; when: string }> = [
    {
        tool: 'KODUS_CREATE_MEMORY',
        when: 'the developer explains a team convention, or why a finding is a false positive — record it so future reviews stop repeating it',
    },
    {
        tool: 'KODUS_CREATE_KODY_RULE',
        when: 'the developer states a standard the team wants enforced from now on, or repeats the same explanation across threads',
    },
    {
        tool: 'KODUS_UPDATE_KODY_RULE',
        when: 'the developer says an existing rule is wrong, outdated or too broad — narrow its scope or lower its severity (look the rule up first)',
    },
    {
        tool: 'KODUS_CREATE_KODY_ISSUE',
        when: 'the developer agrees the finding is real but out of scope for this PR — track it instead of losing it',
    },
    {
        tool: 'KODUS_UPDATE_KODY_ISSUE_STATUS',
        when: 'the developer says a tracked issue is already fixed or no longer relevant',
    },
    {
        tool: 'KODUS_UPDATE_KODY_ISSUE_CATEGORY',
        when: 'the developer says a finding is filed under the wrong category',
    },
];

export interface UserPromptInput {
    /** The developer's raw message. */
    prompt: string;
    userLanguage: string;
    prepareContext?: ConversationThreadContext;
    organizationAndTeamData: OrganizationAndTeamData;
    /** Names of the tools actually bound for this run (MCP + sandbox). */
    availableTools: string[];
    hasSandbox: boolean;
}

export function buildSystemPrompt(userLanguage: string): string {
    return [
        'You are Kodus, an intelligent conversation agent for user interactions.',
        'Goal: engage in natural, helpful conversations while respecting the user language preference.',
        '',
        'LANGUAGE REQUIREMENTS (NON-NEGOTIABLE):',
        `- Write your ENTIRE response in ${userLanguage}. This is the team's configured system language.`,
        `- ALWAYS reply in ${userLanguage} EVEN WHEN the user writes in a different language. NEVER mirror or switch to the language of the user's message.`,
        '- Keep the whole reply in one language; do not mix languages.',
        '- Use terminology and formatting natural to that language.',
    ].join('\n');
}

/**
 * Assemble the user turn: the conversation context (rebuilt from the PR
 * comment thread), an OPTIONAL list of available tools (memory + repo), and
 * finally the user's message. Tools are offered, never mandated — a chat
 * agent must be free to just answer.
 */
export function buildUserPrompt(input: UserPromptInput): string {
    const {
        prompt,
        userLanguage,
        prepareContext,
        organizationAndTeamData,
        availableTools,
        hasSandbox,
    } = input;

    const organizationId =
        organizationAndTeamData?.organizationId?.toString() || '';
    const teamId = organizationAndTeamData?.teamId?.toString() || '';
    const repositoryId = prepareContext?.repository?.id?.toString() || '';

    const memoryPayload = {
        organizationId,
        teamId,
        ...(repositoryId ? { repositoryId } : {}),
        limit: 20,
    };

    const sections: string[] = [];

    const contextBlock = buildContextBlock(prepareContext);
    if (contextBlock) {
        sections.push(contextBlock, '');
    }

    sections.push(
        buildIdentifiersBlock(prepareContext, organizationAndTeamData),
        '',
    );

    // Tools are OPTIONAL aids, not a mandatory pipeline. This is a chat
    // agent — forcing a tool call first (especially one that may be
    // unavailable) made the model freeze and answer nothing on trivial
    // messages like a greeting. List what's available and let it decide.
    const toolLines: string[] = [];
    if (availableTools.includes('KODUS_FIND_MEMORIES')) {
        toolLines.push(
            `- KODUS_FIND_MEMORIES — look up the user's prior context/preferences when the question would benefit from it. Payload: ${JSON.stringify(memoryPayload)}`,
        );
    }
    if (hasSandbox) {
        toolLines.push(
            '- grep / readFile / listDir / exec — search and read the repository when the user asks about code, config, or behavior. Cite file paths and line numbers when you do.',
        );
    }

    if (toolLines.length) {
        sections.push(
            '',
            'TOOLS (optional — use them only when they help you answer; for greetings or simple questions, just reply directly):',
            ...toolLines,
        );
    }

    const proactiveBlock = buildProactiveBlock(availableTools);
    if (proactiveBlock) {
        sections.push('', proactiveBlock);
    }

    sections.push(
        '',
        `Answer the user's message below directly. Write your entire answer in ${userLanguage} (the team's configured language) — do NOT switch to the language the user wrote in.`,
        '',
        'USER MESSAGE:',
        prompt,
    );

    return sections.join('\n');
}

/**
 * The posture that makes the agent more than reactive: after answering, weigh
 * whether the exchange produced durable signal and, if it did, offer the one
 * action that would persist it. Only tools MCP actually bound are named, and
 * the write itself stays behind the developer's confirmation.
 */
export function buildProactiveBlock(availableTools: string[]): string {
    const bound = new Set(availableTools);
    const offers = PROACTIVE_ACTIONS.filter((a) => bound.has(a.tool));

    if (!offers.length) {
        return '';
    }

    return [
        'PROACTIVE ACTIONS:',
        'After you answer, judge whether this exchange produced durable signal — something that should outlive this thread. If it did, close your reply with ONE short offer to act, naming what you would do. If it did not (a greeting, a plain question, debugging chatter), just answer and offer nothing.',
        ...offers.map((a) => `- ${a.tool} — ${a.when}`),
        'Rules:',
        '- Offer at most one action per reply, as a single closing sentence.',
        "- NEVER call one of these tools on your own initiative. Call one ONLY when the developer's latest message explicitly confirms an offer you made earlier in this thread, or explicitly asks you to do it.",
        '- After acting, say what you did and pass on any link or approval note the tool returned.',
        '- If you already offered and the developer moved on, drop it — do not offer again.',
    ].join('\n');
}

/**
 * The concrete ids the tools need as arguments. Without them the agent can
 * describe an action but not perform it: `KODUS_CREATE_KODY_ISSUE` alone needs
 * the repository, the platform, the PR number and the originating comment.
 */
export function buildIdentifiersBlock(
    prepareContext: ConversationThreadContext | undefined,
    organizationAndTeamData: OrganizationAndTeamData,
): string {
    const gitUser = prepareContext?.gitUser;
    const entries: Array<[string, unknown]> = [
        ['organizationId', organizationAndTeamData?.organizationId],
        ['teamId', organizationAndTeamData?.teamId],
        ['repositoryId', prepareContext?.repository?.id],
        ['repositoryName', prepareContext?.repository?.name],
        ['platformType', prepareContext?.platformType],
        ['pullRequestNumber', prepareContext?.pullRequest?.pullRequestNumber],
        [
            'originalKodyCommentId',
            prepareContext?.codeManagementContext?.originalComment
                ?.suggestionCommentId,
        ],
        [
            'filePath',
            prepareContext?.codeManagementContext?.originalComment
                ?.suggestionFilePath,
        ],
    ];

    const lines = entries
        .filter(
            ([, value]) =>
                value !== undefined && value !== null && value !== '',
        )
        .map(([key, value]) => `- ${key}: ${String(value)}`);

    if (gitUser?.username || gitUser?.id != null) {
        lines.push(
            `- developer replying: ${gitUser?.username ?? 'unknown'} (gitId ${gitUser?.id ?? 'unknown'})`,
        );
    }

    return lines.length ? ['### Identifiers', ...lines].join('\n') : '';
}

/**
 * Render the conversation context carried in `prepareContext` (the PR
 * comment thread) into the prompt. In the legacy flow this travelled as
 * `userContext.additional_information`; the AI SDK is stateless, so we make
 * it explicit here. Every field is optional — only present ones render.
 */
export function buildContextBlock(
    prepareContext?: ConversationThreadContext,
): string {
    if (!prepareContext) {
        return '';
    }

    const lines: string[] = [];
    const pr = prepareContext.pullRequest;
    const repo = prepareContext.repository;
    const cmc = prepareContext.codeManagementContext;

    if (pr?.pullRequestNumber || repo?.name) {
        const head = pr?.headRef ? ` (${pr.headRef} → ${pr?.baseRef})` : '';
        lines.push(
            `## Conversation context`,
            `Pull request #${pr?.pullRequestNumber ?? '?'}${head}` +
                (repo?.name ? ` in ${repo.name}` : ''),
        );
    }

    if (prepareContext.pullRequestDescription) {
        lines.push('', String(prepareContext.pullRequestDescription));
    }

    const original = cmc?.originalComment;
    if (original?.suggestionText) {
        lines.push(
            '',
            '### Original Kody suggestion (under discussion)',
            ...(original.suggestionFilePath
                ? [`File: ${original.suggestionFilePath}`]
                : []),
            String(original.suggestionText),
            ...(original.diffHunk
                ? ['Diff:', '```', String(original.diffHunk), '```']
                : []),
        );
    }

    const replies = cmc?.othersReplies ?? [];
    const history = replies
        .map((r) => r?.historyConversationText)
        .filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (history.length) {
        lines.push(
            '',
            '### Conversation so far',
            ...history.map((t) => `- ${t}`),
        );
    }

    if (prepareContext.customInstructions) {
        lines.push(
            '',
            '### Custom instructions',
            String(prepareContext.customInstructions),
        );
    }

    return lines.join('\n');
}
