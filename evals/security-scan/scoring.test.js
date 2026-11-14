const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assignAdvisories, findingKey } = require('./scoring');
const finding = { vulnerabilityClass: 'authz', filePath: 'routes.ts', startLine: 221, endLine: 223, symbol: 'handle' };
const advisory = id => ({ id, class: 'authz', locations: [{ file: 'routes.ts', line: '221-223' }] });
test('one finding cannot claim three advisories at the same location', () => {
    const scored = assignAdvisories([finding], [advisory('a'), advisory('b'), advisory('c')]);
    assert.equal(scored.consumed.size, 1);
});
test('duplicate reports cannot inflate listed precision', () => {
    const { assignments } = assignAdvisories([finding, {...finding}], [advisory('a')]);
    assert.equal(assignments.filter(Boolean).length, 1);
});
test('another class at the same location is not a listed hit', () => {
    assert.equal(assignAdvisories([{...finding, vulnerabilityClass: 'ssrf'}], [advisory('a')]).consumed.size, 0);
});
test('line ranges and the established line window are preserved', () => {
    assert.equal(assignAdvisories([{...finding, startLine: 238, endLine: 238}], [advisory('a')]).consumed.size, 1);
    assert.equal(assignAdvisories([{...finding, startLine: 239, endLine: 239}], [advisory('a')]).consumed.size, 0);
});
test('judgments do not cross different findings inside one symbol', () => {
    assert.notEqual(findingKey('repo', finding), findingKey('repo', {...finding, startLine: 300}));
});
