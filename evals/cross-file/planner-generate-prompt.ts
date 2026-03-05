#!/usr/bin/env npx ts-node

/**
 * Generates the planner prompt JSON for promptfoo evaluation.
 * Uses the actual codebase prompt with nunjucks template variables.
 *
 * Usage: npx ts-node evals/cross-file/planner-generate-prompt.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { prompt_cross_file_context_planner } from '../../libs/common/utils/langchainCommon/prompts/codeReviewCrossFileContextPlanner';

// Use unique markers that we'll replace with nunjucks template variables
const DIFF_MARKER = '__PROMPTFOO_DIFF_SUMMARY__';
const FILES_MARKER = '__PROMPTFOO_CHANGED_FILES__';

const rawPrompt = prompt_cross_file_context_planner({
    diffSummary: DIFF_MARKER,
    changedFilenames: [FILES_MARKER],
    language: 'en-US',
});

// Replace markers with nunjucks template variables.
// changedFilenames gets JSON.stringified in the prompt, so we need to match the
// serialized array form: [\n  "__PROMPTFOO_CHANGED_FILES__"\n]
const systemContent = rawPrompt
    .replace(DIFF_MARKER, '{{diffSummary}}')
    .replace(/\[\s*"__PROMPTFOO_CHANGED_FILES__"\s*\]/s, '{{changedFilenames}}');

const prompt = [
    { role: 'system', content: systemContent },
    {
        role: 'user',
        content:
            'Analyze the diff and generate search queries. Return the response in the specified JSON format.',
    },
];

const outputPath = path.join(__dirname, 'planner-generated-prompt.json');
fs.writeFileSync(outputPath, JSON.stringify(prompt, null, 2));

console.log(`Planner prompt generated: ${outputPath}`);
console.log(`System prompt length: ${systemContent.length} chars`);
