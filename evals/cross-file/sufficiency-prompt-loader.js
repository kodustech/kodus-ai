/**
 * Loads the pre-generated sufficiency prompt from JSON.
 *
 * To regenerate the prompt after codebase changes, run:
 *   npx ts-node evals/cross-file/sufficiency-generate-prompt.ts
 */

const fs = require('fs');
const path = require('path');

const promptPath = path.join(__dirname, 'sufficiency-generated-prompt.json');
const prompt = JSON.parse(fs.readFileSync(promptPath, 'utf8'));

module.exports = function (context) {
    return JSON.stringify(prompt);
};
