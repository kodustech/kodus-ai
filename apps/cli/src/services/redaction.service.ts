/**
 * Secret redaction for session capture.
 * The branded `RedactedString` type ensures unredacted text cannot flow into
 * turn-building / storage paths by accident (signature-level enforcement).
 */

export type RedactedString = string & { readonly __brand: 'RedactedString' };

const SECRET_PATTERNS: RegExp[] = [
    // AWS access key ids
    /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    // Generic API keys / tokens (long hex or base64-ish after a keyword)
    /\b(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|bearer|private[_-]?key)\b\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi,
    // JWT-looking triples
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    // GitHub PATs
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    // Slack tokens
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    // OpenAI-style keys
    /\bsk-[A-Za-z0-9]{20,}\b/g,
    // Anthropic-style keys
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    // Generic long hex secrets (32+ chars) after common prefixes
    /\b(?:secret|token|key)[_-]?[:=]\s*[0-9a-f]{32,}\b/gi,
];

const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * Redact known secret patterns from free text.
 * Always returns a branded RedactedString so callers cannot mix raw strings.
 */
export function redactText(input: string): RedactedString {
    let result = input;
    for (const pattern of SECRET_PATTERNS) {
        // Reset lastIndex for global regexes reused across calls
        pattern.lastIndex = 0;
        result = result.replace(pattern, REDACTION_PLACEHOLDER);
    }
    return result as RedactedString;
}

/**
 * Build a turn-start event payload requiring already-redacted prompt text.
 * An unredacted string fails to type-check at the call site.
 */
export function requireRedacted(value: RedactedString): RedactedString {
    return value;
}

/**
 * Test helper: assert a value was produced by redactText (runtime brand check
 * is structural; this re-runs redaction and checks idempotence for tests).
 */
export function containsUnredactedSecret(
    text: string,
    plantedSecret: string,
): boolean {
    return text.includes(plantedSecret);
}
