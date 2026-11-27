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
const FORMATTING_DIRECTIVE =
    /^(?:(?:always|never|do not|don't)\s+)?(?:use|avoid|prefer|require|omit|remove|trim|leave|keep|enforce|write|limit|no)\s+/i;

const FORMATTING_SUBJECTS = [
    /^(?:unnecessary |trailing )?semi-?colons?(?: at the end of (?:each |every )?(?:lines?|statements?))?$/i,
    /^(?:(?:single|double)[- ](?:quotes?|quoted strings?)|quote (?:style|marks))(?: for (?:strings?|attribute values))?$/i,
    /^(?:(?:one|two|\d+) )?(?:extra |consecutive )?(?:blank|empty) lines?(?: between (?:functions|methods|classes|statements))?$/i,
    /^trailing (?:whitespace|spaces?|commas?)(?: at the end of (?:each )?lines?)?$/i,
    /^(?:indentation|indent(?:ing)? with (?:tabs|spaces|(?:two|four|\d+) spaces)|(?:two|four|\d+) spaces for indentation)(?:, never tabs)?$/i,
    /^(?:(?:maximum |max[- ])?line length|max(?:imum)?[- ]len)(?: (?:to|under|of|at most) \d+(?: characters)?)?$/i,
    /^brace (?:style|placement)$/i,
    /^(?:(?:one|a single|1) )?statements? per line$/i,
    /^tabs? (?:vs\.?|or|instead of) spaces?$/i,
];

function hasFormattingSubject(text?: string): boolean {
    // A later example or a formatting term inside a security instruction
    // doesn't establish the rule's subject. Defer ambiguous prose to the model.
    const instruction = (text ?? '').trim().split(/[!?\n]|\.(?:\s|$)/, 1)[0];
    const subject = instruction
        .trim()
        .replace(FORMATTING_DIRECTIVE, '')
        .replace(/\s+in (?:[\w+#-]+ )?files?$/i, '');
    return FORMATTING_SUBJECTS.some((pattern) => pattern.test(subject));
}

export function isCosmeticRule(
    rule: Partial<Pick<IKodyRule, 'title' | 'rule'>>,
): boolean {
    return hasFormattingSubject(rule.title) || hasFormattingSubject(rule.rule);
}
