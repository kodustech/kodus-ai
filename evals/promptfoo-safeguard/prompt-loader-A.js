const fs = require('fs');
const path = require('path');
const prompt = JSON.parse(fs.readFileSync(path.join(__dirname, 'generated-prompt-A-score.json'), 'utf8'));
module.exports = function() { return JSON.stringify(prompt); };
