import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { LLM } from '@libs/llm/llm';
import {
    prompt_replyAddressedToKody_system,
    prompt_replyAddressedToKody_user,
    replyAddressedToKodySchema,
    ReplyThreadMessage,
} from '@libs/common/utils/prompts/replyAddressedToKody';

/**
 * A reply without @kody in a thread Kody started (#1946). The code gate below
 * runs first and costs nothing; the classifier is one `LLM.run` call on the
 * org's conversation model and runs only when the gate passes.
 */

/**
 * Consecutive Kody replies to bots, with no human in between, after which Kody
 * stops answering unmentioned bot replies in that thread. Two agents that both
 * answer whoever talks to them would otherwise loop on the org's tokens.
 */
export const IMPLICIT_REPLY_BOT_CAP = 5;

/** Why an unmentioned reply got no answer. Logged on every silent exit. */
export type ImplicitReplySilence =
    | 'not_kody_thread'
    | 'kody_author'
    | 'bot_cap'
    | 'plan_blocked'
    | 'classified_no'
    | 'classifier_error';

export interface ThreadMessage extends ReplyThreadMessage {
    id: string | number;
}

const BOT_LOGIN_PATTERN = /\[bot\]$|(^|[_-])bot([_-]|$)/i;

/**
 * Bot detection from what the platform exposes: GitHub's user type, GitLab's
 * `bot` flag, and the `[bot]` / `*_bot_*` login conventions the platforms use
 * for apps and access-token users.
 */
export function isBotAuthor(author: {
    login?: string;
    type?: string;
    bot?: boolean;
}): boolean {
    if (author?.bot === true) return true;
    if (author?.type?.toLowerCase() === 'bot') return true;
    return !!author?.login && BOT_LOGIN_PATTERN.test(author.login);
}

/**
 * The free part of the decision. `thread` is oldest first and ends with the
 * reply being routed. Returns why Kody stays quiet, or undefined to go on.
 */
export function implicitReplyGate(
    thread: ThreadMessage[] | undefined,
): ImplicitReplySilence | undefined {
    if (!thread || thread.length < 2 || !thread[0].isKody) {
        return 'not_kody_thread';
    }

    const reply = thread[thread.length - 1];

    if (reply.isKody) {
        return 'kody_author';
    }

    if (
        reply.isBot &&
        kodyRepliesSinceLastHuman(thread) >= IMPLICIT_REPLY_BOT_CAP
    ) {
        return 'bot_cap';
    }

    return undefined;
}

/** Kody replies after the last human message, not counting the root. */
function kodyRepliesSinceLastHuman(thread: ThreadMessage[]): number {
    const replies = thread.slice(1, -1);
    let count = 0;

    for (let i = replies.length - 1; i >= 0; i--) {
        const message = replies[i];
        if (!message.isKody && !message.isBot) break;
        if (message.isKody) count++;
    }

    return count;
}

/**
 * Asks the org's conversation model whether the newest message is directed at
 * Kody. Throws on any model failure; the caller treats that as silence.
 */
export async function classifyReplyAddressedToKody(params: {
    thread: ThreadMessage[];
    byokConfig?: NormalizedModel;
    organizationAndTeamData: OrganizationAndTeamData;
    prNumber?: number;
    platformType?: string;
}): Promise<boolean> {
    const result = await LLM.run({
        schema: replyAddressedToKodySchema,
        system: prompt_replyAddressedToKody_system(),
        user: prompt_replyAddressedToKody_user(params.thread),
        runName: 'ChatWithKodyFromGitUseCase::classifyImplicitReply',
        organizationId: params.organizationAndTeamData?.organizationId,
        attrs: {
            prNumber: params.prNumber,
            teamId: params.organizationAndTeamData?.teamId,
            platformType: params.platformType,
        },
        byokConfig: params.byokConfig,
    });

    if (typeof result?.addressedToKody !== 'boolean') {
        throw new Error('Reply classifier returned no verdict');
    }

    return result.addressedToKody;
}
