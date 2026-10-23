import { createHash } from 'node:crypto';

import type {
    BusinessValidationOutcome,
    Task,
    TaskCheck,
} from './business-validation.types';
import { taskPasses } from './check-policy';
import type { ValidationResult } from './judge/validation.types';
import { deriveStatus } from './judge/validation-verdict';
import type { RunTask } from './runs/validation-run.model';

/**
 * A re-check on top of the PR's previous run: what a reviewer accepted stays
 * accepted (UC-37), and a requirement whose state changed says what it was
 * ("was missing", UC-34).
 */
export function carryOver(
    outcome: BusinessValidationOutcome,
    previous: RunTask[] | undefined,
): BusinessValidationOutcome {
    if (outcome.kind !== 'validated' || !previous?.length) {
        return outcome;
    }
    const checks = outcome.checks.map((check) => {
        const before = previous.find((t) => t.id === check.task.id);
        return before ? applyPrevious(check, before) : check;
    });
    return { ...outcome, checks, passed: checks.every((c) => c.passed) };
}

function applyPrevious(check: TaskCheck, before: RunTask): TaskCheck {
    const current = check.verdict.requirements ?? [];
    // Likeness may only stand in for the same text when the task's text is
    // the one the acceptance was given on: edited, "on the orders page"
    // would hand its acceptance to "on the invoices page".
    const sameTask =
        !!before.textHash &&
        before.textHash === (check.textHash ?? taskTextHash(check.task));
    const priors = matchPrevious(
        current.map((r) => r.requirement),
        before.requirements.map((r) => r.requirement),
        { similar: sameTask },
    );
    const requirements = current.map((r, i) => {
        const at = priors[i];
        const prior = at === undefined ? undefined : before.requirements[at];
        if (!prior) {
            return r;
        }
        return {
            ...r,
            ...(prior.accepted && r.state !== 'met'
                ? { accepted: prior.accepted }
                : {}),
            ...(prior.state !== r.state ? { previousState: prior.state } : {}),
        };
    });
    const acceptedChanges = new Map(
        before.outOfScope
            .filter((c) => c.accepted)
            .map((c) => [requirementKey(c.change), c.accepted!]),
    );
    const outOfScope = (check.verdict.outOfScope ?? []).map((c) => {
        const accepted = acceptedChanges.get(requirementKey(c.change));
        return accepted ? { ...c, accepted } : c;
    });
    const verdict: ValidationResult = {
        ...check.verdict,
        requirements,
        outOfScope,
        ...deriveStatus({ ...check.verdict, requirements, outOfScope }),
    };
    return {
        ...check,
        verdict,
        passed: taskPasses(verdict, check.reference?.intent),
    };
}

/** How alike two re-quotes of one criterion must be, in shared words. */
const SAME_REQUIREMENT = 0.8;

/**
 * For each requirement of this run, the index of the same one in the last
 * run. The judge re-quotes the task on every run, and a re-quote may cut a
 * sentence or merge two bullets: the exact text wins, then, when `similar`
 * (the task's text is unchanged), the most alike one, each earlier requirement taken once. Numbers, symbols and negation
 * must match: "count > 10" never takes "count < 10"'s acceptance, nor "must
 * not export" the one of "must export".
 */
export function matchPrevious(
    now: string[],
    before: string[],
    { similar = true }: { similar?: boolean } = {},
): Array<number | undefined> {
    const taken = new Set<number>();
    const result: Array<number | undefined> = now.map(() => undefined);
    const byKey = new Map<string, number[]>();
    before.forEach((text, j) => {
        const key = requirementKey(text);
        byKey.set(key, [...(byKey.get(key) ?? []), j]);
    });
    now.forEach((text, i) => {
        const exact = byKey.get(requirementKey(text))?.shift();
        if (exact !== undefined) {
            taken.add(exact);
            result[i] = exact;
        }
    });
    if (!similar) {
        return result;
    }
    const pairs: Array<{ i: number; j: number; score: number }> = [];
    now.forEach((text, i) => {
        if (result[i] !== undefined) {
            return;
        }
        before.forEach((earlier, j) => {
            if (
                taken.has(j) ||
                signs(text) !== signs(earlier) ||
                negated(text) !== negated(earlier)
            ) {
                return;
            }
            const score = overlap(words(text), words(earlier));
            if (score >= SAME_REQUIREMENT) {
                pairs.push({ i, j, score });
            }
        });
    });
    for (const { i, j } of pairs.sort((a, b) => b.score - a.score)) {
        if (result[i] === undefined && !taken.has(j)) {
            taken.add(j);
            result[i] = j;
        }
    }
    return result;
}

function words(text: string): Set<string> {
    return new Set(
        requirementKey(text)
            .split(/[^\p{L}\p{N}]+/u)
            .filter((w) => w.length > 2),
    );
}

/** The numbers and comparison signs, which must agree for two texts to be one requirement. */
function signs(text: string): string {
    return (text.match(/\d+(?:[.,]\d+)?|[<>=≤≥≠]+/g) ?? []).sort().join(' ');
}

const NEGATION =
    /\b(?:not|no|never|none|nor|without|cannot|não|nao|nunca|sem|nenhum|nenhuma)\b|n['’]t\b/iu;

/** "Must export" and "must not export" share every word but are opposites. */
function negated(text: string): boolean {
    return NEGATION.test(text);
}

/** Shared words over the smaller text's words: a cut sentence still matches. */
function overlap(a: Set<string>, b: Set<string>): number {
    if (!a.size || !b.size) {
        return 0;
    }
    let shared = 0;
    for (const word of a) {
        if (b.has(word)) {
            shared += 1;
        }
    }
    return shared / Math.min(a.size, b.size);
}

/**
 * Requirements are matched by their text, ignoring case, spacing and the
 * punctuation around it ("reload" and "reload!"). Symbols inside stay:
 * "count > 10" and "count < 10" are different requirements, and one must
 * not inherit the other's acceptance.
 */
export function requirementKey(text: string): string {
    return text
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** What the judge read of a task, hashed: its title, text and fields. */
export function taskTextHash(task: Task): string | undefined {
    if (task.description === undefined && !task.fields) {
        return undefined;
    }
    return createHash('sha256')
        .update(
            JSON.stringify([
                task.title ?? '',
                task.description ?? '',
                task.fields ?? {},
            ]),
        )
        .digest('hex');
}
