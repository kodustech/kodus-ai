// Usage: node compare-baseline.js <baseline.json> <new.json>
// Compares TP scores between baseline and new prompt
const path = require('path');
const baseFile = process.argv[2] || 'results/output-normal.json';
const newFile = process.argv[3] || 'results/tp-sample-v6.json';

const baseData = require(path.resolve(baseFile));
const newData = require(path.resolve(newFile));

const baseResults = baseData.results.results || [];
const newResults = newData.results.results || [];

// Filter baseline to Gemini 2.5 Pro only
const geminiBase = baseResults.filter(r => {
    const pid = typeof r.provider === 'string' ? r.provider : (r.provider && r.provider.id) || '';
    return pid.includes('gemini-2.5-pro');
});

console.log('Baseline total results:', baseResults.length);
console.log('Baseline Gemini 2.5 Pro:', geminiBase.length);
console.log('New results:', newResults.length);
console.log('');

// Compare scores for matching examples (every 5th from baseline = our sample)
let baseTotal = 0, newTotal = 0, count = 0;
const sampleIndices = [];
for (let i = 0; i < geminiBase.length && count < newResults.length; i += 5) {
    sampleIndices.push(i);
    count++;
}

console.log('=== Score Comparison (judge component) ===');
sampleIndices.forEach((baseIdx, i) => {
    if (i >= newResults.length) return;
    const br = geminiBase[baseIdx];
    const nr = newResults[i];

    const bComps = br.gradingResult.componentResults || [];
    const nComps = nr.gradingResult.componentResults || [];

    // Judge is typically the 2nd component (index 1)
    const bJudge = bComps[1] ? bComps[1].score || 0 : 0;
    const nJudge = nComps[1] ? nComps[1].score || 0 : 0;

    const bScore = br.gradingResult.score || 0;
    const nScore = nr.gradingResult.score || 0;

    baseTotal += bScore;
    newTotal += nScore;

    const diff = nScore - bScore;
    const arrow = diff > 0.05 ? ' ▲' : diff < -0.05 ? ' ▼' : ' ≈';
    console.log(`Ex${i}: base=${bScore.toFixed(2)} new=${nScore.toFixed(2)} (judge: ${bJudge.toFixed(2)}→${nJudge.toFixed(2)})${arrow}`);
});

console.log('');
console.log(`Baseline avg: ${(baseTotal / sampleIndices.length).toFixed(3)}`);
console.log(`New avg:      ${(newTotal / sampleIndices.length).toFixed(3)}`);
const diff = newTotal / sampleIndices.length - baseTotal / sampleIndices.length;
console.log(`Delta:        ${diff > 0 ? '+' : ''}${diff.toFixed(3)} (${diff > 0 ? 'IMPROVEMENT' : diff < -0.05 ? 'REGRESSION' : 'NEUTRAL'})`);
