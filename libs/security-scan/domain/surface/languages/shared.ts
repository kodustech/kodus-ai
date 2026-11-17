import { SurfacePattern, VulnClass } from '../surface.types';

// Every regex here must compile both as Rust regex (ripgrep) and as a JS
// RegExp: no lookaround/backrefs/inline flags, `{`/`}` always escaped, a
// literal `-` only at the end of a class, and never `\<`/`\>` (word
// boundaries in Rust). Case-insensitivity is spelled out with `ci()`.

export function entry(
    id: string,
    regex: string,
    framework?: string,
): SurfacePattern {
    return { id, role: 'entry_point', regex, framework };
}

export function auth(
    id: string,
    regex: string,
    framework?: string,
): SurfacePattern {
    return { id, role: 'auth_check', regex, framework };
}

export function sink(
    id: string,
    vulnClass: VulnClass,
    cwe: string,
    regex: string,
    framework?: string,
): SurfacePattern {
    return { id, role: 'sink', regex, vulnClass, cwe, framework };
}

/** Joins alternatives into one regex. */
export function any(...alternatives: string[]): string {
    return alternatives.join('|');
}

/** Case-insensitive literal without `(?i)`, which JS does not accept inline. */
export function ci(word: string): string {
    return word.replace(
        /[A-Za-z]/g,
        (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`,
    );
}

/**
 * A string that reads as SQL. Bare "select"/"update" are English words, so
 * each verb needs its SQL companion (FROM, INTO, SET, a comparison after
 * WHERE) before a concatenation counts as a query being built.
 */
export const SQL_SHAPE = String.raw`(?:\b${ci('select')}\s[^"'\x60]*?\b${ci('from')}\b|\b${ci('insert')}\s+${ci('into')}\b|\b${ci('update')}\s+[\w.\x60\[\]]+\s+${ci('set')}\b|\b${ci('delete')}\s+${ci('from')}\b|\b(?:WHERE|where|Where)\s+[\w.]+\s*(?:=|<|>|!=|\b(?:IN|in|LIKE|like)\b))`;

/**
 * A SQL-shaped string literal delimited by `q` and followed by `tail`
 * (a concatenation operator or an interpolation token).
 */
export function sqlInString(q: string, tail: string): string {
    return `${q}[^${q}]*${SQL_SHAPE}[^${q}]*${tail}`;
}

/** `"…SQL…" + x` and `'…SQL…' + x`, with `op` the concatenation operator. */
export function sqlConcat(op = String.raw`\+`): string {
    return any(
        sqlInString('"', String.raw`"\s*${op}`),
        sqlInString("'", String.raw`'\s*${op}`),
    );
}

/** Names whose literal value is a credential. Bare "token" is left out: `tokenType = "Bearer"`. */
const HARDCODED_NAME = String.raw`(?:[Pp]ass(?:word|wd)|PASS(?:WORD|WD)|[Ss]ecret|SECRET|[Aa]pi_?[Kk]ey|API_?KEY|[Aa]ccess_?[Tt]oken|ACCESS_?TOKEN|[Aa]uth_?[Tt]oken|AUTH_?TOKEN|[Pp]rivate_?[Kk]ey|PRIVATE_?KEY|[Cc]lient_?[Ss]ecret|CLIENT_?SECRET)`;

/**
 * Name, optional type annotation (`: &'static str`, `: String`, Go `string`),
 * an assignment-ish operator, then a quoted value of 8+ chars without
 * whitespace or template markers (`${DB_PASSWORD}`, `<changeme>`, `%s`).
 */
export const HARDCODED_SECRET = String.raw`${HARDCODED_NAME}\w*["']?(?:\s*:\s*&?'?\w+(?:\s+\w+)?|\s+string)?\s*(?:=|:=|=>|:)\s*["'][^"'\s{}$<>%]{8,}["']`;

export const KNOWN_KEY_FORMAT = String.raw`AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{36}\b|\bsk_live_[0-9a-zA-Z]{24,}|\bxox[baprs]-[0-9A-Za-z-]{10,}`;

/** Words that make a log line or a response carry a secret or PII. */
export const SENSITIVE_WORD = String.raw`(?:[Pp]ass(?:word|wd)|PASS(?:WORD|WD)|[Ss]ecret|SECRET|[Tt]oken|TOKEN|[Aa]pi_?[Kk]ey|API_?KEY|[Aa]uthorization|AUTHORIZATION|[Cc]redential|CREDENTIAL|[Pp]rivate_?[Kk]ey|PRIVATE_?KEY|\b[Ss]sn\b|\bSSN\b|[Cc]redit_?[Cc]ard|[Cc]ard_?[Nn]umber|\b[Cc]vv\b|\bCVV\b)`;

/** `<logCall>(…sensitive word…)` on one line. */
export function logsSensitive(logCall: string): string {
    return `(?:${logCall}).*${SENSITIVE_WORD}`;
}

/** Variables that hold something an attacker must not guess. */
export const GUESSABLE_SECRET_NAME = String.raw`(?:[Tt]oken|TOKEN|[Ss]ecret|SECRET|[Nn]once|NONCE|[Ss]alt|SALT|[Oo]tp|OTP|[Pp]assword|PASSWORD|[Ss]ession_?[Ii]d|[Aa]pi_?[Kk]ey|API_?KEY|[Rr]eset_?[Cc]ode|[Vv]erification_?[Cc]ode|[Ii]nvite_?[Cc]ode)`;

/**
 * A non-cryptographic random source assigned to a secret-ish name. Plain
 * `Math.random()` is everywhere (jitter, UI), so the name is what makes it a
 * candidate.
 */
export function randomForSecret(randomCall: string): string {
    return String.raw`${GUESSABLE_SECRET_NAME}\w*\s*(?:=|:=|:|<-)[^;]*(?:${randomCall})`;
}

/**
 * The name must END the identifier (or continue camelCase): `max_tokens` and
 * `TOKEN_KIND` are counts and type tags, not secrets.
 */
const COMPARED_SECRET = String.raw`(?:[Ss]ecret(?:_?[Kk]ey)?|SECRET(?:_KEY)?|[Tt]oken|TOKEN|[Ss]ignature|SIGNATURE|[Hh]mac|HMAC|[Dd]igest|DIGEST|[Aa]pi_?[Kk]ey|API_?KEY|[Pp]assword|PASSWORD)(?:\b|[A-Z])`;

/**
 * `== <secret-ish identifier>`, or `<secret> == expected/computed…`. The
 * right-hand side must start like an identifier so `token === null` and
 * `type === "token"` stay out.
 */
export const TIMING_UNSAFE_COMPARE = String.raw`(?:===?|!==?)\s*[\w$@][\w.$@\[\]'">:-]*?${COMPARED_SECRET}|${COMPARED_SECRET}\w*\s*(?:===?|!==?)\s*[\w.$@>-]*(?:[Ee]xpected|[Cc]omputed|[Cc]alculated|[Ss]tored|[Vv]alid|[Cc]orrect)`;

export const JWT_ALG_NONE = String.raw`\balg(?:orithm)?s?["']?\s*(?:=>|:|=)\s*\[?\s*["'](?:none|None|NONE)["']`;

/** An LDAP filter whose value is concatenated or interpolated. */
export const LDAP_FILTER_BUILT = String.raw`\((?:uid|cn|sAMAccountName|mail|userPrincipalName|member|memberUid|ou)=(?:["']\s*(?:\+|\.|<<)|\$\{|\$[a-zA-Z_]|#\{|%s|\{\w*\}|\\\()`;

/** An XPath predicate whose value is concatenated or interpolated. */
export const XPATH_BUILT = String.raw`["'\x60]//?\w[^"']*\[@?\w+\s*=\s*'?(?:["']\s*(?:\+|\.)|\$\{|\$[a-zA-Z_]|#\{|\{\w*\}|%s|\\\()`;

/** Lookup filtered by the id ALONE: no owner/tenant column on the same line. */
export const SQL_BY_ID_ONLY = String.raw`\b(?:WHERE|where|Where)\s+(?:\w+\.)?(?:id|ID|Id)\s*=\s*(?:\?|\$1|:id|@\w*[Ii]d|%s|%\(id\)s|\$\{?\w+\}?)\s*(?:(?:LIMIT|limit)\s+1\s*)?["'\x60;)]`;

export interface CommonSinkOptions {
    /** Mongo `$where` (JS evaluated server side). */
    nosql?: boolean;
    ldap?: boolean;
    xpath?: boolean;
    /** SQL text filtering a row by id only (IDOR candidate). */
    sqlById?: boolean;
}

/** Language-agnostic sinks; ids are `<prefix>.common.*`. */
export function commonSinks(
    prefix: string,
    opts: CommonSinkOptions = {},
): SurfacePattern[] {
    const patterns: SurfacePattern[] = [
        sink(
            `${prefix}.common.hardcoded-secret`,
            'secret_identity',
            'CWE-798',
            HARDCODED_SECRET,
        ),
        sink(
            `${prefix}.common.known-key-format`,
            'secret_identity',
            'CWE-798',
            KNOWN_KEY_FORMAT,
        ),
        sink(
            `${prefix}.common.jwt-alg-none`,
            'secret_identity',
            'CWE-347',
            JWT_ALG_NONE,
        ),
    ];
    if (opts.ldap !== false) {
        patterns.push(
            sink(
                `${prefix}.common.ldap-filter`,
                'injection',
                'CWE-90',
                LDAP_FILTER_BUILT,
            ),
        );
    }
    if (opts.xpath !== false) {
        patterns.push(
            sink(`${prefix}.common.xpath`, 'injection', 'CWE-643', XPATH_BUILT),
        );
    }
    if (opts.nosql) {
        patterns.push(
            sink(
                `${prefix}.common.nosql-where`,
                'injection',
                'CWE-943',
                String.raw`["']\$where["']`,
            ),
        );
    }
    if (opts.sqlById !== false) {
        patterns.push(
            sink(
                `${prefix}.common.sql-by-id-only`,
                'authz',
                'CWE-639',
                SQL_BY_ID_ONLY,
            ),
        );
    }
    return patterns;
}

export function timingCompare(prefix: string, extra?: string): SurfacePattern {
    return sink(
        `${prefix}.crypto.timing-unsafe-compare`,
        'secret_identity',
        'CWE-208',
        extra ? any(TIMING_UNSAFE_COMPARE, extra) : TIMING_UNSAFE_COMPARE,
    );
}
