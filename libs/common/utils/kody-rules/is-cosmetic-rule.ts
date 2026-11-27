import type { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * Formatting rules a linter/formatter owns. Compiling these into a detector is
 * a bad trade even when the regex is perfect: the hit is cosmetic, so its value
 * is near zero, while its cost — a review comment on someone's PR — is the
 * same as any other comment. Issue #1831 measured one such rule ("Ruby does not
 * require semicolons") producing 614 comments over 40 real PRs with not one
 * true violation among them.
 *
 * The compiler prompt asks the model to decline these itself; this list is the
 * deterministic backstop, because "is this cosmetic?" is exactly the kind of
 * judgment a weak BYOK model gets wrong, and the whole T0 safety argument rests
 * on the gate not trusting the model.
 */
const COSMETIC_RULE_PATTERNS: RegExp[] = [
    /\bsemi-?colons?\b/i,
    /\b(single|double)[- ]quot/i,
    /\bquote (style|marks)\b/i,
    /\bblank lines?\b/i,
    /\bempty lines?\b/i,
    /\btrailing (whitespace|space|comma)\b/i,
    /\bindent(ation|ing)?\b/i,
    /\bline length\b/i,
    /\bmax(imum)?[- ]len\b/i,
    /\bbrace (style|placement)\b/i,
    /\bstatements? per line\b/i,
    /\btabs? (vs\.?|or) spaces?\b/i,
];

/**
 * True when the rule is linter-owned formatting. Reads title + body: the title
 * alone is often too terse ("Semicolons"), the body alone too discursive.
 */
export function isCosmeticRule(rule: Partial<IKodyRule>): boolean {
    const text = `${rule.title ?? ''}\n${rule.rule ?? ''}`;
    return COSMETIC_RULE_PATTERNS.some((rx) => rx.test(text));
}
