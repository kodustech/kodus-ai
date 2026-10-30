import { KODY_IDENTIFIERS } from '../kody-identifiers';

/**
 * Bitbucket escapes HTML, so a suggestion there is plain markdown: the
 * `kody|code-review` chip (also how Kody recognises its own comments), a bold
 * title, the short body and a plain footer. The fix never shows in the comment;
 * it goes in a threaded reply holding the agent prompt.
 */
export function formatBitbucketSuggestionBody(params: {
    label?: string;
    severity?: string;
    title?: string | null;
    body?: string | null;
    actionStatement?: string | null;
    feedback: string;
    includeHeader?: boolean;
    includeFooter?: boolean;
}): string {
    const parts: string[] = [];
    if (params.includeHeader !== false) {
        parts.push(
            `\`${KODY_IDENTIFIERS.MARKDOWN_IDENTIFIERS.BITBUCKET}\` \`${params.label || ''}\` \`severity-level|${params.severity || ''}\``,
        );
    }
    if (params.title?.trim()) parts.push(`**${params.title.trim()}**`);
    if (params.body?.trim()) parts.push(params.body.trim());
    if (params.actionStatement?.trim()) parts.push(params.actionStatement.trim());
    if (params.includeFooter !== false) {
        parts.push(params.feedback, '```\n👍\n```', '```\n👎\n```');
    }
    return parts.join('\n\n');
}

/**
 * The threaded reply that carries the agent prompt. It opens with the Kody
 * chip so the reply-in-thread path ignores it, and never contains 👍 or 👎 so
 * it is never counted as feedback.
 */
const PROMPT_REPLY_HEADING = `\`${KODY_IDENTIFIERS.MARKDOWN_IDENTIFIERS.BITBUCKET}\` **Prompt for LLM**`;

/** True for the reply Kody posts to carry a finding's agent prompt; it is part of the finding, not an answer. */
export function isKodyPromptReply(body: string | null | undefined): boolean {
    return !!body && body.trimStart().startsWith(PROMPT_REPLY_HEADING);
}

export function formatBitbucketPromptReply(promptText: string): string {
    const text = promptText.replace(/👍|👎/g, '').trim();
    const longestRun = Math.max(
        0,
        ...(text.match(/`+/g) ?? []).map((run) => run.length),
    );
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    return `${PROMPT_REPLY_HEADING}: copy into your coding agent\n\n${fence}text\n${text}\n${fence}`;
}
