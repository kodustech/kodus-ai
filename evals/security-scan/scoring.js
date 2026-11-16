const norm = (f) => String(f || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
const SCORING_VERSION = 4;

function findingKey(caseId, f) {
    return `${caseId}|${f.vulnerabilityClass}|${norm(f.filePath)}|${f.symbol || ''}|${f.startLine}`;
}

function lineRange(line) {
    const m = String(line).match(/^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/);
    return m ? [Number(m[1]), Number(m[2] ?? m[1])] : [NaN, NaN];
}

function matches(finding, advisory) {
    // An unmapped advisory is not evidence for any of the measured classes.
    if (!advisory.class || finding.vulnerabilityClass !== advisory.class) return false;
    return advisory.locations.some((l) => {
        const [from, to] = lineRange(l.line);
        return norm(l.file) === norm(finding.filePath) &&
            from <= (finding.endLine ?? finding.startLine) + 15 &&
            to >= finding.startLine - 15;
    });
}

/** Each finding consumes at most one advisory, and each advisory only once. */
function assignAdvisories(findings, advisories) {
    const consumed = new Set();
    const assignments = findings.map(f => {
        const advisory = advisories.find(a => !consumed.has(a) && matches(f, a));
        if (advisory) consumed.add(advisory);
        return advisory;
    });
    return { assignments, consumed };
}

/** A verdict certifies this exact claim, not every future claim at its location. */
function judgmentDigest(finding) {
    const { createHash } = require('crypto');
    const contents = {
        class: finding.vulnerabilityClass ?? finding.class,
        file: norm(finding.filePath ?? finding.file),
        lines: finding.lines ?? [finding.startLine, finding.endLine],
        symbol: finding.symbol ?? '',
        title: finding.title ?? '',
        description: finding.description ?? '',
    };
    return createHash('sha256').update(JSON.stringify(contents)).digest('hex');
}

function judgmentFor(caseId, finding, adjudications) {
    const asFinding = {
        vulnerabilityClass: finding.vulnerabilityClass ?? finding.class,
        filePath: finding.filePath ?? finding.file,
        symbol: finding.symbol,
        startLine: finding.startLine ?? finding.lines?.[0],
    };
    const key = findingKey(caseId, asFinding);
    const saved = adjudications._metadata?.judgments?.[key];
    const records = Array.isArray(saved) ? saved : saved ? [saved] : [];
    if (records.length === 0) return undefined;
    const digest = judgmentDigest(finding);
    const record = records.find(r => r.findingSha256 === digest &&
        /^[a-f0-9]{64}$/.test(r.sourceResultSha256 ?? '') && r.judge && r.date);
    const verdict = record?.verdict;
    return verdict === 'real' || verdict === 'false' ? verdict : undefined;
}

module.exports = { SCORING_VERSION, findingKey, lineRange, matches, assignAdvisories, judgmentDigest, judgmentFor };
