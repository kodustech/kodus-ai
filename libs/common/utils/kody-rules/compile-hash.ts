import { createHash } from 'crypto';

/**
 * The fingerprint of everything the detector compiler's DECISION depends on.
 *
 * Why this exists (and why it is not just the rule text): the nightly sweep
 * decided what to compile by asking "does this rule have a detector yet?", and
 * a rule the compiler DECLINES never gets one. Declining is the normal outcome
 * — 816 of 10.918 active rules in production carry a detector, so 92,5% are
 * declined — which made every one of them eligible again the next night, and
 * the night after that, forever. The sweep's own docblock promises that "only
 * rules created since the last pass do any LLM work"; without a record of the
 * attempt there is nothing for that promise to rest on, and the fleet was
 * re-decided in a loop at the customer's expense (BYOK: their key, their bill).
 *
 * So the marker records the ATTEMPT, not the outcome, and this is its key.
 *
 * It covers the rule text AND the examples because the examples are the compile
 * gate: the same text with a different `incorrect` snippet can flip a rule from
 * compiled to declined. Same shape as `atomsHashOf` in the summary service, and
 * for the same reason — deliberately identical so the two cannot drift into
 * disagreeing about what "this rule changed" means.
 */
export function ruleCompileHash(rule: {
    rule?: string;
    examples?: unknown[];
}): string {
    return createHash('sha256')
        .update(`${rule?.rule ?? ''} ${JSON.stringify(rule?.examples ?? [])}`)
        .digest('hex');
}

/**
 * True when the compiler already ran on exactly this rule text and examples, so
 * running it again can only spend a model call to reach the same conclusion.
 *
 * A rule whose attempt ERRORED is not recorded at all (see the compiler
 * service), so a transient failure never freezes a rule out of compilation.
 */
export function compileAttemptIsCurrent(rule: {
    rule?: string;
    examples?: unknown[];
    compileAttempt?: { sourceHash?: string };
}): boolean {
    const stored = rule?.compileAttempt?.sourceHash;
    return !!stored && stored === ruleCompileHash(rule);
}

/**
 * Version of the CLASSIFICATION the context-need prompt produces.
 *
 * A stored `contextNeed` is a function of two things: the rule's text and the
 * prompt that classified it. The gate only ever hashed the first, so a rule
 * nobody edited kept the verdict of whatever prompt was live when it was first
 * seen — forever.
 *
 * That was invisible until the prompt was WRONG. It used to tell the classifier
 * "the reviewer sees the changed lines AND the complete file they live in", so
 * "no unused imports", "functions must not exceed 40 lines" and "every class has
 * a docstring" were all answered `diff-only`. They are not: the judge sees a
 * hunk. Every rule of that family in the installed base carries that verdict,
 * and without this version in the key not one of them would ever be asked again
 * — the fix would reach only rules created after the deploy.
 *
 * BUMP THIS WHENEVER THE CONTEXT-NEED PROMPT CHANGES MEANING. Doing so re-infers
 * the fleet exactly ONCE, on the next sweep; leaving it alone keeps the fleet
 * frozen. The cost is real and it lands on the customer's BYOK key, so it is a
 * deliberate decision, not a side effect of editing a sentence.
 *
 *   1 — the original prompt: claimed the judge sees the whole file.
 *   2 — issue #1826: the judge sees the hunk; `full-file` is a declarable need.
 */
export const CONTEXT_NEED_PROMPT_VERSION = 2;

/**
 * Key for a stored context need: the rule text plus the classifier's version.
 *
 * Examples are deliberately NOT in here, unlike `ruleCompileHash`. They gate
 * whether a regex can be compiled; they do not change what the rule needs to
 * SEE, so including them would re-spend a model call every time an author added
 * a snippet.
 */
export function ruleContextNeedHash(rule: { rule?: string }): string {
    return createHash('sha256')
        .update(`v${CONTEXT_NEED_PROMPT_VERSION} ${rule?.rule ?? ''}`)
        .digest('hex');
}

/**
 * True when the stored context need was produced by the CURRENT classifier over
 * the CURRENT rule text.
 *
 * `compileAttemptIsCurrent` is not enough on its own, and assuming it was is a
 * bug worth naming: the sweep skips a rule whose compile attempt is current,
 * and it returns before the context need is ever looked at. So bumping
 * CONTEXT_NEED_PROMPT_VERSION on its own re-classified nothing — the outer gate
 * closed first. Eligibility has to ask BOTH questions.
 *
 * An `author` need is current by definition: the rule's owner outranks the
 * classifier, and a prompt version has no business overriding a human.
 */
export function contextNeedIsCurrent(rule: {
    rule?: string;
    contextNeed?: { sourceHash?: string; source?: string };
}): boolean {
    const stored = rule?.contextNeed;
    if (!stored) return false;
    if (stored.source === 'author') return true;
    return !!stored.sourceHash && stored.sourceHash === ruleContextNeedHash(rule);
}
