/** PR context for the dedup judges: the PR diff with head line numbers, cited files first. */
const fs = require('fs');
const path = require('path');

const INV = path.join(__dirname, '..', '..', 'investigation');
const MAX_DIFF_CHARS = 150000;
const MAX_FILE_CHARS = 30000;

// caseId -> dataset entry (the PR diff with line numbers).
let datasetIndex;
function dataset(caseId) {
    if (!datasetIndex) {
        datasetIndex = {};
        for (const f of fs.readdirSync(path.join(INV, 'datasets'))) {
            if (!f.endsWith('.json')) continue;
            try {
                const d = JSON.parse(fs.readFileSync(path.join(INV, 'datasets', f), 'utf8'));
                for (const x of Array.isArray(d) ? d : [d]) if (x?.vars?.caseId) datasetIndex[x.vars.caseId] = x.vars;
            } catch {}
        }
    }
    const v = datasetIndex[caseId];
    if (!v) throw new Error(`no dataset for ${caseId}`);
    return v;
}

function diffFor(caseId, suggestions) {
    const v = dataset(caseId);
    const files = JSON.parse(v.changedFilesFull || v.changedFiles || '[]');
    const cited = new Set(suggestions.map((s) => s.relevantFile));
    // Cited files first, then the rest of the PR while it fits.
    const ordered = [...files.filter((f) => cited.has(f.filename)), ...files.filter((f) => !cited.has(f.filename))];
    let out = '';
    const left = [];
    for (const f of ordered) {
        let p = f.patchWithLinesStr || f.patch || '';
        if (p.length > MAX_FILE_CHARS) p = `${p.slice(0, MAX_FILE_CHARS)}\n... [file diff truncated]`;
        if (out.length + p.length > MAX_DIFF_CHARS) {
            left.push(f.filename);
            continue;
        }
        out += `${p}\n`;
    }
    if (left.length) out += `\n[diff omitted for ${left.length} more files: ${left.join(', ')}]\n`;
    return { title: v.prTitle, diff: out };
}

module.exports = { diffFor };
