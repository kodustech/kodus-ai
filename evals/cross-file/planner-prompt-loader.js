/**
 * Loads the pre-generated planner prompt from JSON.
 *
 * To regenerate the prompt after codebase changes, run:
 *   npx ts-node evals/cross-file/planner-generate-prompt.ts
 */

const fs = require('fs');
const path = require('path');

const promptPath = path.join(__dirname, 'planner-generated-prompt.json');
const prompt = JSON.parse(fs.readFileSync(promptPath, 'utf8'));

module.exports = function (context) {
    return JSON.stringify(prompt);
};
