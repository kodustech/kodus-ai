const fs = require('fs');
const path = require('path');
const prompt = JSON.parse(fs.readFileSync(path.join(__dirname, 'generated-prompt-B-fewshot.json'), 'utf8'));
module.exports = function() { return JSON.stringify(prompt); };
