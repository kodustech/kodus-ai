// Invoke the REAL production format prompt/parse on any secondary model.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { generateText } = require('ai');
const {
    buildFormatPrompt,
    parseFormatResponse,
} = require('@libs/code-review/infrastructure/agents/engine/format-prompt');
const {
    buildSecondaryModel,
    SECONDARY_BASELINE,
} = require('../shared/secondary-models');

/**
 * @param {Array} findings
 * @param {string} modelKey
 * @param {{ customWritingGuidelines?: string, languageLabel?: string, temperature?: number }} opts
 */
async function runFormat(findings, modelKey = SECONDARY_BASELINE, opts = {}) {
    if (!findings.length) {
        return { formatted: new Map(), parseOk: true };
    }

    const model = await buildSecondaryModel(modelKey);
    const suggestions = findings.map((f) => ({
        suggestionContent: f.suggestionContent || '',
        existingCode: f.existingCode || '',
        improvedCode: f.improvedCode || '',
        relevantFile: f.relevantFile || '',
        language: f.language || '',
    }));

    const prompt = buildFormatPrompt(suggestions, {
        customWritingGuidelines: opts.customWritingGuidelines,
        languageLabel: opts.languageLabel || null,
    });

    const result = await generateText({
        model,
        prompt,
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    });

    const text = result.text || '';
    const { formatted, parseOk } = parseFormatResponse(text);
    return { formatted, parseOk, raw: text };
}

module.exports = { runFormat };
