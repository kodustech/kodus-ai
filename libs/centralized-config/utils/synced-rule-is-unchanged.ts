import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * Whether writing `incoming` (the rule a centralized-config sync built from a
 * rule file) over `stored` would change anything.
 *
 * The sync writes with a top-level merge (`{ ...stored, ...incoming }`), so
 * only the fields `incoming` carries with a value can change. Each of them
 * must match the stored value exactly; anything this cannot prove equal counts as a change
 * and is written, as before.
 */
export function syncedRuleIsUnchanged(
    stored: Partial<IKodyRule>,
    incoming: Partial<IKodyRule>,
): boolean {
    for (const [key, value] of Object.entries(incoming)) {
        if (key === 'uuid') continue;
        // The write skips undefined fields (ruleFieldSet), so one cannot
        // change the stored rule; counting it would write on every sync.
        if (value === undefined) continue;
        const current = (stored as Record<string, unknown>)[key];

        // The write lowercases severity: a file saying `High` over a stored
        // `high` changes nothing, while a legacy stored `High` still gets
        // the write that normalizes it.
        if (key === 'severity') {
            if (lower(value) !== (current ?? null)) return false;
            continue;
        }

        if (key === 'status') {
            if (!statusIsKept(stored, value)) return false;
            continue;
        }

        if (!sameValue(current, value)) return false;
    }
    return true;
}

/**
 * The same status is not enough while the plan limit holds the rule
 * (`lockedByPlan`). The write is what moves it: a file asking for the rule
 * active re-checks the limit and lifts the lock once a slot is free (on a
 * limited plan nothing else does), and a file disabling the rule clears the
 * lock so an upgrade does not turn it back on.
 */
function statusIsKept(stored: Partial<IKodyRule>, incoming: unknown): boolean {
    return incoming === stored.status && !stored.lockedByPlan;
}

function lower(value: unknown): unknown {
    return typeof value === 'string' ? value.toLowerCase() : (value ?? null);
}

/** Deep equality where a missing field, `undefined` and `null` are the same. */
function sameValue(a: unknown, b: unknown): boolean {
    if (a === undefined || a === null || b === undefined || b === null) {
        return (a ?? null) === (b ?? null);
    }
    if (a instanceof Date || b instanceof Date) {
        return new Date(a as Date).getTime() === new Date(b as Date).getTime();
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        return (
            Array.isArray(a) &&
            Array.isArray(b) &&
            a.length === b.length &&
            a.every((item, i) => sameValue(item, b[i]))
        );
    }
    if (typeof a === 'object' && typeof b === 'object') {
        const ra = a as Record<string, unknown>;
        const rb = b as Record<string, unknown>;
        const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
        for (const key of keys) {
            if (!sameValue(ra[key], rb[key])) return false;
        }
        return true;
    }
    return a === b;
}
