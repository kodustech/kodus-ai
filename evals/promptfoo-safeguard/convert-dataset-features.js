#!/usr/bin/env node

/**
 * Converts safeguard JSONL datasets to promptfoo test format
 * using feature-extraction assertions (triage pipeline).
 *
 * Usage:
 *   node convert-dataset-features.js --dataset=discard|no_changes|all --lang=all --limit=N
 */

const fs = require('fs');
const path = require('path');

const datasetArg = process.argv.find(a => a.startsWith('--dataset='));
const dataset = datasetArg ? datasetArg.split('=')[1] : 'all';
const langArg = process.argv.find(a => a.startsWith('--lang='));
const lang = langArg ? langArg.split('=')[1] : 'all';
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const DATASET_BASE = path.join(__dirname, 'safeguard_datasets');
const DATASET_TYPES = ['no_changes', 'discard', 'update'];
const LANGUAGES = ['tsjs', 'tsjs_crossfile', 'react', 'react_crossfile', 'java', 'java_crossfile', 'python', 'python_crossfile', 'ruby', 'ruby_crossfile', 'false_positives'];

const datasetTypes = dataset === 'all'
    ? DATASET_TYPES
    : DATASET_TYPES.includes(dataset)
        ? [dataset]
        : (() => { console.error(`Unknown dataset: ${dataset}`); process.exit(1); })();

const languages = lang === 'all'
    ? LANGUAGES
    : LANGUAGES.filter(l => l === lang || l === `${lang}_crossfile`);

if (languages.length === 0) {
    console.error(`Unknown lang: ${lang}`);
    process.exit(1);
}

const outputFile = path.join(__dirname, 'datasets', 'safeguard-features-tests.json');

const CROSS_FILE_PREAMBLE = `### Codebase Context (additional evidence)

The snippets below are **real code from the repository**. Use them as extra evidence when extracting features for each suggestion.`;

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

function escapeTemplatePatterns(str) {
    if (!str) return str;
    return str
        .replace(/\{\{/g, '{ {')
        .replace(/\}\}/g, '} }')
        .replace(/\{%/g, '{ %')
        .replace(/%\}/g, '% }');
}

const lines = datasetTypes.flatMap(dsType => {
    return languages.flatMap(langFile => {
        const filePath = path.join(DATASET_BASE, dsType, `${langFile}.jsonl`);
        if (!fs.existsSync(filePath)) return [];
        const allLines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).filter(line => {
            try { JSON.parse(line); return true; } catch { return false; }
        });
        const selected = allLines.slice(0, limit);
        console.log(`  ${dsType}/${langFile}.jsonl: ${selected.length} examples`);
        return selected;
    });
});

const tests = lines.map((line, index) => {
    const data = JSON.parse(line);
    const inputs = data.inputs?.inputs || data.inputs || {};
    const outputs = data.outputs?.reference_outputs || data.outputs || {};

    const suggestionsToEvaluate = inputs.suggestionsToEvaluate || [];
    const expectedActions = outputs.expectedActions || [];

    const suggestionsContext = JSON.stringify(suggestionsToEvaluate, null, 2);
    const crossFileSnippets = inputs.crossFileSnippets || [];
    const codebaseContext = formatCodebaseContext(crossFileSnippets);
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
            expectedActions: JSON.stringify(expectedActions, null, 2),
            expectedSuggestionIds: JSON.stringify(expectedSuggestionIds),
        },
        assert: [
            {
                type: 'javascript',
                value: 'file://feature-parse-assertion.js',
            },
            {
                type: 'javascript',
                value: 'file://feature-triage-assertion.js',
            },
        ]
    };
});

fs.writeFileSync(outputFile, JSON.stringify(tests, null, 2));
console.log(`\nConverted ${tests.length} feature extraction examples to ${outputFile}`);
