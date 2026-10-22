#!/usr/bin/env node
// Merge independently run subsets of the frozen full approval-risk corpus.
const fs = require('node:fs');
const path = require('node:path');

function merge(files) {
    if (!files.length) throw new Error('Provide one or more result JSON files');
    const labels = new Map(
        require('./adjudications.json').cases
            .filter((row) => ['hold', 'eligible'].includes(row.decision))
            .map((row) => [row.id, row.decision === 'hold' ? 'hold' : 'approve']),
    );
    const seen = new Set();
    const rows = [];
    const results = files.map((file) => {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            throw new Error(`Reading/parsing ${file}: ${error.message}`);
        }
    });
    const model = results[0].model;
    for (const [index, result] of results.entries()) {
        if (result.eval !== 'approval-risk' || result.model !== model || !result.comparisons)
            throw new Error(`Incompatible result: ${files[index]}`);
        for (const row of result.cases) {
            if (!labels.has(row.id)) throw new Error(`Unexpected case: ${row.id}`);
            if (seen.has(row.id)) throw new Error(`Duplicate case: ${row.id}`);
            if (row.total !== 1 || row.unmeasured || !row.metadata?.arms)
                throw new Error(`Unmeasured case: ${row.id}`);
            if (row.metadata.expect !== labels.get(row.id))
                throw new Error(`Wrong expected decision: ${row.id}`);
            if (['baseline', 'modelOnly', 'modelAndMap'].some(
                (arm) => !['approve', 'hold'].includes(row.metadata.arms[arm]),
            )) throw new Error(`Invalid arm decision: ${row.id}`);
            if (row.hits !== Number(row.metadata.arms.modelAndMap === row.metadata.expect))
                throw new Error(`Inconsistent score: ${row.id}`);
            seen.add(row.id);
            rows.push(row);
        }
    }
    const missing = [...labels.keys()].filter((id) => !seen.has(id));
    if (missing.length)
        throw new Error(`Missing ${missing.length} cases: ${missing.slice(0, 5).join(', ')}`);
    const groups = {
        hold: rows.filter((row) => row.metadata.expect === 'hold'),
        eligible: rows.filter((row) => row.metadata.expect === 'approve'),
    };
    if (groups.hold.length + groups.eligible.length !== rows.length)
        throw new Error('Invalid expected decision in result');
    const slices = {
        sparse: (row) => row.metadata.sparseHistory,
        linkedBug: (row) => row.metadata.linkedBugHistory,
    };
    const countApprovals = (group, arm) =>
        group.filter((row) => row.metadata.arms[arm] === 'approve').length;
    const measure = (group, arm) => ({
        count: countApprovals(group, arm),
        of: group.length,
    });
    const comparisons = Object.fromEntries(
        ['baseline', 'modelOnly', 'modelAndMap'].map((arm) => [
            arm,
            {
                wrongApprovals: measure(groups.hold, arm),
                eligibleCoverage: measure(groups.eligible, arm),
                ...Object.fromEntries(
                    Object.entries(slices).flatMap(([name, predicate]) => [
                        [`${name}WrongApprovals`, measure(groups.hold.filter(predicate), arm)],
                        [`${name}EligibleCoverage`, measure(groups.eligible.filter(predicate), arm)],
                    ]),
                ),
            },
        ]),
    );
    const hits = rows.reduce((sum, row) => sum + row.hits, 0);
    return {
        eval: 'approval-risk',
        model,
        sources: files.map((file) => path.basename(file)),
        metric: {
            ...results[0].metric,
            value: hits / rows.length,
        },
        comparisons,
        infra: { errored: 0, total: rows.length },
        cases: rows,
    };
}

if (require.main === module) {
    let operation = 'merging input results';
    try {
        const args = process.argv.slice(2);
        const output = args.find((arg) => arg.startsWith('--output='))?.slice(9);
        const files = args.filter((arg) => !arg.startsWith('--'));
        const result = merge(files);
        if (output) {
            operation = `writing result ${output}`;
            fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
            fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
        }
        console.log(JSON.stringify({
            metric: result.metric,
            comparisons: result.comparisons,
            infra: result.infra,
        }, null, 2));
    } catch (error) {
        console.error(`not measured while ${operation}: ${error.message}`);
        process.exitCode = 2;
    }
}

module.exports = { merge };
