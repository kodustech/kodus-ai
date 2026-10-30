#!/usr/bin/env node
// Attach only previously merged PR evidence. This is a sparse sampled map:
// the corpus is not the repository's full history and coverage says so.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { registerTs } = require('../shared/eval-kit');
registerTs();
const {
    buildCodeAreaRiskMap,
} = require('../../libs/platformData/domain/code-area-risk/build-area-risk-map.ts');

const root = __dirname;
const snapshotsPath = path.join(root, 'snapshots.json.gz');
const snapshots = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapshotsPath)));
const historical = JSON.parse(
    fs.readFileSync(path.join(root, 'history-prs.json'), 'utf8'),
).pullRequests;
const year = 365 * 24 * 60 * 60 * 1000;
let withHistory = 0;

for (const item of snapshots.cases) {
    const end = Date.parse(item.snapshotAt);
    const start = end - year;
    const prior = historical.filter(
        (pr) =>
            pr.repository === item.repository &&
            Date.parse(pr.mergedAt) >= start &&
            Date.parse(pr.mergedAt) < end,
    );
    if (!prior.length) {
        item.areaMap = null;
        continue;
    }
    item.areaMap = buildCodeAreaRiskMap({
        source: 'GITHUB',
        windowStart: new Date(start).toISOString(),
        windowEnd: new Date(end).toISOString(),
        refreshedAt: new Date(end).toISOString(),
        discoveredMergedPrs: prior.length,
        scanComplete: false,
        sampled: true,
        pullRequests: prior,
    });
    withHistory++;
}

fs.writeFileSync(snapshotsPath, zlib.gzipSync(JSON.stringify(snapshots)));
console.log(
    `Area-map context attached to ${withHistory}/${snapshots.cases.length} snapshots`,
);
