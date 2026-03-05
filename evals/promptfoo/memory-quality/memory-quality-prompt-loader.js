const fs = require('fs');
const path = require('path');

const promptPath = path.join(__dirname, 'generated-memory-quality-prompt.json');

module.exports = function loadPrompt() {
    if (!fs.existsSync(promptPath)) {
        throw new Error(
            `Missing generated prompt at ${promptPath}. Run generate-memory-quality-prompt.js first.`,
        );
    }

    const prompt = JSON.parse(fs.readFileSync(promptPath, 'utf8'));
    return typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
};
