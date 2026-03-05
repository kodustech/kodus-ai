#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Arguments:
//   --dataset=no_changes|discard|update|all  (default: all)
//   --lang=tsjs|react|java|python|ruby|all   (default: all)
//   --limit=N                                 (default: all examples per file)
const datasetArg = process.argv.find(a => a.startsWith('--dataset='));
const dataset = datasetArg ? datasetArg.split('=')[1] : 'all';
const langArg = process.argv.find(a => a.startsWith('--lang='));
const lang = langArg ? langArg.split('=')[1] : 'all';
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const DATASET_BASE = path.join(__dirname, 'safeguard_datasets');
const DATASET_TYPES = ['no_changes', 'discard', 'update'];
const LANGUAGES = ['tsjs', 'tsjs_crossfile', 'react', 'react_crossfile', 'java', 'java_crossfile', 'python', 'python_crossfile', 'ruby', 'ruby_crossfile', 'false_positives'];

// Resolve which dataset types to load
const datasetTypes = dataset === 'all'
    ? DATASET_TYPES
    : DATASET_TYPES.includes(dataset)
        ? [dataset]
        : (() => { console.error(`Unknown dataset: ${dataset}. Options: ${DATASET_TYPES.join(', ')}, all`); process.exit(1); })();

// Resolve which languages to load
const languages = lang === 'all'
    ? LANGUAGES
    : LANGUAGES.filter(l => l === lang || l === `${lang}_crossfile`);

if (languages.length === 0) {
    console.error(`Unknown lang: ${lang}. Options: tsjs, react, java, python, ruby, all`);
    process.exit(1);
}

const outputFile = path.join(__dirname, 'datasets', 'safeguard-tests.json');

// Collect all JSONL lines from matching files
const lines = datasetTypes.flatMap(dsType => {
    return languages.flatMap(langFile => {
        const filePath = path.join(DATASET_BASE, dsType, `${langFile}.jsonl`);
        if (!fs.existsSync(filePath)) {
            return [];
        }
        const allLines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).filter(line => {
            try { JSON.parse(line); return true; } catch { console.warn(`Warning: skipping malformed JSON line in ${dsType}/${langFile}.jsonl`); return false; }
        });
        const selected = allLines.slice(0, limit);
        console.log(`  ${dsType}/${langFile}.jsonl: ${selected.length} examples`);
        return selected;
    });
});

// Cross-file context preamble — mirrors SAFEGUARD_CROSS_FILE_CONTEXT_PREAMBLE from codeReviewSafeguard.ts
const CROSS_FILE_PREAMBLE = `### Codebase Context (additional evidence)

The snippets below are **real code from the repository** — callers, consumers, or dependents of the code being changed in this PR. Use them as extra evidence when evaluating each suggestion.

**Decision guidelines:**

- **keep (no_changes)**: The suggestion is complete and accurate. All affected code is already mentioned in the suggestion, OR the suggestion correctly identifies the core issue and the codebase context only shows repetitions of the same pattern without adding new information.

- **discard**: The suggestion contradicts what these snippets show, or makes claims that are proven false by the codebase context.

- **update**: The suggestion identifies a real problem BUT is incomplete. Use update when:
  * The suggestion mentions only ONE affected file/caller, but the codebase context shows MULTIPLE files/callers with the same issue
  * The suggestion describes the impact generically (e.g., "this will break callers") but doesn't list the specific callers shown in the snippets
  * The suggestion's severity or scope should be adjusted based on additional affected code visible in the snippets
  * When updating, ADD the missing callers/files to the suggestion content, making it more comprehensive and specific`;

/**
 * Format cross-file snippets into the codebase context block.
 * Matches production format from codeReviewSafeguard.ts / llmAnalysis.service.ts.
 */
function formatCodebaseContext(snippets) {
    if (!snippets || !snippets.length) return '';

    const snippetLines = snippets.map(s => {
        const filePath = s.filePath || s.path || 'unknown';
        const code = s.content || s.snippet || '';
        const symbolTag = s.relatedSymbol ? ` (symbol: ${s.relatedSymbol})` : '';
        const rationaleBlock = s.rationale ? `\n**Rationale:** ${s.rationale}` : '';
        return `#### ${filePath}${symbolTag}${rationaleBlock}\n\`\`\`\n${code}\n\`\`\``;
    });

    return `\n\n<codebaseContext>\n${CROSS_FILE_PREAMBLE}\n${snippetLines.join('\n\n')}\n</codebaseContext>`;
}

// Escape template patterns to avoid nunjucks interpretation
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

    const suggestionsToEvaluate = inputs.suggestionsToEvaluate || [];
    const expectedActions = outputs.expectedActions || [];

    // Build suggestionsContext (JSON array of suggestions for the safeguard to evaluate)
    const suggestionsContext = JSON.stringify(suggestionsToEvaluate, null, 2);

    // Build codebaseContext from cross-file snippets
    const crossFileSnippets = inputs.crossFileSnippets || [];
    const codebaseContext = formatCodebaseContext(crossFileSnippets);

    // Collect suggestion IDs for the parse assertion completeness check
    const expectedSuggestionIds = suggestionsToEvaluate.map(s => s.id);

    const datasetType = data.metadata?.expected_action || 'unknown';

    return {
        description: `[${datasetType}] Example ${index + 1}: ${inputs.filePath || 'unknown'}`,
        vars: {
            fileContent: escapeTemplatePatterns(inputs.fileContent || ''),
            patchWithLinesStr: escapeTemplatePatterns(inputs.patchWithLinesStr || ''),
            filePath: escapeTemplatePatterns(inputs.filePath || ''),
            suggestionsContext: escapeTemplatePatterns(suggestionsContext),
            codebaseContext: escapeTemplatePatterns(codebaseContext),
            // Reference data for assertions (not used in prompt template)
            expectedActions: JSON.stringify(expectedActions, null, 2),
            expectedSuggestionIds: JSON.stringify(expectedSuggestionIds),
        },
        assert: [
            // Parse + schema validation
            {
                type: 'javascript',
                value: 'file://parse-assertion.js',
            },
            // Code-based action accuracy (no LLM call)
            {
                type: 'javascript',
                value: 'file://action-assertion.js',
            },
        ]
    };
});

fs.writeFileSync(outputFile, JSON.stringify(tests, null, 2));
console.log(`Converted ${tests.length} safeguard examples to ${outputFile}`);
