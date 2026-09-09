#!/usr/bin/env node
/**
 * Why do 0 of the 816 compiled detectors in production carry `extensions`?
 *
 * Three hypotheses, and they lead to different fixes:
 *   (a) the model is not answering the field
 *   (b) it answers and `normalizeDetectorExtensions` rejects the shape
 *   (c) it answers and persists, but every detector in the fleet predates the
 *       field and nothing ever recompiled them
 *
 * (c) is testable for free: `compiledBy` records the model, and the rule's
 * `updatedAt` records when the document last changed. If every detector was
 * compiled before the field shipped, (c) is the answer and the fix is a
 * backfill, not a prompt change. This also reports whether ANY rule anywhere
 * carries the field, which would prove the write path works.
 *
 * Read-only; credentials read from SSM inside the process, never printed.
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
const OUT = args.out || '/tmp/1826-detector-forensics.json';

const SSM_PREFIX = '/prod/kodus-orchestrator';
const KEYS = ['API_MG_DB_HOST','API_MG_DB_PORT','API_MG_DB_USERNAME','API_MG_DB_PASSWORD','API_MG_DB_DATABASE'];

async function readSsm() {
    const { stdout } = await run('aws', [
        'ssm','get-parameters','--with-decryption',
        '--names', ...KEYS.map((k) => `${SSM_PREFIX}/${k}`),
        '--query','Parameters[].{n:Name,v:Value}','--output','json',
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
            'rules.title': 1, 'rules.status': 1, 'rules.origin': 1,
            'rules.detector': 1, 'rules.updatedAt': 1, 'rules.createdAt': 1,
            'rules.summary': 1, 'rules.atoms': 1, 'rules.contextNeed': 1,
        },
    }).toArray();

    const byModel = new Map();
    const byMonth = new Map();
    const detectorKeys = new Map();
    let activeWithDetector = 0;
    let anyStatusWithDetector = 0;
    let withExt = 0;
    let withEmptyExtArray = 0;
    let withSummary = 0;
    let withAtoms = 0;
    let withContextNeed = 0;
    const samples = [];

    for (const doc of docs) {
        for (const r of doc.rules ?? []) {
            if (r.summary) withSummary++;
            if (r.atoms) withAtoms++;
            if (r.contextNeed) withContextNeed++;
            if (!r.detector) continue;
            anyStatusWithDetector++;
            if (r.status === 'active') activeWithDetector++;

            for (const k of Object.keys(r.detector)) inc(detectorKeys, k);
            inc(byModel, r.detector.compiledBy || '(sem compiledBy)');

            const when = r.updatedAt || r.createdAt;
            if (when) {
                const d = new Date(when);
                if (!Number.isNaN(+d)) {
                    inc(byMonth, `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
                }
            }
            if (Array.isArray(r.detector.extensions)) {
                if (r.detector.extensions.length) withExt++;
                else withEmptyExtArray++;
            }
            if (samples.length < 8) {
                samples.push({
                    title: r.title,
                    origin: r.origin,
                    status: r.status,
                    detectorKeys: Object.keys(r.detector),
                    compiledBy: r.detector.compiledBy ?? null,
                    pattern: String(r.detector.pattern ?? '').slice(0, 60),
                    updatedAt: when ?? null,
                });
            }
        }
    }

    const report = {
        generatedAt: new Date().toISOString(),
        detectors: {
            anyStatus: anyStatusWithDetector,
            active: activeWithDetector,
            withNonEmptyExtensions: withExt,
            withEmptyExtensionsArray: withEmptyExtArray,
            withNoExtensionsKeyAtAll:
                anyStatusWithDetector - withExt - withEmptyExtArray,
        },
        // Which keys the persisted detector documents actually have. If
        // `extensions` never appears, the write path never wrote it.
        detectorKeysSeen: obj(detectorKeys),
        compiledByModel: obj(byModel),
        detectorRulesLastTouchedByMonth: obj(byMonth),
        // Sibling fields added by later issues: if these ARE populated and
        // `extensions` is not, the persistence layer is fine and the gap is in
        // the compiler's own output.
        siblingFieldsPopulated: {
            summary: withSummary,
            atoms: withAtoms,
            contextNeed: withContextNeed,
        },
        samples,
    };

    await client.close();
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
