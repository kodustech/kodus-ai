// A review-rounds case as the data production reads a pull request from: the
// repository before and after the PR, the team's stored rules, the PR's
// commits as the platform lists them, and its decision store's records.
//
// A case holds the repository at the reviewed head (`repo`) and, per changed
// file, the PR's hunks as the platform returns them (`changedFiles[].patch`).
// The base tree is the head tree with each hunk undone; the platform's file
// list, its patches and the line-numbered rendering the agents read then come
// from production (evals/shared/repo-mirror.js pullRequestFiles,
// FetchChangedFilesStage).

/** The hunks of one changed file's patch: where they start at the head, the head's lines, the base's lines. */
function hunksOf(changed) {
    const hunks = [];
    let cur = null;
    for (const line of String(changed.patch || '').split('\n')) {
        const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (h) {
            cur = { oldStart: Number(h[1]), oldCount: h[2] === undefined ? 1 : Number(h[2]), newStart: Number(h[3]), head: [], base: [] };
            hunks.push(cur);
            continue;
        }
        if (!cur || line.startsWith('\\')) continue;
        const mark = line[0];
        const text = line.slice(1);
        if (mark === '+') cur.head.push(text);
        else if (mark === '-') cur.base.push(text);
        else if (mark === ' ') {
            cur.head.push(text);
            cur.base.push(text);
        }
    }
    return hunks;
}

const sameLines = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Where the hunk's head lines stand in the file: at their recorded start, else the one place they occur. */
function locate(lines, hunk, filename) {
    const at = hunk.newStart - 1;
    if (sameLines(lines.slice(at, at + hunk.head.length), hunk.head)) return at;
    const found = [];
    for (let i = 0; i + hunk.head.length <= lines.length; i++) {
        if (sameLines(lines.slice(i, i + hunk.head.length), hunk.head)) found.push(i);
    }
    if (found.length === 1) return found[0];
    throw new Error(`case data: the hunk of ${filename} at +${hunk.newStart} is ${found.length ? 'ambiguous' : 'not'} in the repository at the head`);
}

/** The repository before the PR: the head tree with every changed file's hunks undone. */
function baseTreeOf(c) {
    const base = { ...c.repo };
    // A case may list one file's hunks as several entries: undo them together.
    const byFile = new Map();
    for (const changed of c.changedFiles || []) {
        byFile.set(changed.filename, [...(byFile.get(changed.filename) || []), ...hunksOf(changed)]);
    }
    for (const [file, fileHunks] of byFile) {
        const hunks = [...fileHunks].sort((a, b) => b.newStart - a.newStart);
        if (!hunks.length) throw new Error(`case data: ${file} has no hunk`);
        // A file the PR adds: one hunk from nothing.
        if (hunks.length === 1 && hunks[0].oldStart === 0 && hunks[0].oldCount === 0) {
            delete base[file];
            continue;
        }
        if (base[file] === undefined) {
            // A file the PR removes: its base content is the hunk's base side.
            if (hunks.every((h) => h.head.length === 0)) {
                base[file] = `${hunks.flatMap((h) => h.base).join('\n')}\n`;
                continue;
            }
            throw new Error(`case data: ${file} is changed by the PR but not in the repository at the head`);
        }
        const lines = String(base[file]).split('\n');
        for (const hunk of hunks) {
            const at = locate(lines, hunk, file);
            lines.splice(at, hunk.head.length, ...hunk.base);
        }
        base[file] = lines.join('\n');
    }
    return base;
}

/** The PR's commits as the GitHub adapter maps them (fetch-pr-data.js records the same shape). */
function platformCommits(commits = []) {
    return commits.map((c) => ({
        sha: c.sha,
        created_at: c.date,
        message: c.message,
        author: { name: 'dev', email: 'dev@example.com', date: c.date, username: 'dev' },
        parents: [],
    }));
}

/** The PR as the platform returns it, over a repository written for the case. */
function prOf(c) {
    return {
        number: 1,
        title: c.prTitle || 'Review round',
        body: c.prBody || '',
        headRef: 'feature',
        baseRef: 'main',
        repoFiles: c.repo,
        baseFiles: baseTreeOf(c),
        commits: platformCommits(c.commits),
    };
}

/**
 * The decision store's records of the case's earlier suggestions, as
 * PrDecisionStoreService writes them: a file-level record carries the code the
 * suggestion pointed at (`existingCode`, which the repeat check matches on).
 * Where a hand-written record does not give it, it is the record's lines in
 * the tree before this round's change, the version the suggestion was posted
 * on. A record on a file the case's repository does not hold keeps none.
 */
function decisionsOf(c, base = baseTreeOf(c)) {
    return (c.previousDecisions || []).map((d) => {
        // A record the store wrote (lifecycle.js, toRecord) has the field, set or not.
        if ('existingCode' in d || !d.relevantFile || base[d.relevantFile] === undefined || !d.relevantLinesStart) return d;
        const code = String(base[d.relevantFile])
            .split('\n')
            .slice(d.relevantLinesStart - 1, d.relevantLinesEnd || d.relevantLinesStart)
            .join('\n');
        return code.trim() ? { ...d, existingCode: code } : d;
    });
}

/** The team's stored data: its Kody Rules as the save path writes them (active, every repository, file scope by default). */
function teamOf(c) {
    const { KodyRulesStatus, KodyRulesType, KodyRulesScope } = require('../../libs/kodyRules/domain/interfaces/kodyRules.interface.ts');
    return {
        rules: (c.kodyRules || []).map((r, i) => ({
            repositoryId: 'global',
            status: KodyRulesStatus.ACTIVE,
            type: KodyRulesType.STANDARD,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
            ...r,
            scope: r.scope || KodyRulesScope.FILE,
        })),
    };
}

module.exports = { prOf, teamOf, decisionsOf, baseTreeOf, hunksOf, platformCommits };
