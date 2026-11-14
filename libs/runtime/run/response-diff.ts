// What main and the PR answered, field by field (the finding card's
// "Response" tab): from the first healthy round of each side, the compared
// JSON fields whose values differ, or the first differing line of a body that
// is not JSON. Shown only: the gate already decided from its own fields, and
// nothing here reaches the PR comment (ADR-052).
//
// Every value is text the app under test chose. The cell redacted it with the
// claim's redactor (S-51); `clean` runs again (token patterns and the Run's
// canaries), and a key that looks like a header or a secret is always
// `[redacted]`, at any depth, whatever its value looks like.

export const RESPONSE_DIFF_MAX_FIELDS = 20;
export const RESPONSE_DIFF_VALUE_MAX = 200;
/** What a round keeps of a body that is not JSON, to find the first differing line. */
export const RESPONSE_TEXT_MAX_LINES = 200;
export const RESPONSE_TEXT_LINE_MAX = 400;

export interface ResponseDiff {
    /**
     * Gate field names (`json.user.email`, as `differingFields` names them;
     * the body's root is `json`), or `line N` for a body that is not JSON, or
     * `body` when one side answered JSON and the other did not. A value is
     * absent on the side that has no such field or line.
     */
    fields: Array<{ path: string; base?: string; pr?: string }>;
    /** More fields differed than are listed, or a text body was cut before its first difference. */
    truncated: boolean;
}

/** One side's answer as its first healthy round left it: the gate's fields, and the first lines of a body that is not JSON. */
export interface ResponseSample {
    fields: Record<string, string>;
    /** Present only when the body did not parse as JSON; cleaned and cut. */
    text?: { lines: string[]; truncated: boolean };
}

export const REDACTED = '[redacted]';
const SECRET_KEY = /password|passwd|token|secret|key|authorization|cookie|header|credential|session/i;

const isJsonField = (k: string) => k === 'json' || k.startsWith('json.');
const isSecretPath = (path: string) => path.split('.').slice(1).some((seg) => SECRET_KEY.test(seg));

function clip(s: string): string {
    return s.length > RESPONSE_DIFF_VALUE_MAX ? `${s.slice(0, RESPONSE_DIFF_VALUE_MAX - 1)}…` : s;
}

/** A value with every secret-looking key below it masked, when it is a JSON object or array. */
function maskNested(value: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return value;
    }
    if (parsed === null || typeof parsed !== 'object') return value;
    const walk = (v: unknown, depth: number): unknown => {
        if (depth > 16 || v === null || typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEY.test(k) ? REDACTED : walk(x, depth + 1)]));
    };
    return JSON.stringify(walk(parsed, 0));
}

/** The text a body sample keeps: cleaned before it is cut, so a cut never splits a secret out of a pattern. */
export function responseTextSample(body: string, clean: (text: string) => string): NonNullable<ResponseSample['text']> {
    const all = clean(body).split(/\r?\n/);
    const lines = all.slice(0, RESPONSE_TEXT_MAX_LINES).map((l) => (l.length > RESPONSE_TEXT_LINE_MAX ? l.slice(0, RESPONSE_TEXT_LINE_MAX) : l));
    return { lines, truncated: all.length > RESPONSE_TEXT_MAX_LINES };
}

/**
 * The field-level diff of two answers. `differing` (the gate's decisive
 * fields) come first; fields the base itself varied on (`masked`) are left
 * out, as the gate left them out. Undefined when nothing differs.
 */
export function responseDiffOf(args: {
    base: ResponseSample;
    pr: ResponseSample;
    differing?: string[];
    masked?: string[];
    clean: (text: string) => string;
}): ResponseDiff | undefined {
    const { base, pr, clean } = args;
    const value = (path: string, raw: string | undefined) => (raw === undefined ? undefined : isSecretPath(path) ? REDACTED : clip(maskNested(clean(raw))));
    const out = (fields: ResponseDiff['fields'], truncated: boolean): ResponseDiff | undefined => (fields.length || truncated ? { fields, truncated } : undefined);

    if (base.text && pr.text) {
        const a = base.text.lines;
        const b = pr.text.lines;
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            if (a[i] === b[i]) continue;
            // A side that ran out of lines only because it was cut does not differ there: say nothing more.
            if ((a[i] === undefined && base.text.truncated) || (b[i] === undefined && pr.text.truncated)) return out([], true);
            const path = `line ${i + 1}`;
            const line = (l: string | undefined) => (l === undefined ? undefined : clip(JSON.stringify(clean(l))));
            const x = line(a[i]);
            const y = line(b[i]);
            return { fields: [{ path, ...(x !== undefined ? { base: x } : {}), ...(y !== undefined ? { pr: y } : {}) }], truncated: false };
        }
        return out([], base.text.truncated || pr.text.truncated);
    }
    if (base.text || pr.text) {
        const describe = (s: ResponseSample) => clip(JSON.stringify(s.text ? clean(s.text.lines.find((l) => l.trim()) ?? '') : 'JSON body'));
        return { fields: [{ path: 'body', base: describe(base), pr: describe(pr) }], truncated: false };
    }

    const masked = new Set(args.masked ?? []);
    const keys = new Set([...Object.keys(base.fields), ...Object.keys(pr.fields)].filter((k) => isJsonField(k) && !masked.has(k)));
    const changed = [...keys].filter((k) => base.fields[k] !== pr.fields[k]);
    const decisive = (args.differing ?? []).filter((k) => changed.includes(k));
    const ordered = [...decisive, ...changed.filter((k) => !decisive.includes(k)).sort()];
    const fields = ordered.slice(0, RESPONSE_DIFF_MAX_FIELDS).map((path) => {
        const x = value(path, base.fields[path]);
        const y = value(path, pr.fields[path]);
        return { path, ...(x !== undefined ? { base: x } : {}), ...(y !== undefined ? { pr: y } : {}) };
    });
    return out(fields, ordered.length > RESPONSE_DIFF_MAX_FIELDS);
}
