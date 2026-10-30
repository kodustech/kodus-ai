import { CLI_OUTPUT_MAX_CHARS } from './cli-command';

export const SECRET_REDACTION = '***';

/** Shortest base64 run worth masking: shorter cores would blank unrelated text. */
const MIN_ENCODED_CORE = 8;

/**
 * Every spelling of a secret a CLI could plausibly echo back: the value, its
 * base64 / base64url, the base64 core it keeps when it is embedded in a
 * longer encoded string (`user:secret` in a Basic auth header) at any of the
 * three byte alignments, its percent encoding, hex (both cases) and JSON
 * string escapes.
 */
export function secretVariants(secret: string): string[] {
    if (!secret) return [];
    const variants = new Set<string>([secret]);
    const bytes = Buffer.from(secret, 'utf8');

    for (let offset = 0; offset < 3; offset++) {
        const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
        const encoded = padded.toString('base64').replace(/=+$/, '');
        // Characters that also carry bits of the unknown neighbours are not
        // part of the secret's fixed encoding: drop them at both ends.
        const head = Math.ceil((offset * 8) / 6);
        const totalBits = padded.length * 8;
        const tail = totalBits % 6 === 0 ? 0 : 1;
        const core = encoded.slice(head, encoded.length - tail);
        if (offset === 0) {
            variants.add(padded.toString('base64'));
            variants.add(encoded);
        }
        if (core.length >= MIN_ENCODED_CORE) variants.add(core);
    }

    for (const value of [...variants]) {
        const url = value
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        if (url.length >= MIN_ENCODED_CORE || url === secret) {
            variants.add(url);
        }
    }
    // Text encodings a CLI or its debug output commonly applies: percent
    // encoding (either hex case), hex in either case (debug traces, and
    // byte-per-pair dumps within one line) and JSON string escaping.
    const percent = encodeURIComponent(secret);
    variants.add(percent);
    variants.add(percent.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    const hex = bytes.toString('hex');
    const hexPairs = hex.match(/../g)?.join(' ') ?? '';
    for (const value of [hex, hexPairs]) {
        variants.add(value);
        variants.add(value.toUpperCase());
    }
    variants.add(JSON.stringify(secret).slice(1, -1));
    // \u-escaped every non-ASCII-safe character, as some JSON encoders do.
    variants.add(
        secret.replace(
            /[^\x20-\x7e]|["\\/<>&']/g,
            (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
        ),
    );
    return [...variants].filter(Boolean);
}

/** Replace every variant of every secret, longest first so a shorter one
 *  never leaves the tail of a longer one in place. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
    if (!text || !secrets.length) return text ?? '';
    const variants = [
        ...new Set(secrets.flatMap((secret) => secretVariants(secret))),
    ].sort((a, b) => b.length - a.length);
    let masked = text;
    for (const variant of variants) {
        masked = masked.split(variant).join(SECRET_REDACTION);
    }
    return masked;
}

export function capCliOutput(
    text: string,
    max: number = CLI_OUTPUT_MAX_CHARS,
): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n... (output truncated at ${max} characters)`;
}
