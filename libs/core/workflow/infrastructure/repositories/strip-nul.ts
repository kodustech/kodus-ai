/**
 * Remove NUL characters (U+0000) from anything on its way into a `jsonb` column.
 *
 * PostgreSQL's `jsonb` cannot represent U+0000 — it is the one code point the
 * type rejects outright, with `unsupported Unicode escape sequence`, and it
 * fails the whole statement rather than just the offending field. `text` and
 * `json` accept it, so the constraint is easy to violate by accident and only
 * surfaces on the row that carries one.
 *
 * Nothing upstream can promise its absence. Payloads here are assembled from
 * webhook bodies, branch and file names, diffs, and model output — content
 * authored elsewhere, in encodings we do not control. A NUL in any of them took
 * down the INSERT in `WorkflowJobRepository.create`, so the job row was never
 * written and the webhook that asked for the review was dropped: no review, no
 * error the customer could see, just a review that never happened. Production
 * lost 51 of them in two hours.
 *
 * Stripping is the right repair rather than escaping or rejecting: the character
 * carries no meaning in this data, the surrounding text does, and a job that
 * runs without a stray NUL is the outcome everyone wanted.
 *
 * Structure is preserved (objects, arrays, Dates, Buffers, primitives); only
 * string contents change, and only when they actually contain the character.
 */
const NUL = '\u0000';
const NUL_GLOBAL = /\u0000/g;

/** Enough paths to see the shape of the source; not enough to flood a log line. */
const MAX_REPORTED_PATHS = 10;

type Walk = {
    /**
     * Original object -> its cleaned copy.
     *
     * A Set was not enough. Returning the ORIGINAL on revisit handed back an
     * un-sanitised object, so any value reachable through a second reference
     * kept its NULs and the INSERT failed exactly as before. A cycle is the
     * obvious case; a SHARED reference is the common one — the same object
     * hanging off two keys of a payload assembled from live pipeline state.
     */
    seen: WeakMap<object, unknown>;
    paths: string[];
    record: (path: string) => void;
};

function walk<T>(value: T, path: string, ctx: Walk): T {
    if (typeof value === 'string') {
        if (!value.includes(NUL)) {
            return value;
        }
        ctx.record(path || '(root)');
        return value.replace(NUL_GLOBAL, '') as unknown as T;
    }

    if (value === null || typeof value !== 'object') {
        return value;
    }

    // Dates and Buffers are values, not containers to walk — rebuilding them as
    // plain objects would lose their type on the way to the column.
    if (value instanceof Date || Buffer.isBuffer(value)) {
        return value;
    }

    // Already walked: hand back the CLEANED copy, never the original. A payload
    // assembled from live pipeline state can carry a cycle, and more often
    // carries the same object under two keys; returning the input there left
    // its NULs in place and the INSERT failed exactly as before.
    const memo = ctx.seen.get(value as object);
    if (memo !== undefined) {
        return memo as T;
    }

    if (Array.isArray(value)) {
        // Indexed, not forEach+push: forEach SKIPS holes, so a sparse array
        // ['a', , 'c'] condensed to ['a', 'c'] and the third element silently
        // moved to the second position. A sanitiser that reorders the payload
        // it is protecting is worse than the rejection it prevents.
        //
        // Sized and registered BEFORE recursing so a cycle back into this array
        // resolves to the copy being built rather than recursing forever.
        const arrayOut: unknown[] = new Array(value.length);
        ctx.seen.set(value as object, arrayOut);
        for (let i = 0; i < value.length; i++) {
            arrayOut[i] = walk(value[i], `${path}[${i}]`, ctx);
        }
        return arrayOut as unknown as T;
    }

    const out: Record<string, unknown> = {};
    ctx.seen.set(value as object, out);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        // A NUL is illegal in a jsonb KEY too, not only in a value.
        const childPath = path ? `${path}.${key}` : key;
        const cleanKey = key.includes(NUL)
            ? (ctx.record(`${childPath} (key)`), key.replace(NUL_GLOBAL, ''))
            : key;
        out[cleanKey] = walk(item, childPath, ctx);
    }
    return out as unknown as T;
}

const newContext = (): Walk => {
    const paths: string[] = [];
    return {
        seen: new WeakMap<object, unknown>(),
        paths,
        record: (p) => {
            if (paths.length < MAX_REPORTED_PATHS) {
                paths.push(p);
            }
        },
    };
};

/** Sanitised copy, with no report. Use when the caller has nothing to log. */
export function stripNulChars<T>(value: T): T {
    return walk(value, '', newContext());
}

/**
 * Sanitised copy PLUS where the NULs were.
 *
 * The stripping alone is invisible by design — it turns a loud failure into a
 * silent success, which is right for the customer and wrong for us: we would
 * never learn how often this happens, which producer emits it, or whether it is
 * one broken integration or a long tail. `paths` is what makes the repair
 * observable, so the caller can log the field names (never the content) when
 * something was actually removed.
 */
export function stripNulCharsWithReport<T>(value: T): {
    value: T;
    paths: string[];
    stripped: boolean;
} {
    const ctx = newContext();
    const cleaned = walk(value, '', ctx);
    return { value: cleaned, paths: ctx.paths, stripped: ctx.paths.length > 0 };
}
