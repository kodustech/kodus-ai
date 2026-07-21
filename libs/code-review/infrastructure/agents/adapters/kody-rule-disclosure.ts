/**
 * code-review (domain) — progressive disclosure of memory rules (team
 * conventions / Kody Rules injected into the finder's system prompt).
 *
 * Symmetric to the bounded-result decorator, but on the INPUT side: instead
 * of dumping every rule's full body into the static system prompt (which grows
 * with the rule set and dilutes attention across a long window), the prompt
 * carries a compact INDEX — every rule's title always visible, a short teaser,
 * and the full body only for rules short enough that deferring them would just
 * cost a needless round-trip. The model pulls a long rule's body on demand via
 * the `getKodyRule` tool before judging a change it might govern.
 *
 * Awareness is preserved (titles are never hidden — the agent always knows a
 * rule exists); only the verbose body of long rules is deferred. Both this
 * index and the tool key rules the same way, so a title shown in the index
 * always resolves through the tool.
 */
import type { AgentTool } from '@libs/agent-harness/domain/contracts/tool.contract';
import type { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/** Rules whose body is at most this many chars are rendered inline in the
 *  index — deferring them behind a tool call would cost a round-trip for no
 *  token saving. Longer rules show a teaser + a getKodyRule hint. */
export const INLINE_RULE_MAX_CHARS = 240;

/** Chars of a long rule's body shown as a teaser in the index. */
const TEASER_CHARS = 140;

type Rule = Partial<IKodyRule>;

function collapseWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** A rule is "long" (body deferred) when its collapsed body exceeds the inline
 *  budget. Short rules are shown in full even in progressive mode. */
function isLong(rule: Rule): boolean {
    return collapseWhitespace(rule.rule ?? '').length > INLINE_RULE_MAX_CHARS;
}

/**
 * Render the progressive index for the system prompt. Short rules appear in
 * full; long rules show a teaser and a note that the full body is a tool call
 * away. Returns '' for an empty set so callers can drop the section entirely.
 */
export function formatRulesIndex(rules?: Rule[]): string {
    if (!rules?.length) return '';

    const lines = rules.map((r, i) => {
        const n = i + 1;
        const title = r.title ?? `Rule ${n}`;
        const body = collapseWhitespace(r.rule ?? '');
        if (!isLong(r)) {
            return `- [${n}] **${title}**: ${body}`;
        }
        const teaser = body.slice(0, TEASER_CHARS).trimEnd();
        return `- [${n}] **${title}** — ${teaser}… _(call getKodyRule to read the full rule)_`;
    });

    return [
        '## Memory Rules (Team Conventions)',
        'Full text of the longer rules is available on demand — call `getKodyRule`',
        "with a rule's title or its [n] index to read the body before judging a",
        'change it may govern. Do not flag a rule violation without reading its rule.',
        '',
        ...lines,
    ].join('\n');
}

/** Resolve a free-text query to a rule: by [n]/number, then exact title
 *  (case-insensitive), then title substring, then body substring. */
export function resolveRule(rules: Rule[], query: string): Rule | undefined {
    const q = collapseWhitespace(query).toLowerCase();
    if (!q) return undefined;

    const asNum = Number(q.replace(/^\[|\]$/g, ''));
    if (Number.isInteger(asNum) && asNum >= 1 && asNum <= rules.length) {
        return rules[asNum - 1];
    }

    const byExactTitle = rules.find(
        (r) => (r.title ?? '').toLowerCase() === q,
    );
    if (byExactTitle) return byExactTitle;

    const byTitleSubstr = rules.find((r) =>
        (r.title ?? '').toLowerCase().includes(q),
    );
    if (byTitleSubstr) return byTitleSubstr;

    return rules.find((r) => (r.rule ?? '').toLowerCase().includes(q));
}

/**
 * Build the `getKodyRule` tool. Closes over the rule set (already in memory on
 * the review input — no store or I/O needed), returns a rule's full body by
 * query, or the list of available titles when nothing matches so the model can
 * retry with a valid one. Never throws.
 */
export function makeGetKodyRuleTool(rules: Rule[]): AgentTool {
    return {
        name: 'getKodyRule',
        description:
            'Read the full text of a team memory rule (Kody Rule) by its title ' +
            'or its [n] index from the Memory Rules index. Use before judging a ' +
            'change a rule may govern when only a teaser was shown.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description:
                        "A rule's title (or a distinctive part of it) or its [n] index.",
                },
            },
            required: ['query'],
        },
        async execute(input: any) {
            try {
                const query = String(input?.query ?? '');
                const match = resolveRule(rules, query);
                if (!match) {
                    const titles = rules
                        .map((r, i) => `[${i + 1}] ${r.title ?? ''}`)
                        .join('\n');
                    return {
                        output: `No rule matched "${query}". Available rules:\n${titles}`,
                        isError: true,
                    };
                }
                return {
                    output: `**${match.title ?? ''}**\n${match.rule ?? ''}`,
                };
            } catch (err: any) {
                return {
                    output: err?.message ? String(err.message) : String(err),
                    isError: true,
                };
            }
        },
    };
}
