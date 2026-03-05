#!/usr/bin/env node

/**
 * Converts planner eval JSONL dataset into promptfoo test cases.
 *
 * Usage: node planner-convert-dataset.js [--limit=N]
 */

const fs = require('fs');
const path = require('path');

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const inputFile = path.join(__dirname, 'datasets', 'planner-eval.jsonl');
const outputFile = path.join(__dirname, 'datasets', 'planner-tests.json');

if (!fs.existsSync(inputFile)) {
    console.error(`Dataset not found: ${inputFile}`);
    process.exit(1);
}

const lines = fs
    .readFileSync(inputFile, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, limit);

// Escape nunjucks template patterns to avoid interpretation
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
    const inputs = data.inputs;
    const outputs = data.outputs;

    // Build diff summary from changedFiles (same logic as eval CLI)
    const changedFiles = inputs.changedFiles || [];
    const changedFilenames = inputs.changedFilenames || changedFiles.map((f) => f.filename || 'unknown');

    const diffItems = changedFiles.map((f) => {
        const filename = f.filename || f.fileName || f.path || 'unknown';
        const diff = f.patchWithLinesStr || f.patch || f.diff || '';
        const truncated =
            String(diff).length > 2000
                ? String(diff).substring(0, 2000) + '\n... (truncated)'
                : String(diff);
        return `### ${filename}\n${truncated}`;
    });

    const diffSummary = diffItems.join('\n\n');

    return {
        description: `Example ${index + 1}: ${changedFilenames.join(', ')}`,
        vars: {
            diffSummary: escapeTemplatePatterns(diffSummary),
            changedFilenames: escapeTemplatePatterns(JSON.stringify(changedFilenames, null, 2)),
            // Reference data for assertions (not used in prompt template)
            expectedSymbols: JSON.stringify(outputs.expectedSymbols || []),
            expectedUpstreamSymbols: JSON.stringify(outputs.expectedUpstreamSymbols || []),
            expectedRiskLevels: JSON.stringify(outputs.expectedRiskLevels || {}),
        },
        assert: [
            {
                type: 'javascript',
                value: 'file://planner-parse-assertion.js',
            },
            {
                type: 'javascript',
                value: 'file://planner-coverage-assertion.js',
            },
        ],
    };
});

fs.writeFileSync(outputFile, JSON.stringify(tests, null, 2));
console.log(`Converted ${tests.length} planner examples to ${outputFile}`);
