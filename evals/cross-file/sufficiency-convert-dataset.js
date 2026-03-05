#!/usr/bin/env node

/**
 * Converts sufficiency eval JSONL dataset into promptfoo test cases.
 *
 * Usage: node sufficiency-convert-dataset.js [--limit=N]
 */

const fs = require('fs');
const path = require('path');

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const inputFile = path.join(__dirname, 'datasets', 'sufficiency-eval.jsonl');
const outputFile = path.join(__dirname, 'datasets', 'sufficiency-tests.json');

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

    return {
        description: `Example ${index + 1}: ${inputs.changedFilenames.join(', ')}`,
        vars: {
            // Template variables for the prompt
            changedFilenames: escapeTemplatePatterns(
                JSON.stringify(inputs.changedFilenames, null, 2),
            ),
            diffSummary: escapeTemplatePatterns(inputs.diffSummary),
            language: inputs.language || 'en-US',
            originalQueries: escapeTemplatePatterns(
                JSON.stringify(inputs.originalQueries, null, 2),
            ),
            collectedSnippetsSummary: escapeTemplatePatterns(
                JSON.stringify(inputs.collectedSnippetsSummary, null, 2),
            ),
            // Reference data for assertions (not used in prompt template)
            expectedSufficient: JSON.stringify(outputs.expectedSufficient),
            expectedMinGaps: JSON.stringify(outputs.expectedMinGaps),
            expectedQuerySymbols: JSON.stringify(
                outputs.expectedQuerySymbols || [],
            ),
            forbiddenPatterns: JSON.stringify(
                outputs.forbiddenPatterns || [],
            ),
        },
        assert: [
            {
                type: 'javascript',
                value: 'file://sufficiency-parse-assertion.js',
            },
            {
                type: 'javascript',
                value: 'file://sufficiency-coverage-assertion.js',
            },
        ],
    };
});

fs.writeFileSync(outputFile, JSON.stringify(tests, null, 2));
console.log(`Converted ${tests.length} sufficiency examples to ${outputFile}`);
