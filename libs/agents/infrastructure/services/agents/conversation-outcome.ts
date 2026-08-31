/**
 * Makes the links in a reply match what the tools actually returned.
 *
 * The model narrates: told to act, it will sometimes write "Done — saved it"
 * and quote a link on a turn where it called nothing, and the prose itself
 * cannot be checked (replies are written in the team's configured language).
 * The links can be. Every app link in the reply is replaced with one a tool
 * really returned this turn, in order; any left over is removed. The reply
 * still reads as it always did — the bot pastes a link — except the link is
 * now guaranteed to be real. What ran is recorded in the logs, not shown to
 * the developer.
 */
import type { WriteToolEvent } from './conversation-tool-audit';

/**
 * Links into the Kody app — the ones a write tool hands back. The character
 * class stops at quotes, backslashes and brackets so a link lifted out of a
 * JSON envelope does not drag the envelope along with it.
 */
const LINK_CHAR = String.raw`[^\s"'\\<>)\]}]`;
const APP_LINK_SOURCE = `https?://${LINK_CHAR}*/(?:kody-rules|kody-issues|memories)/${LINK_CHAR}*`;

/** A markdown link first, so its text can be kept when the url goes. */
const ANY_APP_LINK = new RegExp(
    String.raw`\[([^\]]*)\]\(\s*${APP_LINK_SOURCE}\s*\)|${APP_LINK_SOURCE}`,
    'gi',
);

/**
 * Pull the link a Kodus MCP tool returned. Matched out of the raw result rather
 * than read from a known field: MCP results arrive in whatever envelope the
 * server used (`{data:{link}}`, a `content[].text` blob, a PR url), and a link
 * the developer can click matters more than the shape it travelled in.
 */
function linkOf(event: WriteToolEvent): string | undefined {
    if (event.error || typeof event.result !== 'string') {
        return undefined;
    }

    return event.result.match(new RegExp(APP_LINK_SOURCE, 'i'))?.[0];
}

/** Remove app links from the model's own prose, keeping any link text. */
export function stripToolLinks(text: string): string {
    return tidy(
        text.replace(ANY_APP_LINK, (_m, label?: string) => label ?? ''),
    );
}

function tidy(text: string): string {
    return text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([.,;:!?])/g, '$1')
        .trimEnd();
}

/**
 * The reply the developer sees: the model's own words, with every app link
 * replaced by one a tool actually returned this turn. Links beyond what ran are
 * dropped, so a fabricated one cannot reach a developer.
 */
export function withVerifiedOutcome(
    reply: string,
    events: readonly WriteToolEvent[],
): string {
    const links = events
        .map(linkOf)
        .filter((link): link is string => Boolean(link));

    let used = 0;
    const verified = reply.replace(ANY_APP_LINK, (_match, label?: string) => {
        const link = links[used++];
        if (!link) {
            return label ?? '';
        }
        return label ? `[${label}](${link})` : link;
    });

    return tidy(verified);
}
