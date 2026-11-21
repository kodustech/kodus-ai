const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Validate before importing model routing or reading an operator's credentials. */
function selectRun(args, all) {
    const plannerHost = args['planner-host'] ?? 'worker';
    if (!['worker', 'product'].includes(plannerHost)) throw new Error('unsupported planner host');
    const sides = String(args.sides ?? 'planner,baseline').split(',');
    if (!sides.length || sides.some((side) => !['planner', 'baseline'].includes(side)) || new Set(sides).size !== sides.length) throw new Error('unsupported or repeated side');
    const set = args.set ?? 'full';
    if (!['full', 'grafana', 'synthetic'].includes(set)) throw new Error('unsupported case set');
    const ids = args.cases === undefined ? undefined : String(args.cases).split(',');
    if (ids && (new Set(ids).size !== ids.length || ids.some((id) => !all.some((c) => c.id === id)))) throw new Error('unknown or repeated case');
    const cases = all.filter((c) => (!ids || ids.includes(c.id)) && (set === 'full' || (set === 'grafana' ? !!c.source.github : !!c.source.fixture)));
    if (!cases.length) throw new Error('no case selected');
    return { plannerHost, sides, cases, set };
}

function floorFor(selected, all, target) {
    const calibration = target?.calibration;
    const selectedIds = selected.cases.map((c) => c.id).sort();
    if (!calibration || selected.plannerHost !== calibration.plannerHost || selected.sides[0] !== calibration.side ||
        JSON.stringify(selectedIds) !== JSON.stringify([...calibration.caseIds].sort()) ||
        datasetFor(path.resolve(__dirname, '../..'), all).datasetSha256 !== calibration.datasetSha256) {
        return { floor: null, reason: 'no matching host, side and full-dataset calibration' };
    }
    return { floor: target.floor ?? null, reason: target.floor === undefined ? 'no calibrated floor' : undefined };
}

function datasetFor(root, all) {
    const fixtureFiles = [];
    const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.isFile()) fixtureFiles.push({ path: path.relative(root, file).split(path.sep).join('/'), sha256: digest(fs.readFileSync(file)) });
            else throw new Error('unsupported dataset file');
        }
    };
    for (const fixture of [...new Set(all.flatMap((c) => c.source.fixture ? [c.source.fixture] : []))].sort()) {
        if (typeof fixture !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(fixture)) throw new Error('invalid dataset fixture');
        walk(path.join(root, 'evals/runtime-test-planner/fixtures', fixture));
    }
    const recordedExecSha256 = digest(fs.readFileSync(path.join(root, 'evals/runtime-test-planner/base-machines.js')));
    return { datasetSha256: digest(JSON.stringify({ cases: all, fixtureFiles, recordedExecSha256 })), fixtureFiles, recordedExecSha256 };
}

/** Hash code/data, never serialize paths outside the repository or source contents. */
function versionsFor({ root, selected, all, files }) {
    const sources = [...new Set(files)].map((file) => ({ file, relative: path.relative(root, file) }))
        .filter(({ relative }) => relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.split(path.sep).includes('node_modules'))
        .map(({ file, relative }) => ({ path: relative.split(path.sep).join('/'), sha256: digest(fs.readFileSync(file)) }))
        .sort((a, b) => a.path.localeCompare(b.path));
    return {
        plannerHost: selected.plannerHost,
        evidence: 'plan-contracts-with-recorded-exec',
        ...datasetFor(root, all),
        selectedCaseIds: selected.cases.map((c) => c.id),
        sourceSha256: digest(JSON.stringify(sources)),
        sources,
    };
}

module.exports = { selectRun, floorFor, versionsFor, datasetFor };
