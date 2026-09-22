#!/usr/bin/env node
/**
 * Self-hosted doctor client (#1987). Runs INSIDE the api container:
 *
 *   docker compose exec -T api node scripts/doctor/doctor-client.mjs
 *   kubectl exec deploy/<release>-api -- node scripts/doctor/doctor-client.mjs
 *
 * It asks the API's loopback-only doctor listener for a report
 * (apps/api/src/doctor/doctor-listener.ts) and prints it. No dependencies:
 * the prod image strips dev tooling.
 *
 *   --format text   (default) human report: verdict, problems worst first,
 *                   one-line summary of what passed
 *   --format tsv    one result per line, for doctor.sh / doctor-k8s.sh
 *   --format json   the raw report
 *   --verbose       text format: list every passing check too
 *
 * Exit codes: 0 report printed, 3 the API did not answer.
 */
import { createHmac } from 'node:crypto';

const TOKEN_CONTEXT = 'kodus-selfhosted-doctor-v1';
const DEFAULT_PORT = 3335;

const ORDER = ['fail', 'warn', 'unknown', 'info', 'skip', 'ok'];
const MARK = { fail: '✘', warn: '!', unknown: '?', info: 'i', skip: '-', ok: '✔' };
const VERDICT = {
    NOT_RUNNING: 'Reviews: NOT RUNNING',
    DEGRADED: 'Reviews: RUNNING, DEGRADED',
    OK: 'Reviews: OK',
};

function parseArgs(argv) {
    const out = { format: 'text', verbose: false };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--format') {
            out.format = argv[++i];
        } else if (argv[i] === '--verbose') {
            out.verbose = true;
        } else if (argv[i] === '-h' || argv[i] === '--help') {
            out.help = true;
        }
    }
    return out;
}

const oneLine = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

export function toTsv(report) {
    const lines = [`#verdict\t${report.verdict}`, `#version\t${oneLine(report.version)}`];
    for (const r of report.results) {
        lines.push(
            [r.status, r.check, r.scope, r.title, r.impact, r.fix]
                .map(oneLine)
                .join('\t'),
        );
    }
    return lines.join('\n');
}

export function toText(report, { verbose = false, color = false } = {}) {
    const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
    const tint = { fail: '31', warn: '33', unknown: '35', info: '36', skip: '90', ok: '32' };
    const out = [];
    const verdictColor = { NOT_RUNNING: '31', DEGRADED: '33', OK: '32' }[report.verdict];
    out.push(paint(`1;${verdictColor}`, VERDICT[report.verdict] ?? report.verdict));

    const byStatus = (s) => report.results.filter((r) => r.status === s);
    const counts = ORDER.map((s) => [s, byStatus(s).length]).filter(([, n]) => n);
    out.push(
        counts.map(([s, n]) => `${MARK[s]} ${n}`).join('   ') +
            `   (Kodus ${report.version})`,
    );
    out.push('');

    for (const status of ORDER) {
        if (status === 'ok' && !verbose) {
            continue;
        }
        for (const r of byStatus(status)) {
            const scope = r.scope ? ` [${r.scope}]` : '';
            out.push(`${paint(tint[status], MARK[status])} ${r.title}${paint('90', scope)}`);
            if (r.impact) {
                out.push(`    Impact: ${r.impact}`);
            }
            if (r.fix) {
                out.push(`    Fix: ${r.fix}`);
            }
        }
    }
    const ok = byStatus('ok').length;
    if (!verbose && ok) {
        out.push(`${paint('32', MARK.ok)} ${ok} check(s) passed (--verbose to list them).`);
    }
    out.push('');
    out.push('✘ reviews do not run   ! reviews run degraded   ? could not verify   i optional feature off   - skipped by your settings');
    return out.join('\n');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('Usage: node scripts/doctor/doctor-client.mjs [--format text|tsv|json] [--verbose]');
        return 0;
    }
    const key = process.env.API_CRYPTO_KEY;
    if (!key) {
        console.error('API_CRYPTO_KEY is not set in this container; run this inside the api container.');
        return 3;
    }
    const port = Number(process.env.API_DOCTOR_PORT) || DEFAULT_PORT;
    const token = createHmac('sha256', key).update(TOKEN_CONTEXT).digest('hex');

    let report;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/doctor`, {
            headers: { 'x-kodus-doctor-token': token },
            signal: AbortSignal.timeout(15 * 60_000),
        });
        if (!res.ok) {
            console.error(`The API doctor answered HTTP ${res.status}: ${oneLine(await res.text()).slice(0, 200)}`);
            return 3;
        }
        report = await res.json();
    } catch (error) {
        console.error(
            `The API doctor did not answer on 127.0.0.1:${port} (${oneLine(error?.cause?.code ?? error?.message)}). ` +
                'Is the api running a version with the doctor, and is API_DOCTOR_ENABLED not false?',
        );
        return 3;
    }

    if (args.format === 'json') {
        console.log(JSON.stringify(report, null, 2));
    } else if (args.format === 'tsv') {
        console.log(toTsv(report));
    } else {
        console.log(toText(report, { verbose: args.verbose, color: process.stdout.isTTY }));
    }
    return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().then((code) => process.exit(code));
}
