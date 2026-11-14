const norm = (f) => String(f || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');

function findingKey(caseId, f) {
    return `${caseId}|${f.vulnerabilityClass}|${norm(f.filePath)}|${f.symbol || ''}|${f.startLine}`;
}

function lineRange(line) {
    const m = String(line).match(/^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/);
    return m ? [Number(m[1]), Number(m[2] ?? m[1])] : [NaN, NaN];
}

function matches(finding, advisory) {
    if (advisory.class && finding.vulnerabilityClass !== advisory.class) return false;
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

module.exports = { findingKey, lineRange, matches, assignAdvisories };
