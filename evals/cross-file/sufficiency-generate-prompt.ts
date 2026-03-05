#!/usr/bin/env npx ts-node

/**
 * Generates the sufficiency evaluator prompt JSON for promptfoo evaluation.
 * Uses the actual codebase prompt with nunjucks template variables.
 *
 * Usage: npx ts-node evals/cross-file/sufficiency-generate-prompt.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { prompt_cross_file_context_sufficiency } from '../../libs/common/utils/langchainCommon/prompts/codeReviewCrossFileContextSufficiency';

// Use unique markers that we'll replace with nunjucks template variables
const DIFF_MARKER = '__PROMPTFOO_DIFF_SUMMARY__';
const FILES_MARKER = '__PROMPTFOO_CHANGED_FILES__';
const LANGUAGE_MARKER = '__PROMPTFOO_LANGUAGE__';

// Build marker queries and snippets for placeholder replacement
const markerQueries = [
    {
        symbolName: '__MARKER_SYM__',
        pattern: '__MARKER_PAT__',
        riskLevel: 'high',
        rationale: '__MARKER_RAT__',
        sourceFile: '__MARKER_SRC__',
        foundResults: true,
    },
];

const markerSnippets = [
    {
        filePath: '__MARKER_FILE__',
        relatedSymbol: '__MARKER_RELSYM__',
        rationale: '__MARKER_SNIPRAT__',
        riskLevel: 'high',
        hop: 1,
    },
];

const rawPrompt = prompt_cross_file_context_sufficiency({
    changedFilenames: [FILES_MARKER],
    diffSummary: DIFF_MARKER,
    language: LANGUAGE_MARKER,
    originalQueries: markerQueries,
    collectedSnippetsSummary: markerSnippets,
});

// Replace markers with nunjucks template variables.
// The prompt renders queries and snippets inline, so we replace the entire
// sections with template variables that the prompt loader will fill.
let systemContent = rawPrompt
    .replace(DIFF_MARKER, '{{diffSummary}}')
    .replace(LANGUAGE_MARKER, '{{language}}');

// changedFilenames gets JSON.stringified in the prompt
systemContent = systemContent.replace(
    /\[\s*"__PROMPTFOO_CHANGED_FILES__"\s*\]/s,
    '{{changedFilenames}}',
);

// Replace the rendered queries section with template variable
// The prompt renders queries as bullet lists, so we replace from the
// "Queries that found results" section marker
const queriesFoundStart = systemContent.indexOf(
    '#### Queries that found results:',
);
const snippetsSectionStart = systemContent.indexOf(
    '### Collected Context Summary',
);

if (queriesFoundStart !== -1 && snippetsSectionStart !== -1) {
    // Replace the entire queries section (both found and not-found) with a template var
    systemContent =
        systemContent.substring(0, queriesFoundStart) +
        '{{originalQueries}}\n\n' +
        systemContent.substring(snippetsSectionStart);
}

// Replace the rendered snippets section with template variable
const snippetsListStart = systemContent.indexOf(
    '### Collected Context Summary',
);
const evalCriteriaStart = systemContent.indexOf('## Evaluation Criteria');

if (snippetsListStart !== -1 && evalCriteriaStart !== -1) {
    systemContent =
        systemContent.substring(0, snippetsListStart) +
        '### Collected Context Summary\n{{collectedSnippetsSummary}}\n\n' +
        systemContent.substring(evalCriteriaStart);
}

const prompt = [
    { role: 'system', content: systemContent },
    {
        role: 'user',
        content:
            'Evaluate whether the collected cross-file context is sufficient. Return the response in the specified JSON format.',
    },
];

const outputPath = path.join(__dirname, 'sufficiency-generated-prompt.json');
fs.writeFileSync(outputPath, JSON.stringify(prompt, null, 2));

console.log(`Sufficiency prompt generated: ${outputPath}`);
console.log(`System prompt length: ${systemContent.length} chars`);
