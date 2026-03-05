#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Accept --lang argument: tsjs, python, java, ruby, tsjs_crossfile, all (default: all)
// Accept --limit=N argument: max examples per language (default: all)
// Accept --dir=DIR argument: dataset directory (default: datasets)
// Accept --dataset-type=normal|crossfile|all argument (default: all)
const langArg = process.argv.find(a => a.startsWith('--lang='));
const lang = langArg ? langArg.split('=')[1] : 'all';
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;
const dirArg = process.argv.find(a => a.startsWith('--dir='));
const datasetDir = dirArg ? dirArg.split('=')[1] : 'datasets_ast';
const datasetTypeArg = process.argv.find(a => a.startsWith('--dataset-type='));
const datasetType = datasetTypeArg ? datasetTypeArg.split('=')[1] : 'all';

const ALL_DATASETS = {
    tsjs: 'tsjs.jsonl',
    tsjs_crossfile: 'tsjs_crossfile.jsonl',
    react: 'react.jsonl',
    react_crossfile: 'react_crossfile.jsonl',
    python: 'python.jsonl',
    python_crossfile: 'python_crossfile.jsonl',
    java: 'java.jsonl',
    java_crossfile: 'java_crossfile.jsonl',
    ruby: 'ruby.jsonl',
    ruby_crossfile: 'ruby_crossfile.jsonl',
    false_positives: 'false_positives.jsonl',
};

// Filter by --dataset-type
function filterByDatasetType(datasets) {
    if (datasetType === 'all') {
        // 'all' excludes false_positives (opt-in only)
        return Object.fromEntries(Object.entries(datasets).filter(([key]) => key !== 'false_positives'));
    }
    if (datasetType === 'normal') {
        return Object.fromEntries(Object.entries(datasets).filter(([key]) => !key.endsWith('_crossfile') && key !== 'false_positives'));
    }
    if (datasetType === 'crossfile') {
        return Object.fromEntries(Object.entries(datasets).filter(([key]) => key.endsWith('_crossfile')));
    }
    if (datasetType === 'false_positives') {
        return { false_positives: datasets.false_positives };
    }
    console.error(`Unknown dataset-type: ${datasetType}. Options: normal, crossfile, false_positives, all`);
    process.exit(1);
}

const DATASETS = filterByDatasetType(ALL_DATASETS);

const files = lang === 'all'
    ? Object.values(DATASETS)
    : DATASETS[lang]
        ? [DATASETS[lang]]
        : (() => { console.error(`Unknown lang: ${lang}. Options: ${Object.keys(DATASETS).join(', ')}, all`); process.exit(1); })();

const outputFile = path.join(__dirname, 'datasets', 'codereview-tests.json');

const lines = files.flatMap(file => {
    const filePath = path.join(__dirname, datasetDir, file);
    if (!fs.existsSync(filePath)) {
        console.warn(`Warning: ${file} not found, skipping`);
        return [];
    }
    const allLines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).filter(line => {
        try { JSON.parse(line); return true; } catch { console.warn(`Warning: skipping malformed JSON line in ${file}`); return false; }
    });
    return allLines.slice(0, limit);
});

// Cross-file context instructions — mirrors the production prompt in codeReview.ts
// (prompt_codereview_system_gemini_v2, lines 1447-1453)
const CROSS_FILE_INSTRUCTIONS = `### Codebase Context (REAL CODE — treat as visible evidence)

The snippets below are **actual code from the repository** (not hypothetical). They show callers, consumers, upstream dependencies, or infrastructure used by the code being changed in this PR.

**You MUST check for broken contracts between the diff and these snippets:**
- A caller passing a string literal (event name, key, enum value) that no longer exists in the mapping/config changed by the diff
- A consumer relying on a return type, enum value, event name, or config key that the diff renames, changes, or removes
- A caller passing arguments that no longer match the new function signature
- A mapping/config that references identifiers renamed or deleted in the diff

**EQUALLY IMPORTANT — use snippets to DISCARD false concerns:**
These snippets are your source of truth about how the surrounding codebase works. Before reporting ANY issue, check whether a snippet already answers or refutes your concern. If a snippet provides evidence that your concern is already handled — by any mechanism visible in the snippet — you MUST discard the suggestion. Do NOT ignore snippet evidence to justify a finding.

Examples of when to discard:
- A snippet shows a wrapper function already sanitizes input → do not report injection in the inner function
- A snippet shows an ORM enforces constraints at the DB level → do not report missing validation in application code
- A snippet shows retry/backoff logic around a network call → do not report unhandled transient failures in the caller

**PRIORITY: Runtime-breaking bugs (wrong string literal, removed enum value, renamed key) take absolute priority over type-narrowing or type-safety improvements.** If a snippet shows code that WILL throw an error or silently fail at runtime, ALWAYS report it as a bug — even if you also see type-level improvements to suggest. Do NOT report type improvements instead of a runtime bug.

**HOW TO REPORT cross-file bugs:**
- Set \`relevantFile\` to the file under review (the diff file), since that is where the breaking change was introduced
- Set \`relevantLinesStart/End\` to the diff lines that introduced the breaking change
- In \`suggestionContent\`, explicitly name the cross-file consumer that will break (e.g., "PaymentService.ts still calls send(\\"paymentCaptured\\") but this event no longer exists in the mapping")
- The proof IS the snippet — you do not need to guess hypothetical inputs. The snippet is real code that will execute`;

/**
 * Format cross-file snippets into the full External Context section.
 * Mirrors the production formatting in codeReview.ts.
 *
 * @param {Array<{filePath: string, relatedSymbol?: string, rationale: string, content: string}>} snippets
 * @returns {string} The full context block to inject, or '' if no snippets
 */
function formatCrossFileContext(snippets) {
    if (!snippets || !snippets.length) return '';

    const snippetLines = snippets.map(s =>
        `### ${s.filePath}${s.relatedSymbol ? ` (symbol: ${s.relatedSymbol})` : ''}\n**Rationale:** ${s.rationale}\n\`\`\`\n${s.content}\n\`\`\``
    );

    const codebaseContextBlock = `${CROSS_FILE_INSTRUCTIONS}\n\n${snippetLines.join('\n\n')}`;

    return `## External Context & Injected Knowledge\n\nThe following information is provided to ground your analysis in the broader system reality. Use this as your source of truth.\n\n---\n\n${codebaseContextBlock}`;
}

// Escape template patterns to avoid nunjucks interpretation
// Using {% raw %}...{% endraw %} or just escaping the braces
function escapeTemplatePatterns(str) {
    if (!str) return str;
    return str
        .replace(/\{\{/g, '{ {')
        .replace(/\}\}/g, '} }')
        .replace(/\{%/g, '{ %')
        .replace(/%\}/g, '% }');
}

const tests = lines.map((line, index) => {
    const data = JSON.parse(line);
    const inputs = data.inputs?.inputs || data.inputs || {};
    const outputs = data.outputs?.reference_outputs || data.outputs || {};

    const codeSuggestions = outputs.codeSuggestions || [];

    // Extract PR summary from pullRequest.body (same as LangSmith eval)
    const prSummary = inputs.pullRequest?.body || '';

    // Build cross-file context section from snippets (if present)
    const crossFileSnippets = inputs.crossFileSnippets || [];
    const crossFileContext = formatCrossFileContext(crossFileSnippets);

    // Extract reference bugs with line info for the line accuracy assertion
    const referenceBugs = codeSuggestions.map(s => ({
        relevantFile: s.relevantFile,
        relevantLinesStart: s.relevantLinesStart,
        relevantLinesEnd: s.relevantLinesEnd,
    }));

    // Use different assertions for false-positive trap cases
    const isFalsePositive = data.metadata?.categories?.includes('false_positive_trap');

    const assertions = isFalsePositive
        ? [
            // False-positive precision: 0 suggestions = 1.0, more = lower score
            {
                type: 'javascript',
                value: 'file://false-positive-assertion.js',
            },
        ]
        : [
            // Production parser check - uses same logic as LLMResponseProcessor.processResponse()
            {
                type: 'javascript',
                value: 'file://parse-assertion.js',
            },
            // Dual LLM judge (Sonnet + GPT) - calls APIs directly, bypasses llm-rubric
            {
                type: 'javascript',
                value: 'file://judge-assertion.js',
            },
            // Line accuracy assertion - deterministic IoU comparison
            {
                type: 'javascript',
                value: 'file://line-accuracy-assertion.js',
            }
        ];

    return {
        description: `Example ${index + 1}: ${inputs.filePath || 'unknown'}`,
        vars: {
            // Variables matching the exact Kodus prompt user template
            fileContent: escapeTemplatePatterns(inputs.fileContent || ''),
            patchWithLinesStr: escapeTemplatePatterns(inputs.patchWithLinesStr || ''),
            prSummary: escapeTemplatePatterns(prSummary),
            // Cross-file context (empty string when no snippets, full section when present)
            crossFileContext: escapeTemplatePatterns(crossFileContext),
            // Reference data for assertions (not used in prompt template)
            referenceBugs: JSON.stringify(referenceBugs),
            referenceCodeSuggestions: JSON.stringify(codeSuggestions, null, 2),
        },
        assert: assertions,
    };
});

fs.writeFileSync(outputFile, JSON.stringify(tests, null, 2));
console.log(`Converted ${tests.length} examples to ${outputFile}`);
