/**
 * Loads the memory-eval prompt generated from kodus-flow conversation prompts.
 */

const fs = require('fs');
const path = require('path');

const promptPath = path.join(__dirname, 'generated-memory-prompt.json');

module.exports = function() {
    if (!fs.existsSync(promptPath)) {
        throw new Error(
            `Missing generated memory prompt at ${promptPath}. Run evals/promptfoo/generate-memory-prompt.mjs first.`,
        );
    }

    const prompt = JSON.parse(fs.readFileSync(promptPath, 'utf8'));
    return typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
};
