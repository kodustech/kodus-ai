#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const inputFile = path.join(__dirname, '../promptfoo/datasets_ast/false_positives.jsonl');
const outputFile = path.join(__dirname, 'datasets/enrichment-tests.json');

// Original planner-style rationales (generic, written BEFORE search results are known).
// These simulate what the planner actually produces — it describes WHY to search, not WHAT was found.
const ORIGINAL_RATIONALES = {
    1: 'Upstream dependency — find db module to understand query interface used by ApiKeyValidator',
    2: 'Consumer/implementation — find BuildPipeline class to verify test assertions match actual behavior',
    3: 'Consumer — find controllers that import BulkImportDto to check if ArrayMaxSize change affects callers',
    4: 'Consumer — find tests that import from e2b mock to verify mock interface matches usage patterns',
    5: 'Consumer — find callers of normalizeSeverity to verify function contract is preserved',
};

const lines = fs.readFileSync(inputFile, 'utf-8').split('\n').filter(Boolean);

const tests = lines.map((line, index) => {
    const data = JSON.parse(line);
    const inputs = data.inputs?.inputs || data.inputs || {};
    const snippets = inputs.crossFileSnippets || [];
    const exIndex = data.metadata?.index || (index + 1);

    // Replace enriched rationales with original planner-style rationales
    const originalSnippets = snippets.map(s => ({
        ...s,
        rationale: ORIGINAL_RATIONALES[exIndex] || s.rationale,
    }));

    // Build diff summary (same truncation as production enrichRationales())
    const diff = inputs.patchWithLinesStr || '';
    const diffSummary = diff.length > 500
        ? diff.substring(0, 500) + '\n... (truncated)'
        : diff;

    // Format snippet descriptions (same format as production enrichRationales())
    const snippetDescriptions = originalSnippets.map((s, i) =>
        `[${i}] File: ${s.filePath}${s.relatedSymbol ? ` | Symbol: ${s.relatedSymbol}` : ''} | Original rationale: ${s.rationale}\nCode:\n${s.content.substring(0, 2000)}`
    ).join('\n\n');

    return {
        description: `Enrichment Ex${exIndex}: ${inputs.filePath || 'unknown'}`,
        vars: {
            diffSummary,
            snippetDescriptions,
            snippetCount: originalSnippets.length.toString(),
            // For assertions
            snippetFiles: JSON.stringify(originalSnippets.map(s => s.filePath)),
            snippetSymbols: JSON.stringify(originalSnippets.map(s => s.relatedSymbol).filter(Boolean)),
            originalRationales: JSON.stringify(originalSnippets.map(s => s.rationale)),
        },
        assert: [
            {
                type: 'javascript',
                value: 'file://enrichment-parse-assertion.js',
            },
        ],
    };
});

fs.writeFileSync(outputFile, JSON.stringify(tests, null, 2));
console.log(`Converted ${tests.length} enrichment test cases to ${outputFile}`);
