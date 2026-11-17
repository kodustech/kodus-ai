// The mechanical rules the GitHub cases are harvested for, and how a case's
// ground truth is read from a PR: every added line a rule's pattern matches, in
// the source files the harvest scoped it to (TS/TSX, not tests or .d.ts). Shared
// by harvest-github-cases.js and materialize-cases.js so both read the same
// truth.
const PATTERNS = {
    'no-direct-process-env': { rx: /\bprocess\.env\./, title: 'No direct process.env access', rule: 'Application code must not read process.env directly. Resolve configuration through the typed config/env module so values are validated and mockable.', path: '**/*.{ts,tsx}', examples: [{ snippet: 'const url = process.env.DATABASE_URL;', isCorrect: false }, { snippet: "const url = config.get('databaseUrl');", isCorrect: true }] },
    'no-console': { rx: /\bconsole\.(log|warn|error|debug)\s*\(/, title: 'No console.* in app code', rule: 'Never use console.log/console.error/console.warn/console.debug in application code; use the structured logger.', path: '**/*.{ts,tsx}', examples: [{ snippet: "console.log('processing', item.id);", isCorrect: false }, { snippet: "logger.info('processing', { id: item.id });", isCorrect: true }] },
    'no-generic-error': { rx: /\bthrow new Error\(/, title: 'No generic Error — throw a typed error', rule: 'Do not `throw new Error(...)` with the generic Error class. Throw a domain-specific error type so callers can discriminate.', path: '**/*.{ts,tsx}', examples: [{ snippet: "throw new Error('invalid state');", isCorrect: false }, { snippet: "throw new InvalidStateError('invalid state');", isCorrect: true }] },
    'no-any-type': { rx: /(:\s*any\b|\bas any\b)/, title: 'No `any` type', rule: 'Do not use the TypeScript `any` type (annotation or `as any` cast). Use a concrete type or `unknown` with narrowing.', path: '**/*.{ts,tsx}', examples: [{ snippet: 'const data: any = await load();', isCorrect: false }, { snippet: 'const data: unknown = await load();', isCorrect: true }] },
};

// Rules longer than the review's atom threshold (1,000 characters), which
// production decomposes into one atom per condition. Kept apart from PATTERNS
// so the harvester never searches for them; their ground truth is the union of
// the conditions they name. reference-cases.json uses them.
const COMPOUND_PATTERNS = {
    'project-conventions': {
        rx: new RegExp(['no-direct-process-env', 'no-console', 'no-generic-error', 'no-any-type'].map((k) => PATTERNS[k].rx.source).join('|')),
        title: 'Project conventions for application code',
        rule: [
            'Application code follows the conventions in AGENTS.md and CONTRIBUTING.md. Four of them are checked on every pull request, and each is its own finding:',
            '',
            '1. Configuration. Application code must not read process.env directly. Read configuration through the typed config or env module, so every value is validated once at startup, has a documented default, and can be replaced in tests without mutating the process environment.',
            '',
            '2. Logging. Never call console.log, console.error, console.warn or console.debug in application code. Use the structured logger, so every line carries the request context and reaches the log pipeline with a level and fields instead of free text.',
            '',
            '3. Errors. Do not throw the generic Error class. Throw a domain-specific error type (an existing one, or a new subclass next to the code that raises it), so callers can discriminate failures with instanceof and the API layer can map each to the right status code.',
            '',
            '4. Types. Do not use the TypeScript any type, neither as an annotation nor as an `as any` cast. Use a concrete type, or unknown with narrowing at the boundary where the value enters, so type errors surface at compile time instead of in production.',
            '',
            'Tests, fixtures and generated files are out of scope. A finding names which of the four conventions the line breaks.',
        ].join('\n'),
        path: '**/*.{ts,tsx}',
        examples: [
            { snippet: 'const url = process.env.DATABASE_URL;', isCorrect: false },
            { snippet: "console.log('processing', item.id);", isCorrect: false },
            { snippet: "throw new Error('invalid state');", isCorrect: false },
            { snippet: 'const data: any = await load();', isCorrect: false },
            { snippet: "const url = config.get('databaseUrl');", isCorrect: true },
        ],
    },
};

// The files a case's ground truth covers: TS/TSX source with a patch, not tests
// or declarations. The PR's other files still reach the review; they are not
// scored either way.
const inScope = (f) => /\.(ts|tsx)$/.test(f.filename) && !/\.(spec|test|d)\.ts/.test(f.filename) && !!f.patch;

// The added lines of a unified patch with their line in the new file.
function addedLines(patch) {
    const out = [];
    let line;
    for (const raw of String(patch || '').split('\n')) {
        const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (h) { line = +h[1]; continue; }
        if (line === undefined || raw.startsWith('\\')) continue;
        if (raw.startsWith('+')) { out.push({ line, code: raw.slice(1) }); line++; }
        else if (!raw.startsWith('-')) line++;
    }
    return out;
}

module.exports = { PATTERNS, COMPOUND_PATTERNS, inScope, addedLines };
