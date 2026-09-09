#!/usr/bin/env node
/**
 * How much of the rule population is currently unscoped, and how much of the
 * scoping the compiler ALREADY infers is actually reaching the review.
 *
 * Context: `compileRuleDetector` already asks the model which file extensions a
 * rule's text scopes it to, and stores the answer in `detector.extensions`. But
 * a detector is only compiled for MECHANICAL rules, and `detectorAppliesToFile`
 * uses those extensions only to route T0 hits — the semantic judge's
 * `rulesForFile` never sees them. So the inference exists, is already paid for,
 * and lands on a small slice of the fleet. This measures that slice.
 *
 * Read-only; credentials come from SSM inside the process and are never printed.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

const run = promisify(execFile);
const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const OUT = args.out || '/tmp/1826-scope-gap.json';

const SSM_PREFIX = '/prod/kodus-orchestrator';
const KEYS = [
    'API_MG_DB_HOST',
    'API_MG_DB_PORT',
    'API_MG_DB_USERNAME',
    'API_MG_DB_PASSWORD',
    'API_MG_DB_DATABASE',
];

async function readSsm() {
    const { stdout } = await run('aws', [
        'ssm', 'get-parameters', '--with-decryption',
        '--names', ...KEYS.map((k) => `${SSM_PREFIX}/${k}`),
        '--query', 'Parameters[].{n:Name,v:Value}', '--output', 'json',
    ]);
    const out = {};
    for (const r of JSON.parse(stdout)) out[r.n.split('/').pop()] = r.v;
    return out;
}

function buildUri(p) {
    const user = encodeURIComponent(p.API_MG_DB_USERNAME);
    const pass = encodeURIComponent(p.API_MG_DB_PASSWORD);
    const host = p.API_MG_DB_HOST;
    if (/^mongodb(\+srv)?:\/\//.test(host)) return host;
    const port = String(p.API_MG_DB_PORT ?? '').trim().replace(/^['"]|['"]$/g, '');
    return /^\d+$/.test(port)
        ? `mongodb://${user}:${pass}@${host}:${port}/?authSource=admin`
        : `mongodb+srv://${user}:${pass}@${host}/?retryWrites=true&w=majority`;
}

const inc = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const obj = (m) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));

async function main() {
    const p = await readSsm();
    const client = new MongoClient(buildUri(p), { serverSelectionTimeoutMS: 20000 });
    await client.connect();
    const db = client.db(p.API_MG_DB_DATABASE);

    const docs = await db.collection('kodyRules').find({}, {
        projection: {
            organizationId: 1,
            'rules.title': 1, 'rules.rule': 1, 'rules.path': 1, 'rules.scope': 1,
            'rules.status': 1, 'rules.origin': 1, 'rules.detector': 1,
        },
    }).toArray();

    let active = 0;
    let withDetector = 0;
    let detectorWithExt = 0;
    let detectorNoExt = 0;
    const scopePath = new Map();      // scope × has-path
    const originNoPath = new Map();   // which origins ship rules without a path
    const unscopedByOrg = new Map();
    const prShapedButFileScoped = [];

    // A rule whose TEXT is about the pull request as a whole, judged per file.
    const PR_SHAPED =
        /\b(pull request|\bPR\b|commit message|branch name|PR title|PR description|changelog entry|one logical change|mixed concerns)\b/i;

    for (const doc of docs) {
        for (const r of doc.rules ?? []) {
            if (r.status !== 'active') continue;
            active++;
            const hasPath = !!(r.path && String(r.path).trim());
            const scope = r.scope || '(none)';
            inc(scopePath, `${scope} · ${hasPath ? 'com path' : 'SEM path'}`);
            if (!hasPath) {
                inc(originNoPath, r.origin || '(none)');
                inc(unscopedByOrg, String(doc.organizationId));
            }
            if (r.detector) {
                withDetector++;
                if (r.detector.extensions?.length) detectorWithExt++;
                else detectorNoExt++;
            }
            const text = `${r.title ?? ''} ${r.rule ?? ''}`;
            if (scope !== 'pull-request' && PR_SHAPED.test(text)) {
                prShapedButFileScoped.push({
                    title: r.title,
                    scope,
                    origin: r.origin,
                    path: r.path || '',
                });
            }
        }
    }

    // Distinct PR-shaped rules, by how many installs each has.
    const prShapedDistinct = new Map();
    for (const r of prShapedButFileScoped) {
        const cur = prShapedDistinct.get(r.title) ?? { ...r, installs: 0 };
        cur.installs++;
        prShapedDistinct.set(r.title, cur);
    }

    const report = {
        generatedAt: new Date().toISOString(),
        active,
        scopeByPath: obj(scopePath),
        detector: {
            total: withDetector,
            withExtensions: detectorWithExt,
            withoutExtensions: detectorNoExt,
            pctOfActiveFleetCoveredByInferredScope: +(
                (100 * detectorWithExt) / active
            ).toFixed(1),
        },
        unscopedByOrigin: obj(originNoPath),
        orgsWithUnscopedRules: unscopedByOrg.size,
        top10OrgsByUnscopedRules: Object.fromEntries(
            [...unscopedByOrg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
                .map(([, n], i) => [`org#${i + 1}`, n]),
        ),
        prShapedButFileScoped: {
            installs: prShapedButFileScoped.length,
            distinct: prShapedDistinct.size,
            top: [...prShapedDistinct.values()]
                .sort((a, b) => b.installs - a.installs)
                .slice(0, 15),
        },
    };

    await client.close();
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
