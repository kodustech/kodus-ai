/**
 * Makes the reply's account of what happened match what actually happened.
 *
 * The model narrates: told to act, it will sometimes write "Done — saved it"
 * (and quote a link) on a turn where it called nothing. The prose cannot be
 * checked — replies are written in the team's configured language — so the
 * claim is corrected structurally instead: app links are stripped from the
 * model's text and a footer built from the real tool results is appended. What
 * the developer clicks is then always something a tool returned.
 */
import type { WriteToolEvent } from './conversation-tool-audit';

/** Links into the Kody app — the ones a write tool hands back. */
const APP_LINK = /https?:\/\/\S*\/(?:kody-rules|kody-issues|memories)\/\S*/gi;

/**
 * Pull the link a Kodus MCP tool returned. Matched out of the raw result rather
 * than read from a known field: MCP results arrive in whatever envelope the
 * server used (`{data:{link}}`, a `content[].text` blob, a PR url), and a link
 * the developer can click matters more than the shape it travelled in.
 */
function linkOf(event: WriteToolEvent): string | undefined {
    if (typeof event.result !== 'string') {
        return undefined;
    }

    const found = event.result.match(new RegExp(APP_LINK.source, 'i'));
    return found?.[0]?.replace(/[\\"',)\]}]+$/, '');
}

/**
 * The turn's real record: one line per write, with the link the tool returned.
 * Deliberately language-neutral (tool name + URL) — the reply is written in the
 * team's language and a translated footer would be one more thing to get wrong.
 */
export function buildOutcomeFooter(events: readonly WriteToolEvent[]): string {
    if (!events.length) {
        return '';
    }

    const lines = events.map((event) => {
        if (event.error) {
            return `- ❌ ${event.tool} — ${event.error}`;
        }
        const link = linkOf(event);
        return `- ✅ ${event.tool}${link ? ` — ${link}` : ''}`;
    });

    return ['', '---', ...lines].join('\n');
}

/** Remove app links from the model's own prose. */
export function stripToolLinks(text: string): string {
    return text.replace(APP_LINK, '').replace(/[ \t]+\n/g, '\n');
}

/**
 * The reply the developer sees: the model's words with its links removed, then
 * the verified footer. A fabricated link cannot survive, and a claimed action
 * with no footer under it is visibly unsupported.
 */
export function withVerifiedOutcome(
    reply: string,
    events: readonly WriteToolEvent[],
): string {
    const stripped = stripToolLinks(reply).trimEnd();
    const footer = buildOutcomeFooter(events);

    return footer ? `${stripped}\n${footer}` : stripped;
}
