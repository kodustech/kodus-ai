#!/usr/bin/env node
/**
 * Applies the human review decisions (exported from the review page's store)
 * to the gold files. Approved groups/uniques get `humanReview`; a rejected
 * group loses the removed members (they become unique) and can be merged
 * into another group or unique; a rejected unique joins the chosen target.
 *
 *   node evals/dedup/gold/apply-decisions.js --decisions=review/decisions-pilot.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const decisions = JSON.parse(fs.readFileSync(path.resolve(__dirname, arg('decisions')), 'utf8'));

const golds = {};
const gold = (model) => {
    if (!golds[model]) {
        const f = fs.readdirSync(__dirname).find((x) => x.endsWith('.json') && JSON.parse(fs.readFileSync(path.join(__dirname, x), 'utf8')).model === model);
        golds[model] = { file: path.join(__dirname, f), data: JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')) };
    }
    return golds[model].data;
};

let applied = 0;
let stale = 0;
for (const d of decisions) {
    const pr = gold(d.model).prs[d.caseId];
    const review = { verdict: d.verdict, note: d.note || '', at: d.at };
    if (d.kind === 'group') {
        const g = pr.groups.find((x) => x.groupId === d.target);
        if (!g) {
            stale++;
            continue;
        }
        g.humanReview = review;
        if (d.verdict === 'wrong') {
            g.members = g.members.filter((m) => !(d.remove || []).includes(m));
            for (const m of d.remove || []) pr.uniqueConfidence[m] = 'high';
            const other = d.mergeWith && pr.groups.find((x) => x.groupId === d.mergeWith);
            if (other) {
                g.members.push(...other.members);
                pr.groups = pr.groups.filter((x) => x !== other);
            } else if (d.mergeWith && pr.uniqueConfidence[d.mergeWith]) {
                g.members.push(d.mergeWith);
                delete pr.uniqueConfidence[d.mergeWith];
            }
            if (g.members.length < 2) {
                for (const m of g.members) pr.uniqueConfidence[m] = 'high';
                pr.groups = pr.groups.filter((x) => x !== g);
            }
            g.resolvedBy = 'human';
            g.confidence = 'high';
        }
    } else {
        if (!(d.target in pr.uniqueConfidence)) {
            stale++;
            continue;
        }
        pr.humanReviewUnique = { ...(pr.humanReviewUnique || {}), [d.target]: review };
        if (d.verdict === 'wrong' && d.mergeWith) {
            delete pr.uniqueConfidence[d.target];
            const g = pr.groups.find((x) => x.groupId === d.mergeWith);
            if (g) g.members.push(d.target);
            else if (pr.uniqueConfidence[d.mergeWith]) {
                delete pr.uniqueConfidence[d.mergeWith];
                pr.groups.push({ members: [d.target, d.mergeWith], kind: 'same_location', needsUnifiedComment: false, confidence: 'high', defect: d.note || '', resolvedBy: 'human', humanReview: review });
            }
        }
    }
    applied++;
}

// Re-derive ids and per-suggestion fields after any change.
for (const { file, data } of Object.values(golds)) {
    for (const pr of Object.values(data.prs)) {
        for (const g of pr.groups) {
            g.members.sort();
            g.groupId = `g_${sha(g.members.join('|')).slice(0, 6)}`;
        }
        const gOf = {};
        for (const g of pr.groups) for (const m of g.members) gOf[m] = g;
        for (const s of pr.suggestions) {
            const g = gOf[s.id];
            s.isDuplicate = !!g;
            s.duplicateIds = g ? g.members.filter((m) => m !== s.id) : [];
            s.groupId = g ? g.groupId : null;
            s.needsUnifiedComment = g ? g.needsUnifiedComment : false;
        }
    }
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
console.log(`applied ${applied} decisions, ${stale} stale (target no longer exists)`);
process.exit(0);
