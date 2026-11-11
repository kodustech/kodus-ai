import { createHash } from 'crypto';

export interface ScanFingerprintInput {
    repositoryId: string;
    vulnerabilityClass: string;
    filePath: string;
    /** The function or method holding the vulnerable operation. */
    symbol?: string;
    /** The finding's CWE; only its family (cweFamily) enters the identity. */
    cwe?: string;
    /**
     * The weakness is one setting the whole application shares (CSRF
     * protection off in the settings, not one route exempted from it).
     */
    appWide?: boolean;
}

/**
 * Kinds of weakness a model names with neighbouring CWEs from scan to scan
 * (CWE-89 or CWE-943 for one SQL injection): the family keeps two different
 * bugs in one function apart (an XSS and a SQL injection in the same handler)
 * without a change of wording opening a new issue.
 */
const CWE_FAMILIES: Record<string, number[]> = {
    xss: [79, 80, 83, 87],
    sql: [89, 564, 943],
    command: [77, 78, 88],
    code: [94, 95, 98, 829],
    template: [97, 1336],
    path: [22, 23, 35, 36, 73],
    deserialization: [502],
    xxe: [611, 776, 827],
    redirect: [601],
    ssrf: [441, 918],
    query: [90, 91, 643],
    header: [93, 113],
    // A missing login check and a missing permission check on one route are
    // one gap to the developer, whichever of the two a model names. A broken
    // login (287) or unlimited guessing (307) at the same place is another.
    access: [284, 285, 306, 566, 639, 862, 863, 915],
    authentication: [287, 290, 294, 1390],
    bruteforce: [307],
    secret: [259, 321, 547, 798],
    password: [256, 257, 261, 312, 916],
    crypto: [326, 327, 328, 330, 331, 337, 338],
    tls: [295, 297],
    exposure: [200, 209, 215, 497, 532, 538],
    signature: [347],
    csrf: [352],
    cookie: [384, 614, 1004, 1275],
    debug: [11, 16, 489, 693],
    cors: [346, 942],
    exhaustion: [400, 405, 407, 409, 674, 770, 834, 1050, 1333],
};

/**
 * CWEs that can name one setting the whole application shares: CSRF
 * protection off, a session cookie flag missing, debug mode on, CORS open to
 * any origin. Such a setting is one issue for the repository, not one per
 * route that inherits it. The CWE alone does not say so (one route exempted
 * from CSRF is its own bug, fixed on its own): the finding must also say the
 * cause is shared (`appWide`). The CWE, not its family, gates it, because a
 * family also holds weaknesses that live at one place (session fixation).
 */
const APP_WIDE_CWES = new Set([352, 489, 614, 942, 1004, 1275]);

const FAMILY_OF = new Map<number, string>(
    Object.entries(CWE_FAMILIES).flatMap(([family, ids]) =>
        ids.map((id) => [id, family] as [number, string]),
    ),
);

/**
 * The CWE's number: the one after "CWE" when the text names it ("OWASP
 * A03:2021 CWE-89" is 89, not 3), or a bare number.
 */
export function cweId(cwe?: string): number | null {
    const text = String(cwe ?? '');
    const id = Number(
        text.match(/CWE[\s_:-]*(\d{1,5})/i)?.[1] ??
            text.match(/^\s*(\d{1,5})\s*$/)?.[1],
    );
    return Number.isFinite(id) && id > 0 ? id : null;
}

/** The family of a CWE ("CWE-89" → "sql"), or the CWE itself when none is listed. */
export function cweFamily(cwe?: string): string {
    const id = cweId(cwe);
    if (id === null) {
        return '';
    }
    return FAMILY_OF.get(id) ?? `cwe-${id}`;
}

/**
 * The identity a security-scan finding keeps across scans. Line numbers are
 * left out on purpose: an edit above the finding moves every line, and the
 * same finding would come back as a new issue while the old one is resolved.
 * Renaming the file or the function does change the identity — the old issue
 * is resolved and a new one opened, which is the honest outcome. The CWE's
 * family is part of it, so two kinds of bug in one function are two issues.
 */
export function computeScanFingerprint(input: ScanFingerprintInput): string {
    const id = cweId(input.cwe);
    const appWide = !!input.appWide && id !== null && APP_WIDE_CWES.has(id);
    const parts = [
        input.repositoryId,
        input.vulnerabilityClass.trim().toLowerCase(),
        appWide ? '' : normalizeScanPath(input.filePath),
        appWide ? '' : (input.symbol ?? '').trim(),
        appWide ? `cwe-${id}` : cweFamily(input.cwe),
    ];

    return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** The spelling a scan finding's path is stored and compared in. */
export function normalizeScanPath(path: string): string {
    return path
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.?\//, '');
}
