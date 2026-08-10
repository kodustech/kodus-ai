declare const redactedTag: unique symbol;

/**
 * A string that has been through {@link redact}.
 *
 * Only `redact` can produce one, so any signature that demands a `Redacted`
 * cannot be handed a raw transcript by accident — the compiler stops it.
 */
export type Redacted = string & { readonly [redactedTag]: 'kodus-redacted' };

export const REDACTION_PLACEHOLDER = '[REDACTED]';

interface SecretPattern {
    name: string;
    pattern: RegExp;
    /** When set, only this capture group is replaced (keeps the key name). */
    group?: number;
}

/**
 * Ordered most-specific-first. Every pattern is global + multiline so a single
 * pass over the text replaces every occurrence.
 */
const SECRET_PATTERNS: SecretPattern[] = [
    {
        name: 'pem-private-key',
        pattern:
            /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    },
    { name: 'anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
    { name: 'openai-project', pattern: /\bsk-proj-[A-Za-z0-9_-]{8,}/g },
    { name: 'openai', pattern: /\bsk-[A-Za-z0-9]{16,}/g },
    { name: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
    { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
    { name: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g },
    { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
    { name: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{30,}/g },
    { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    { name: 'stripe', pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
    { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
    {
        name: 'jwt',
        pattern:
            /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    },
    {
        name: 'authorization-header',
        pattern: /\b(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{12,})/gi,
        group: 1,
    },
    {
        name: 'url-credentials',
        pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)([^\s/@]{3,})@/gi,
        group: 2,
    },
    {
        // FOO_SECRET=..., "apiKey": "...", password: '...' — the value only.
        //
        // The value lookahead skips the placeholder (so redaction stays
        // idempotent) and the scheme keywords an earlier pattern already
        // handled, which would otherwise turn `Authorization: Bearer X` into
        // two placeholders.
        name: 'secret-assignment',
        pattern:
            /\b([A-Za-z0-9_.-]*(?:secret|token|passwd|password|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*)\s*[:=]\s*["'`]?((?!\[REDACTED\])(?!Bearer\b)(?!Basic\b)(?!Token\b)[^\s"'`,;]{6,})["'`]?/gi,
        group: 2,
    },
];

function applyPatterns(input: string): string {
    let output = input;

    for (const { pattern, group } of SECRET_PATTERNS) {
        if (!group) {
            pattern.lastIndex = 0;
            output = output.replace(pattern, REDACTION_PLACEHOLDER);
            continue;
        }

        output = replaceCaptureAtPosition(output, pattern, group);
    }

    return output;
}

/**
 * Replace a capture by its absolute match indices. Searching for the captured
 * value is unsafe: in `user:user@host`, replacing the first equal string leaks
 * the password and redacts the username instead.
 */
function replaceCaptureAtPosition(
    input: string,
    pattern: RegExp,
    group: number,
): string {
    const indexed = new RegExp(
        pattern.source,
        pattern.flags.includes('d') ? pattern.flags : `${pattern.flags}d`,
    );
    const chunks: string[] = [];
    let cursor = 0;

    for (;;) {
        const match = indexed.exec(input);
        if (!match) {
            break;
        }

        const range = match.indices?.[group];
        if (!range || range[0] === range[1]) {
            if (match[0].length === 0) {
                indexed.lastIndex += 1;
            }
            continue;
        }

        chunks.push(input.slice(cursor, range[0]), REDACTION_PLACEHOLDER);
        cursor = range[1];
    }

    if (cursor === 0) {
        return input;
    }
    chunks.push(input.slice(cursor));
    return chunks.join('');
}

/**
 * Strip credentials out of free text. Idempotent, and safe to run on text that
 * has already been redacted.
 */
export function redact(value: string | null | undefined): Redacted {
    if (!value) {
        return '' as Redacted;
    }
    return applyPatterns(value) as Redacted;
}

/** Redact every string in an array, dropping nothing. */
export function redactAll(values: readonly string[]): Redacted[] {
    return values.map((value) => redact(value));
}

/**
 * Deep-redact an arbitrary JSON-ish value. Used for tool-call inputs, which are
 * agent-shaped and can hold anything.
 */
export function redactDeep<T>(value: T): T {
    if (typeof value === 'string') {
        return redact(value) as unknown as T;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => redactDeep(entry)) as unknown as T;
    }
    if (value && typeof value === 'object') {
        const output: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(
            value as Record<string, unknown>,
        )) {
            output[key] = redactDeep(entry);
        }
        return output as unknown as T;
    }
    return value;
}

/**
 * True when the text no longer contains anything the redactor recognises.
 * Exists for tests and for the `trace status` self-check — production code
 * should just call `redact`.
 */
export function containsSecret(value: string): boolean {
    return SECRET_PATTERNS.some(({ pattern }) => {
        pattern.lastIndex = 0;
        return pattern.test(value);
    });
}

/**
 * Escape hatch for values that provably cannot carry a secret (git SHAs,
 * enum-ish agent names). Named so it shows up in review.
 */
export function assumeRedacted(value: string): Redacted {
    return value as Redacted;
}
