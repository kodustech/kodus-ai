// Usage: node check-results.js <results-file.json>
const path = require('path');
const file = process.argv[2];
if (!file) { console.log('Usage: node check-results.js <file>'); process.exit(1); }

const data = require(path.resolve(file));
const results = data.results.results || [];
results.forEach((r, i) => {
    const output = r.response.output || '';
    const pass = r.gradingResult.pass;
    console.log('Ex' + (i + 1) + ': ' + (pass ? 'PASS' : 'FAIL'));
    if (!pass) {
        try {
            const clean = output.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(clean);
            const suggestions = parsed.codeSuggestions || [];
            suggestions.forEach(s => console.log('  -> ' + (s.suggestionContent || '').substring(0, 140)));
        } catch (e) {
            console.log('  -> ' + output.substring(0, 140));
        }
    }
});
