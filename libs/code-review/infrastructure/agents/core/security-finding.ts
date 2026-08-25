/**
 * code-review (domain) — CWE normalization for security findings.
 *
 * WHY a normalizer instead of a strict schema: the CWE id is model-emitted free
 * text. Models write "CWE-89", "cwe 89", "CWE-89: SQL Injection" — all the same
 * fact. Validating it strictly would fail the whole suggestion item and DROP a
 * real vulnerability over formatting (the findings schema drops items that fail
 * item validation). So the schema accepts any string and this module extracts
 * the id, returning undefined when there is nothing to extract. A missing CWE
 * never kills a finding — it just doesn't get the badge.
 */

/** The CWEs the security lens actually reaches for (OWASP Top 10 territory).
 *  Not a mirror of MITRE's full list — just enough to render a human label
 *  without a network call. Unknown ids still render as the bare id. */
const CWE_TITLES: Readonly<Record<string, string>> = {
    'CWE-20': 'Improper Input Validation',
    'CWE-22': 'Path Traversal',
    'CWE-78': 'OS Command Injection',
    'CWE-79': 'Cross-site Scripting',
    'CWE-89': 'SQL Injection',
    'CWE-94': 'Code Injection',
    'CWE-119': 'Buffer Overflow',
    'CWE-200': 'Sensitive Information Exposure',
    'CWE-209': 'Error Message Information Leak',
    'CWE-259': 'Hard-coded Password',
    'CWE-269': 'Improper Privilege Management',
    'CWE-284': 'Improper Access Control',
    'CWE-287': 'Improper Authentication',
    'CWE-295': 'Improper Certificate Validation',
    'CWE-306': 'Missing Authentication for Critical Function',
    'CWE-311': 'Missing Encryption of Sensitive Data',
    'CWE-327': 'Broken or Risky Cryptographic Algorithm',
    'CWE-330': 'Insufficiently Random Values',
    'CWE-352': 'Cross-Site Request Forgery',
    'CWE-362': 'Race Condition',
    'CWE-377': 'Insecure Temporary File',
    'CWE-384': 'Session Fixation',
    'CWE-400': 'Uncontrolled Resource Consumption',
    'CWE-434': 'Unrestricted File Upload',
    'CWE-502': 'Deserialization of Untrusted Data',
    'CWE-522': 'Insufficiently Protected Credentials',
    'CWE-565': 'Reliance on Cookies without Validation',
    'CWE-601': 'Open Redirect',
    'CWE-611': 'XML External Entity (XXE)',
    'CWE-613': 'Insufficient Session Expiration',
    'CWE-639': 'Authorization Bypass Through User-Controlled Key (IDOR)',
    'CWE-732': 'Incorrect Permission Assignment',
    'CWE-770': 'Allocation without Limits',
    'CWE-798': 'Use of Hard-coded Credentials',
    'CWE-862': 'Missing Authorization',
    'CWE-863': 'Incorrect Authorization',
    'CWE-915': 'Improperly Controlled Modification of Attributes (Mass Assignment)',
    'CWE-918': 'Server-Side Request Forgery (SSRF)',
    'CWE-1321': 'Prototype Pollution',
};

/** Extract a canonical `CWE-<n>` id from whatever the model emitted.
 *  Returns undefined when the input carries no recognizable id. */
export function normalizeCwe(raw?: string | null): string | undefined {
    if (typeof raw !== 'string') return undefined;
    // Tolerates "CWE-89", "cwe89", "cwe 89", "CWE_89", and ids embedded in a
    // longer phrase ("CWE-89: SQL Injection", "see CWE-22").
    const match = /cwe[\s_-]*(\d{1,4})/i.exec(raw);
    if (!match) return undefined;
    // Strip leading zeros ("CWE-089" -> "CWE-89") so ids dedupe against the
    // catalog and against each other.
    const id = String(Number(match[1]));
    return `CWE-${id}`;
}

/** Human label for a CWE id: "CWE-89 (SQL Injection)", or the bare id when the
 *  catalog doesn't know it. Input is normalized first, so callers can pass raw
 *  model output. */
export function describeCwe(raw?: string | null): string | undefined {
    const id = normalizeCwe(raw);
    if (!id) return undefined;
    const title = CWE_TITLES[id];
    return title ? `${id} (${title})` : id;
}

/** MITRE reference URL for a CWE id — used to link the badge in the summary. */
export function cweUrl(raw?: string | null): string | undefined {
    const id = normalizeCwe(raw);
    if (!id) return undefined;
    return `https://cwe.mitre.org/data/definitions/${id.slice(4)}.html`;
}
