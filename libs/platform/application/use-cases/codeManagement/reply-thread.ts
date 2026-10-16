import { KODY_IDENTIFIERS } from '@libs/common/utils/kody-identifiers';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { LLM_TASK } from '@libs/llm/byok-config';
import type { NormalizedModel } from '@libs/llm/byok-config';

import {
    classifyReplyAddressedToKody,
    isBotAuthor,
    ThreadMessage,
} from './implicit-reply';

/**
 * How ChatWithKodyFromGitUseCase reads a PR thread for a reply without @kody
 * (#1946): which comments are Kody's, the reply's thread as the classifier sees
 * it, and the classifier on the org's conversation model. The use case and the
 * reply-addressing eval (evals/reply-addressing) both run these.
 */

/** Posted by Kody right after a mention, before it answers. */
export const KODY_ACKNOWLEDGMENT_MESSAGE = 'Analyzing your request...';

/**
 * Posted instead of running the agent when the org may not use Kodus-funded
 * LLM calls (cloud, past trial, no BYOK). A visible pointer beats silence:
 * without it the dev reads the missing reply as Kody being broken.
 */
export const CONVERSATION_PLAN_GATE_MESSAGE =
    "I can't reply right now: your organization's trial has ended and no " +
    'LLM API key (BYOK) is configured. Connect your key in the Kodus ' +
    'settings to keep chatting with Kody.';

/** The fields of a platform comment this module reads. */
export interface ThreadComment {
    id: number;
    body: string;
    in_reply_to_id?: number;
    parent?: { id: number };
    thread?: any;
    user?: { login?: string; type?: string };
    author?: {
        name?: string;
        username?: string;
        bot?: boolean;
        type?: string;
    };
    discussionId?: string;
    discussion_id?: string;
    system?: boolean;
    createdAt?: string;
    created_at?: string;
}

/**
 * Texts Kody posts with no marker on Bitbucket, where raw HTML would show.
 * There Kody often posts through the customer's own account, so without
 * this its "Analyzing your request..." acknowledgment reads as a new human
 * reply in its thread and gets answered.
 */
export function isKodyFixedMessage(body: string): boolean {
    const text = (body ?? '').replace(/[​\s]+$/u, '').trim();
    return (
        text === KODY_ACKNOWLEDGMENT_MESSAGE ||
        text === CONVERSATION_PLAN_GATE_MESSAGE
    );
}

export function isKodyComment(
    comment: ThreadComment,
    platformType: PlatformType,
): boolean {
    const login =
        platformType === PlatformType.GITHUB
            ? comment.user?.login
            : comment.author?.name;
    const body = comment.body.toLowerCase();
    const bodyWithoutMarkdown =
        platformType !== PlatformType.BITBUCKET
            ? KODY_IDENTIFIERS.MARKDOWN_IDENTIFIERS.DEFAULT
            : KODY_IDENTIFIERS.MARKDOWN_IDENTIFIERS.BITBUCKET;

    return (
        KODY_IDENTIFIERS.LOGIN_KEYWORDS.some((keyword) =>
            login?.includes(keyword),
        ) ||
        body.includes(bodyWithoutMarkdown) ||
        isKodyFixedMessage(comment.body)
    );
}

/**
 * The reply's thread, oldest first, ending at the reply itself. Undefined
 * when the comment is not a reply or its thread cannot be rebuilt from what
 * the platform returned (Bitbucket Data Center carries no parent link).
 */
export function buildReplyThread(
    comment: ThreadComment,
    allComments: ThreadComment[],
    platformType: PlatformType,
): ThreadMessage[] | undefined {
    const comments = allComments ?? [];
    let members: ThreadComment[];

    switch (platformType) {
        case PlatformType.GITHUB: {
            // GitHub points every reply at the thread's first comment.
            const rootId = comment.in_reply_to_id;
            if (!rootId) return undefined;
            members = comments.filter(
                (c) => c.id === rootId || c.in_reply_to_id === rootId,
            );
            break;
        }
        case PlatformType.GITLAB: {
            const discussionId = comment.discussionId;
            if (!discussionId) return undefined;
            members = comments.filter(
                (c) =>
                    (c.discussionId ?? c.discussion_id) === discussionId &&
                    !c.system,
            );
            break;
        }
        case PlatformType.BITBUCKET: {
            if (!comment.parent?.id) return undefined;
            const byId = new Map(comments.map((c) => [c.id, c]));
            const rootOf = (c: ThreadComment) => {
                let current = c;
                const seen = new Set<number>();
                while (current?.parent?.id && !seen.has(current.id)) {
                    seen.add(current.id);
                    const parent = byId.get(current.parent.id);
                    if (!parent) break;
                    current = parent;
                }
                return current?.id;
            };
            const rootId = rootOf(comment);
            members = comments.filter((c) => rootOf(c) === rootId);
            break;
        }
        case PlatformType.AZURE_REPOS: {
            const thread = comment.thread;
            if (!thread) return undefined;
            members = [thread, ...(thread.replies ?? [])];
            break;
        }
        default:
            return undefined;
    }

    const ordered = [...members].sort(
        (a, b) =>
            new Date(a.createdAt ?? a.created_at ?? 0).getTime() -
            new Date(b.createdAt ?? b.created_at ?? 0).getTime(),
    );
    const replyIndex = ordered.findIndex((c) => c.id === comment.id);
    if (replyIndex < 0) return undefined;

    return ordered.slice(0, replyIndex + 1).map((c) => {
        const login =
            platformType === PlatformType.GITHUB
                ? c.user?.login
                : (c.author?.username ?? c.author?.name);

        return {
            id: c.id,
            author:
                platformType === PlatformType.GITHUB
                    ? c.user?.login
                    : (c.author?.name ?? c.author?.username),
            isKody: isKodyComment({ ...c, body: c.body ?? '' }, platformType),
            isBot: isBotAuthor({
                login,
                type: c.user?.type ?? c.author?.type,
                bot: c.author?.bot,
            }),
            body: c.body ?? '',
        };
    });
}

/**
 * Whether an unmentioned reply is meant for Kody: the classifier on the model
 * the org routes the conversation task to. Throws on any failure; the caller
 * treats that as silence.
 */
export async function classifyImplicitReply(params: {
    thread: ThreadMessage[];
    permissionValidationService: {
        resolveTaskSlot(
            organizationAndTeamData: OrganizationAndTeamData,
            task: (typeof LLM_TASK)[keyof typeof LLM_TASK],
        ): Promise<NormalizedModel | null | undefined>;
    };
    organizationAndTeamData: OrganizationAndTeamData;
    prNumber: number;
    platformType: PlatformType;
}): Promise<boolean> {
    const byokConfig =
        (await params.permissionValidationService.resolveTaskSlot(
            params.organizationAndTeamData,
            LLM_TASK.conversation,
        )) ?? undefined;

    return classifyReplyAddressedToKody({
        thread: params.thread,
        byokConfig,
        organizationAndTeamData: params.organizationAndTeamData,
        prNumber: params.prNumber,
        platformType: params.platformType,
    });
}
