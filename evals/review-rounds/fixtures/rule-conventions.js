// Repository convention files the rules point at (`sourcePath`), so the rule
// judge sees what production sends: KodyRulesAgentProvider reads each rule's
// sourcePath through the sandbox and appends up to 6,000 characters to the
// rule (inlineRuleReferences). In the production DeepSeek reposts the rules
// block was 400K–550K characters, ~6K per rule, while the diff was under 2K.
// Invented text, built deterministically.

const pad = (text, min) => {
    let out = text;
    let n = 1;
    while (out.length < min) {
        out += `\n### Edge case ${n}\n\nA change that only moves code covered by this convention, without changing what it does, is judged on the lines it adds: moved lines are added lines. When the same pattern appears in a helper and in its caller, each site is its own finding. Generated files under \`src/generated/**\` are out of scope; files under \`src/**\` that a generator only seeds are in scope once a person edits them.\n`;
        n += 1;
    }
    return out;
};

function genericConvention(rule) {
    const slug = rule.uuid.replace(/^rule-/, '');
    const fn = slug.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return pad(
        [
            '---',
            `title: "${rule.title}"`,
            'scope: "src/**"',
            `severity: ${rule.severity}`,
            'owner: platform-guild',
            '---',
            '',
            `# ${rule.title}`,
            '',
            rule.rule,
            '',
            '## Why this rule exists',
            '',
            `We adopted "${rule.title}" after reviews kept reopening the same discussion. Each time, the author had a local reason to deviate, and each deviation was reasonable on its own; together they made the codebase harder to read and incidents harder to trace. The rule removes the case-by-case debate: reviewers point at this file, authors follow it, and exceptions are written down here instead of in review threads.`,
            '',
            'The rule is deliberately narrow. It does not ask for refactors of untouched code, and it does not apply to tests unless the rule says so. It applies to lines a pull request adds or changes.',
            '',
            '## What to flag',
            '',
            `- Added lines that break "${rule.title}" as stated above.`,
            '- Moved lines that break it: moving code is adding it in a new place.',
            '- A new helper that wraps the pattern so the call site looks compliant while the helper is not.',
            '- Copy-pasted blocks where one copy was fixed and the other was not.',
            '',
            '## What not to flag',
            '',
            '- Unchanged lines, even when they break the rule; open a cleanup issue instead.',
            '- Code under `src/generated/**`.',
            '- Comments and documentation that quote the forbidden pattern to explain it.',
            '',
            '## Examples',
            '',
            '### Incorrect',
            '',
            '```ts',
            `// Breaks "${rule.title}".`,
            `export function ${fn}Example(input: Input) {`,
            '    // the pattern this convention forbids, written inline',
            '    return legacyPath(input);',
            '}',
            '```',
            '',
            '### Correct',
            '',
            '```ts',
            `// Follows "${rule.title}".`,
            `export function ${fn}Example(input: Input) {`,
            '    // the shared helper or the explicit form this convention asks for',
            '    return approvedPath(input);',
            '}',
            '```',
            '',
            '## How reviewers apply it',
            '',
            '1. Read the added lines of the file, not only the hunk header.',
            '2. For each match, check whether a listed exception applies; if one does, say which.',
            '3. Point at the line and quote this convention once per site; do not repeat it per line of the same site.',
            '4. If the pull request already fixed some sites and left others, flag only the ones left.',
            '',
            '## Exceptions',
            '',
            '- Migration scripts that run once, when the script says so in its header.',
            '- Vendored code under `vendor/**`.',
            '',
            '## History',
            '',
            '- 2025-11: introduced.',
            '- 2026-03: examples rewritten; scope narrowed to `src/**`.',
            '- 2026-08: "moved lines count as added" made explicit after a review missed a moved block.',
            '',
        ].join('\n'),
        6200,
    );
}

// The rule under test gets a real convention, with correct examples.
const LOCAL_DAY = pad(
    [
        '---',
        'title: "Format date-only values in local calendar time"',
        'scope: "src/**"',
        'severity: high',
        'owner: reports',
        '---',
        '',
        '# Format date-only values in local calendar time',
        '',
        'A date-only value (a day, not an instant) is the calendar day the user sees. `toISOString()` renders the UTC instant, so `toISOString().slice(0, 10)` yields the previous day for anyone west of UTC after their local evening. Use `formatLocalDate` from `src/reports/dates.ts`.',
        '',
        '## What to flag',
        '',
        '- `x.toISOString().slice(0, 10)`, `x.toISOString().split(\'T\')[0]` and equivalents used to produce a day.',
        '- Keys, labels and filenames built from those strings.',
        '',
        '## Examples',
        '',
        '### Incorrect',
        '',
        '```ts',
        'const day = range.start.toISOString().slice(0, 10);',
        '```',
        '',
        '### Correct',
        '',
        '```ts',
        'const day = formatLocalDate(range.start);',
        '```',
        '',
        '## Why',
        '',
        'Reports for customers in the Americas showed every daily total one day early after 21:00 local time. The fix was one helper; the cost was a week of support tickets.',
        '',
    ].join('\n'),
    6200,
);

function withConventions(rules) {
    const files = {};
    const out = rules.map((r) => {
        const sourcePath = `.kody/rules/${r.uuid.replace(/^rule-/, '')}.md`;
        files[sourcePath] = r.uuid === 'rule-local-calendar-day' ? LOCAL_DAY : genericConvention(r);
        return { ...r, sourcePath };
    });
    return { rules: out, files };
}

module.exports = { withConventions };
