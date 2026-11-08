import type { SurfaceHit, VulnClass } from './surface/surface.types';
import type { ScanUnit } from './security-scan.types';

export const VULN_CLASSES: VulnClass[] = [
    'authz',
    'injection',
    'ssrf',
    'data_exposure',
    'secret_identity',
    'misconfiguration',
];

export const DEFAULT_CWE: Record<VulnClass, string> = {
    authz: 'CWE-639',
    injection: 'CWE-74',
    ssrf: 'CWE-918',
    data_exposure: 'CWE-200',
    secret_identity: 'CWE-798',
    misconfiguration: 'CWE-16',
};

/** What each lens hunts, in the words the model reads. */
const CLASS_BRIEF: Record<VulnClass, { name: string; hunt: string; notIt: string }> = {
    authz: {
        name: 'Broken access control (authorization / IDOR)',
        hunt: `- A handler that loads, changes or deletes a record by an id the caller sends (path, query, body, header) without checking the record belongs to the caller or that the caller's role allows it.
- A route or resolver that is missing the guard, decorator or middleware its siblings use, so an unauthenticated or lower-privileged caller reaches it.
- A check done on the wrong object (checks the parent but loads the child by another id), on client-controlled data (a role or tenant id taken from the request body), or only in the UI.
- Mass assignment: a request body copied into a record so the caller can set owner, role, tenant or price fields.`,
        notIt: 'A route that is public by design (login, health, a public listing) is not a finding. "Add rate limiting" or "add an authorization layer" with no concrete record or route the caller can reach is not a finding.',
    },
    injection: {
        name: 'Injection',
        hunt: `- SQL or NoSQL built by concatenating or interpolating caller input (string-built queries, raw query helpers, $where, operator objects taken whole from the request).
- Shell commands built from caller input (exec, system, spawn with shell: true, backticks).
- Code evaluation of caller input (eval, Function, vm, pickle/yaml load, template rendering of caller-controlled templates).
- Paths built from caller input passed to file reads, writes or deletes without containment (path traversal).
- Caller input written into an HTML response or a template without escaping (reflected or stored XSS): HTML built by string concatenation or f-strings, autoescaping turned off, \`|safe\`, \`Markup\`, \`mark_safe\` or \`innerHTML\` on caller data.
- XML parsed with external entities or DTDs enabled (XXE), and redirects to a URL the caller chooses (open redirect).`,
        notIt: 'A parameterized query, an argument-array process call (execFile, spawn without a shell), or input that a check above provably restricts to a fixed set is not a finding.',
    },
    ssrf: {
        name: 'Server-side request forgery',
        hunt: `- An outbound HTTP request, webhook call, image/URL fetch or proxy whose URL or host comes from the caller, without an allow-list of hosts and without blocking internal addresses (localhost, 169.254.169.254, private ranges) after DNS resolution.
- Redirect-following that lets an allowed host bounce the request to an internal one.`,
        notIt: 'A request to a fixed URL, or to a URL taken only from server configuration, is not a finding.',
    },
    data_exposure: {
        name: 'Sensitive data exposure',
        hunt: `- A response that returns a whole user or account object including password hashes, tokens, secrets, internal ids of other tenants or personal data the caller should not see.
- Secrets, tokens or passwords written to logs that people other than the server's operators can read, or returned to a caller who should not hold them.
- Stack traces or internal details (server paths, configuration, queries, other users' data) returned to an unauthenticated caller or to a caller who did not cause the error.`,
        notIt: "Logging a request id or a user id alone is not a finding. A response field the caller owns is not a finding. An error, a traceback or a message that goes back to the user whose own request failed, holding only that user's data, is not a finding. Data the operator writes to the operator's own server logs, or that debug logging the operator turns on prints, is not a finding.",
    },
    secret_identity: {
        name: 'Secrets and identity',
        hunt: `- Hard-coded credentials, API keys, signing secrets or seeded default user passwords in source or committed configuration (not in tests, fixtures or examples): whoever reads the code holds them.
- Passwords stored or compared in plaintext.
- TLS certificate verification turned off on an outbound request.
- Passwords hashed with a fast hash (md5, sha1, sha256 without a KDF) or compared without a constant-time comparison.
- Tokens, session ids, reset codes or keys generated with a non-cryptographic random source (random, Math.random, rand).
- Weak or broken cryptography protecting data: DES, RC4, ECB mode, a static IV, MD5 or SHA-1 for signatures or integrity.
- JWT or signature verification that is disabled, accepts the "none" algorithm, or skips the signature.
- Identity checks that compare case-insensitively or after normalization in one place and not the other.`,
        notIt: 'A placeholder value in an example or a test file, or a secret read from the environment, is not a finding.',
    },
    misconfiguration: {
        name: 'Security misconfiguration',
        hunt: `- A state-changing route (POST, PUT, PATCH, DELETE, or a GET that changes data) served to a browser session with no CSRF protection, or with it explicitly turned off (csrf_exempt, WTF_CSRF_ENABLED = False, csrf().disable()).
- Session or auth cookies set without Secure, HttpOnly or SameSite, or a session secret and cookie settings that let a cookie be read or forged.
- Debug mode, an interactive debugger or detailed error pages enabled in the code or committed configuration the app ships with (app.run(debug=True), DEBUG = True, a Werkzeug console).
- CORS that reflects any origin or allows "*" together with credentials.
- TLS certificate or hostname verification turned off on an outbound connection (verify=False, rejectUnauthorized: false, InsecureSkipVerify: true).
- A file upload that stores any type under the web root, or an XML or YAML parser left in an unsafe default mode the code relies on.`,
        notIt: 'A setting read from the environment, a development-only file that is never deployed (a test settings module, a docker-compose for local runs), or a missing hardening header with no concrete attack is not a finding. "Add rate limiting" is not a finding.',
    },
};

export function buildLensSystemPrompt(vulnClass: VulnClass): string {
    const brief = CLASS_BRIEF[vulnClass];
    return `You are a security engineer auditing a repository for ONE class of vulnerability: ${brief.name}.

You are not reviewing a pull request. You are reading code that already runs in production, starting from the file you are given, and following it wherever the data goes.

What to hunt:
${brief.hunt}

${brief.notIt}

Name the attacker first, and the boundary they cross. The attacker is someone the application does not trust with the thing they get: an unauthenticated caller who reaches what needs a login, a user who reaches another user's or another tenant's data, a user who gains an administrator's power, an outsider who makes the server reach its internal network. If no such boundary is crossed, it is not a finding:
- A capability the application already grants that caller, with nothing limiting it, is not a vulnerability when reached another way: a user who may freely run code or point the server at any URL in one feature gains nothing from doing it in another. But where the application does limit it (a sandbox around user code, a block on internal or metadata addresses, a per-user folder, an allow-list of commands), getting around that limit is a finding.
- What an administrator or the operator configures at run time (environment variables, admin settings, admin-only routes, admin-installed plugins) is trusted. A secret written into the repository is not configuration: whoever reads the code holds it. Nor is an insecure default the code ships with (debug on, CSRF off, permissive CORS, TLS verification off): every deployment that does not override it is exposed.
- A command-line tool, a developer script or a desktop app run by a user on their own machine attacks only that user; so does a local file or socket only the same OS user can reach.
- Data that is public anyway, or a token whose guessing space and lifetime make guessing it impractical, gives the attacker nothing.

A finding must be exploitable, not merely possible:
1. Name where the attacker's input enters (the route, handler, resolver, consumer or CLI argument), with its file and line. Read it; do not guess it.
2. Follow the value to the dangerous operation. Read every function it passes through.
3. Look for what stops it on the way: authentication and authorization guards, middleware, validation, type coercion, parameterization, allow-lists, framework defaults. Read the guard; do not assume one is there or missing.
4. Report it only if nothing on that path stops it. If you could not read the whole path, do not report it.

Use the tools to read and search the repository. Read the callers of a function before you decide who controls its arguments.

Report every distinct vulnerability in these files that meets this bar, up to 15, the most severe first: one finding per vulnerable operation, so two queries built from input are two findings, not one. Do not stop at the first one you confirm. Each finding:
- label: "security"
- relevantFile / relevantLinesStart / relevantLinesEnd: the dangerous operation itself (the query, the exec, the fetch, the missing check), not the entry point.
- suggestionContent: start with one line "Entry: <file>:<line>", then one line "Attacker: <who>, crossing <which boundary>", then the path the input takes, then why nothing on the path stops it, then the impact for this application, then the fix. Plain sentences, no headings.

If you find nothing that meets this bar, submit an empty list. An empty list is a correct answer; a guess is not.`;
}

/**
 * What the lens's verify checks each finding against (the review's lane
 * check, `laneFocus`): a finding that crosses no boundary is out of focus
 * and dropped by the verification it already takes.
 */
export function buildLensFocus(vulnClass: VulnClass): string {
    const brief = CLASS_BRIEF[vulnClass];
    return `Security auditor for one class: ${brief.name}. Its focus is an exploitable vulnerability of that class in which a named attacker crosses a security boundary: an unauthenticated caller reaching what needs a login, a user reaching another user's or another tenant's data, a user gaining an administrator's power, an outsider making the server reach its internal network.
Outside the focus, however real the code smell: a capability the application already grants that caller with nothing limiting it; what an administrator or the operator configures; a command-line tool, developer script or desktop app attacking only the user running it; an error or traceback returned to the user whose own request failed; data that is public anyway; a token or id the attacker has no way to learn or guess; an insecure default the operator is told to change.
Within the focus: getting around a limit the application itself enforces (a sandbox around user code, a block on internal or metadata addresses, a per-user folder, an allow-list), a secret committed to the repository, and an insecure default the code ships with that a remote attacker can use (a CSRF from another site, a debug console, a cross-origin read, a cookie stolen over plain HTTP).`;
}

function formatHits(hits: SurfaceHit[], limit = 40): string {
    if (!hits.length) {
        return '(none)';
    }
    const lines = hits
        .slice(0, limit)
        .map(
            (h) =>
                `- ${h.file}:${h.line} [${h.role}${h.vulnClass ? `/${h.vulnClass}` : ''}${h.framework ? `, ${h.framework}` : ''}] ${h.text.trim().slice(0, 160)}`,
        );
    if (hits.length > limit) {
        lines.push(`- … ${hits.length - limit} more`);
    }
    return lines.join('\n');
}

export function buildLensUserPrompt(params: {
    repositoryFullName: string;
    unit: ScanUnit;
    vulnClass: VulnClass;
    hits: SurfaceHit[];
}): string {
    const { unit } = params;
    const related = unit.relatedFiles.length
        ? unit.relatedFiles.map((f) => `- ${f}`).join('\n')
        : '(none)';
    return `Repository: ${params.repositoryFullName}
Language: ${unit.language}

Start from this file:
${unit.file}

Files the map tied to it:
${related}

Why the map picked it:
${unit.reasons.map((r) => `- ${r}`).join('\n') || '(no reason recorded)'}

What a pattern scan found in these files (entry points, auth checks and dangerous operations; a lead, not a verdict):
${formatHits(params.hits)}

Audit this code for ${CLASS_BRIEF[params.vulnClass].name}. Read the start file first, then follow the data. Submit your findings with submitResult.`;
}

export const MAP_SYSTEM_PROMPT = `You plan a security audit of a repository. A pattern scan already listed the files that hold entry points (routes, handlers, consumers), authentication checks and dangerous operations. You decide which files the auditors read first and what they look for in each.

Rules:
- Only return paths that appear in the candidate list or in the file listing you are given. Never invent a path.
- Rank by how likely the file is to hold an exploitable vulnerability: code reachable from outside (HTTP, RPC, queues, webhooks) that touches the database, the shell, the network, files or secrets ranks first; internal scripts, migrations, tests and generated code rank last or are left out.
- For each file, pick only the vulnerability classes that its code can plausibly have.
- Tie a file to the few files its auditors will need to follow the data (the service a controller calls, the repository a service calls). At most 5.
- You may add a file the pattern scan missed when the listing makes it obvious (for example a custom query helper every service uses, or the app's settings or factory module for misconfiguration), and say why.`;

export function buildMapUserPrompt(params: {
    repositoryFullName: string;
    languages: string[];
    candidates: {
        file: string;
        entryPoints: number;
        authChecks: number;
        sinks: number;
        classes: VulnClass[];
        sample: string[];
    }[];
    listing: string[];
    maxUnits: number;
}): string {
    const candidates = params.candidates
        .map(
            (c) =>
                `- ${c.file} (entry ${c.entryPoints}, auth ${c.authChecks}, sinks ${c.sinks}; ${c.classes.join(', ') || 'no class'})${c.sample.length ? `\n    ${c.sample.join('\n    ')}` : ''}`,
        )
        .join('\n');
    return `Repository: ${params.repositoryFullName}
Languages: ${params.languages.join(', ') || 'unknown'}

Candidate files from the pattern scan:
${candidates || '(none)'}

File listing (may be truncated):
${params.listing.join('\n')}

Return at most ${params.maxUnits} units, highest priority first. Each unit: file, relatedFiles, classes (from: ${VULN_CLASSES.join(', ')}), priority (0-100), reason.`;
}

/**
 * One id per weakness, the one scanners and reports use, so the same bug gets
 * the same CWE from scan to scan and from tool to tool.
 */
const CANONICAL_CWES = [
    'IDOR / record of another user by id → CWE-639',
    'missing authorization check → CWE-862',
    'missing authentication → CWE-306',
    'mass assignment → CWE-915',
    'SQL or NoSQL injection → CWE-89',
    'OS command injection → CWE-78',
    'code injection / eval → CWE-94',
    'template injection (SSTI) → CWE-1336',
    'cross-site scripting (reflected, stored, DOM) → CWE-79',
    'path traversal → CWE-22',
    'XXE → CWE-611',
    'insecure deserialization → CWE-502',
    'open redirect → CWE-601',
    'SSRF → CWE-918',
    'hard-coded or default credentials, keys or secrets → CWE-798',
    'password stored or compared in plaintext → CWE-256',
    'sensitive data in a response or log → CWE-200',
    'error message or stack trace exposing internals → CWE-209',
    'weak hash for passwords → CWE-916',
    'weak cryptographic algorithm → CWE-327',
    'insecure random for security values → CWE-330',
    'JWT or signature not verified → CWE-347',
    'TLS certificate validation off → CWE-295',
    'CSRF → CWE-352',
    'session fixation → CWE-384',
    'cookie without HttpOnly → CWE-1004',
    'cookie without Secure → CWE-614',
    'debug mode in production → CWE-489',
    'permissive CORS → CWE-942',
    'unrestricted file upload → CWE-434',
].join('; ');

export const FINALIZE_SYSTEM_PROMPT = `You turn an auditor's confirmed security finding into a structured record. Do not change what the finding says or judge it again. Fill each field from the finding text and the code shown; if the text does not support a field, give your best reading of the code.`;

export function buildFinalizeUserPrompt(params: {
    vulnClass: VulnClass;
    filePath: string;
    startLine: number;
    endLine: number;
    finding: string;
    code: string;
}): string {
    return `Vulnerability class: ${params.vulnClass}
Location: ${params.filePath}:${params.startLine}-${params.endLine}

Finding:
${params.finding}

Code around the location:
\`\`\`
${params.code}
\`\`\`

Return:
- title: one line, under 90 characters, naming what an attacker can do (not "Potential issue in ...").
- severity: critical (remote, unauthenticated, full compromise or mass data access), high (authenticated user reaches other users' data or code execution), medium (limited data or needs unusual conditions), low (hardening with a concrete but small impact).
- cwe: as "CWE-<number>", the usual id for the weakness. When it is one of these, use exactly this id: ${CANONICAL_CWES}. Otherwise the most common CWE for it, not a rare child.
- attackPath: the steps from the entry point to the dangerous operation, each with file, line and a short note. Start with the entry point.
- fix: two or three sentences on how to fix it in this code.`;
}

export const REPRO_SYSTEM_PROMPT = `You write one automated test that demonstrates a confirmed security vulnerability in a repository, using the test framework the repository already uses.

The test must PASS while the vulnerability is present (it asserts the attacker's success: the other user's record is returned, the injected command ran, the internal URL was requested) and FAIL once the fix is applied. Exercise the vulnerable function directly, with mocks or in-memory fakes for the database and the network: the test runs offline, without the application's services, secrets or a server. Do not test anything else.`;

export function buildReproUserPrompt(params: {
    language: string;
    finding: string;
    filePath: string;
    code: string;
    testHints: string;
}): string {
    return `Language: ${params.language}
Vulnerable code (${params.filePath}):
\`\`\`
${params.code}
\`\`\`

Finding:
${params.finding}

How this repository runs its tests:
${params.testHints || '(no test setup found)'}

Return:
- path: where to write the test, repository-relative, next to the repository's other tests and named so the test runner picks it up.
- content: the whole test file.
- command: the shell command that runs ONLY this test from the repository root, using the repository's own runner (for example "npx jest path/to/file.spec.ts", "python -m pytest path/to/test_x.py", "go test ./pkg/... -run TestX").`;
}
