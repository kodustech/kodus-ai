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
test('an unclassified advisory cannot certify a finding at the same location', () => {
    const { assignments } = assignAdvisories([finding], [{ ...advisory('out-of-scope'), class: null }]);
    assert.equal(assignments.filter(Boolean).length, 0);
});
test('line ranges and the established line window are preserved', () => {
    assert.equal(assignAdvisories([{...finding, startLine: 238, endLine: 238}], [advisory('a')]).consumed.size, 1);
    assert.equal(assignAdvisories([{...finding, startLine: 239, endLine: 239}], [advisory('a')]).consumed.size, 0);
});
test('judgments do not cross different findings inside one symbol', () => {
    assert.notEqual(findingKey('repo', finding), findingKey('repo', {...finding, startLine: 300}));
});

const { judgmentDigest, judgmentFor } = require('./scoring');
const report = { class: 'authz', file: 'routes.ts', lines: [221, 223], symbol: 'handle', title: 'Foreign record read', description: 'A caller reads another tenant record.' };
const record = (f, verdict = 'real') => ({ findingSha256: judgmentDigest(f), sourceResultSha256: 'a'.repeat(64), judge: 'source reviewer', date: '2026-11-16', verdict });
const withRecords = (...records) => ({ [findingKey('repo', finding)]: 'real', _metadata: { judgments: { [findingKey('repo', finding)]: records } } });
test('another claim at the same class/file/symbol/line cannot inherit a verdict', () => {
    const judgments = withRecords(record(report));
    assert.equal(judgmentFor('repo', report, judgments), 'real');
    assert.equal(judgmentFor('repo', {...report, description: 'A different alleged vulnerability.'}, judgments), undefined);
});
test('a legacy key without source and content provenance is unjudged', () => {
    assert.equal(judgmentFor('repo', report, {[findingKey('repo', finding)]: 'real'}), undefined);
});
test('different measured claims under the same key keep separate verdict history', () => {
    const changed = {...report, title: 'An ordinary public resource'};
    const judgments = withRecords(record(report), record(changed, 'false'));
    assert.equal(judgmentFor('repo', report, judgments), 'real');
    assert.equal(judgmentFor('repo', changed, judgments), 'false');
});
test('a judgment recorded from the engine also applies when rescoring its saved result', () => {
    const engineReport = {...finding, title: report.title, description: report.description};
    const judgments = withRecords(record(engineReport));
    assert.equal(judgmentFor('repo', engineReport, judgments), 'real');
    assert.equal(judgmentFor('repo', report, judgments), 'real');
});
test('missing source provenance cannot certify a finding', () => {
    const bad = {...record(report), sourceResultSha256: ''};
    assert.equal(judgmentFor('repo', report, withRecords(bad)), undefined);
    assert.equal(judgmentFor('repo', report, withRecords({...record(report), judge: ''})), undefined);
});
test('saved scoring labels cannot override a source judgment or certify a stale digest', () => {
    const display = {...report, matched: false, verdict: 'real', key: 'display only'};
    assert.equal(judgmentFor('repo', display, withRecords(record(report, 'false'))), 'false');
    const engineReport = {...finding, title: report.title, description: report.description};
    assert.equal(judgmentFor('repo', engineReport, withRecords({...record(engineReport), findingSha256: '0'.repeat(64)})), undefined);
});
