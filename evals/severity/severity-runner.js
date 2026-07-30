// Invoke the REAL production severity prompt/parse on any secondary model.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { generateText } = require('ai');
const {
    buildSeverityPrompt,
    parseSeverityResponse,
    DEFAULT_SEVERITY_FLAGS,
} = require('@libs/code-review/infrastructure/agents/engine/severity-prompt');
const {
    buildSecondaryModel,
    SECONDARY_BASELINE,
} = require('../shared/secondary-models');
const { normalizeSeverity } = require('./severity-eval');

/**
 * @param {Array} findings
 * @param {string} modelKey
 * @param {{ flags?: object, temperature?: number }} opts
 * @returns {Promise<{ labels: string[], parseOk: boolean, defaultedAll: boolean, raw?: string }>}
 */
async function runSeverity(findings, modelKey = SECONDARY_BASELINE, opts = {}) {
    if (!findings.length) {
        return { labels: [], parseOk: true, defaultedAll: false };
    }

    const model = await buildSecondaryModel(modelKey);
    const suggestions = findings.map((f) => ({
        relevantFile: f.relevantFile || '',
        suggestionContent: f.suggestionContent || '',
        oneSentenceSummary: f.oneSentenceSummary || '',
        existingCode: f.existingCode || '',
        improvedCode: f.improvedCode || '',
    }));

    const flags = opts.flags || DEFAULT_SEVERITY_FLAGS;
    const prompt = buildSeverityPrompt(suggestions, flags);

    const result = await generateText({
        model,
        prompt,
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    });

    const text = result.text || '';
    const { classifications, parseOk } = parseSeverityResponse(text);

    if (!parseOk) {
        return {
            labels: findings.map(() => 'medium'),
            parseOk: false,
            defaultedAll: true,
            raw: text,
        };
    }

    const labels = findings.map((f, i) => {
        if (classifications.has(i)) {
            return normalizeSeverity(classifications.get(i));
        }
        // Mirror prod: missing index keeps agent severity.
        return normalizeSeverity(f.severity);
    });

    return {
        labels,
        parseOk: true,
        defaultedAll: false,
        raw: text,
        covered: classifications.size,
    };
}

module.exports = { runSeverity };
