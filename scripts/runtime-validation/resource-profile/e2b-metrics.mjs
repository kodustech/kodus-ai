import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fields = ['cpuUsedPct', 'cpuCount', 'memUsed', 'memTotal', 'memCache', 'diskUsed', 'diskTotal'];
const target = /^[A-Za-z0-9_-]{1,128}$/;

function validate({ ids, start, end }) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length ||
        ids.some((id) => typeof id !== 'string' || !target.test(id)) ||
        !(start instanceof Date) || !(end instanceof Date) ||
        !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) ||
        end <= start || end - start > 7_200_000) throw new Error('invalid_arguments');
}

export async function collectMetrics(getMetrics, options) {
    validate(options);
    const { ids, start, end, apiKey } = options;
    return Promise.all(ids.map(async (sandboxId) => {
        try {
            const values = await getMetrics(sandboxId, { start, end, apiKey, requestTimeoutMs: 5_000 });
            if (!Array.isArray(values)) throw new Error('invalid_metrics');
            const metrics = values.flatMap((value) => {
                const at = new Date(value?.timestamp);
                if (!Number.isFinite(at.getTime()) || at < start || at > end) return [];
                const row = { timestamp: at.toISOString() };
                for (const field of fields) {
                    const number = value[field];
                    if (typeof number === 'number' && Number.isFinite(number) && number >= 0) row[field] = number;
                }
                return Object.keys(row).length > 1 ? [row] : [];
            });
            return { sandboxId, metrics };
        } catch {
            return { sandboxId, error: { code: 'metrics_unavailable' } };
        }
    }));
}

export function parseOptions(args) {
    const options = { ids: [] };
    for (let i = 0; i < args.length; i += 2) {
        const [key, value] = args.slice(i, i + 2);
        if (!value) throw new Error('invalid_arguments');
        if (key === '--sandbox') options.ids.push(value);
        else if (['--start', '--end', '--output'].includes(key) && options[key.slice(2)] === undefined) options[key.slice(2)] = value;
        else throw new Error('invalid_arguments');
    }
    options.start = new Date(options.start);
    options.end = new Date(options.end);
    validate(options);
    return options;
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
    const { env = process.env, stdout = process.stdout, stderr = process.stderr } = dependencies;
    let output;
    try {
        const options = parseOptions(args);
        options.apiKey = env.E2B_API_KEY || env.API_E2B_KEY;
        if (!options.apiKey) {
            stderr.write('{"error":{"code":"missing_api_key"}}\n');
            return 1;
        }
        if (options.output) output = await open(options.output, 'wx', 0o600);
        let getMetrics = dependencies.getMetrics;
        if (!getMetrics) {
            const { Sandbox } = await import('e2b');
            getMetrics = (id, opts) => Sandbox.getMetrics(id, opts);
        }
        const rows = await collectMetrics(getMetrics, options);
        const text = `${JSON.stringify({ samples: rows })}\n`;
        if (output) await output.writeFile(text);
        else stdout.write(text);
        return rows.some((row) => row.metrics?.length > 0) ? 0 : 1;
    } catch {
        stderr.write('{"error":{"code":"collection_failed"}}\n');
        return 1;
    } finally {
        try {
            await output?.close();
        } catch {
            stderr.write('{"error":{"code":"output_unavailable"}}\n');
            return 1;
        }
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    process.exitCode = await main();
}
