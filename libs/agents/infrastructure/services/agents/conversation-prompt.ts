/**
 * Prompt assembly for the conversation agent ("chat with Kody").
 *
 * Kept as pure functions outside the provider so the wording — which is the
 * agent's whole behavior contract — can be asserted directly instead of through
 * a mocked model.
 */
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import type { McpToolMetadata } from '../ai-sdk/mcp-tools';
import { CONVERSATION_DECISION_TOOL } from './conversation-decision';

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
            /** Stored suggestion behind the comment, when it could be resolved. */
            suggestionId?: string;
            label?: string;
            /** Kody Rules the suggestion enforced — the ids an update needs. */
            brokenKodyRulesIds?: string[];
        };
        othersReplies?: Array<{ historyConversationText?: string }>;
    };
}

export interface ConversationTurn {
    role: 'user' | 'assistant';
    content: string;
}

export interface UserPromptInput {
    /** The developer's raw message. */
    prompt: string;
    userLanguage: string;
    prepareContext?: ConversationThreadContext;
    organizationAndTeamData: OrganizationAndTeamData;
    /** Names of the tools actually bound for this run (MCP + sandbox). */
    availableTools: string[];
    /** What each bound tool declares about itself, keyed by tool name. */
    toolMetadata?: Record<string, McpToolMetadata>;
    hasSandbox: boolean;
    /** Earlier turns of this thread, oldest first. */
    priorTurns?: ConversationTurn[];
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
        toolMetadata,
        hasSandbox,
        priorTurns,
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

    const contextBlock = buildContextBlock(prepareContext, priorTurns);
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

    const proactiveBlock = buildProactiveBlock(availableTools, toolMetadata);
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
export function buildProactiveBlock(
    availableTools: string[],
    toolMetadata: Record<string, McpToolMetadata> = {},
): string {
    // A tool is offerable only if it says so itself: it carries a
    // `proactiveHint` (what reveals it) and is not flagged destructive. Nothing
    // is listed here, so adding or removing one is a change to that tool alone.
    const offers = availableTools
        .map((tool) => ({ tool, meta: toolMetadata[tool] }))
        .filter(
            (o) => o.meta?.proactiveHint && o.meta.destructiveHint !== true,
        );

    if (!offers.length) {
        return '';
    }

    return [
        'PROACTIVE ACTIONS:',
        'After you answer, judge whether this exchange produced durable signal — something that should outlive this thread. If it did, close your reply with ONE short offer to act, naming what you would do. If it did not (a greeting, a plain question, debugging chatter), just answer and offer nothing.',
        ...offers.map((o) => `- ${o.tool} — ${o.meta!.proactiveHint}`),
        `Before you finish, call ${CONVERSATION_DECISION_TOOL} exactly once to record what you intend: 'answer' when nothing here needs persisting, 'offer' when something does but the developer has not asked you to do it, or 'act' when their latest message tells you to. The tools above only become available after you declare 'act', and to declare it you must quote the developer's own words that instruct it — so you cannot act on your own reading of the exchange.`,
        'Rules:',
        '- Offer at most one action per reply, as a single closing sentence.',
        '- Default to OFFERING. Explaining a convention, disputing a finding, giving context or agreeing with you is NOT a request to act — say what you would do and stop there.',
        '- Call one of these tools ONLY when the developer\'s latest message is itself an instruction to act ("yes", "do it", "save that", "go ahead") or an explicit request ("save a memory that ..."). If you are unsure whether you were asked, you were not: offer instead.',
        '- After acting, say what you did and pass on any link or approval note the tool returned.',
        '- Earlier turns in this thread are HISTORY, already sent. Never restate an action from them as if you just performed it — only report what you did in THIS turn. If the developer asks for it again, call the tool again.',
        '- If you already offered and the developer moved on, drop it — do not offer again.',
    ].join('\n');
}

/** Same text, ignoring the whitespace and case a round trip may have changed. */
function normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
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
    priorTurns?: ConversationTurn[],
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
            ...(original.label ? [`Category: ${original.label}`] : []),
            ...(original.suggestionId
                ? [`suggestionId: ${original.suggestionId}`]
                : []),
            ...(original.brokenKodyRulesIds?.length
                ? [
                      `Kody Rules enforced by this finding (ruleId): ${original.brokenKodyRulesIds.join(', ')}`,
                  ]
                : []),
        );
    }

    // One rendering of the thread, from two sources that overlap. The record is
    // authoritative: it alone carries Kody's own replies (the PR thread strips
    // them on every platform, so an offer it made last turn survives nowhere
    // else) and it knows who said what. The thread then contributes only what
    // the record never saw — comments never addressed to Kody.
    const replayed = (priorTurns ?? []).map((t) => normalize(t.content));
    const unaddressed = (cmc?.othersReplies ?? [])
        .map((r) => r?.historyConversationText)
        .filter((t): t is string => typeof t === 'string' && t.length > 0)
        .filter((t) => !replayed.includes(normalize(t)));

    if (priorTurns?.length || unaddressed.length) {
        lines.push('', '### Conversation so far');

        if (priorTurns?.length) {
            // Quoted, not replayed as real assistant messages: replaying them
            // natively made the model read its own past "Done — memory created"
            // as something it had just done and repeat the claim without
            // calling anything.
            lines.push(
                'Reference only — these were already sent. Anything they claim you did happened in a PREVIOUS turn, not this one. Never repeat such a claim; to act now, call the tool now.',
                ...priorTurns.map(
                    (t) =>
                        `${t.role === 'assistant' ? 'You' : 'Developer'}: ${t.content}`,
                ),
            );
        }

        lines.push(...unaddressed.map((t) => `- ${t}`));
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
