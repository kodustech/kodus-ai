// Run the dedup eval across secondary-model candidates (BYOK readiness matrix).
//
//   node evals/dedup/run-matrix.js
//   node evals/dedup/run-matrix.js --models=gpt-5.4-mini,kimi-k2.7-code --limit=5
//
// Requires live keys. For CI without keys use run.js --mock=identity --gate.
const { spawnSync } = require('child_process');
const path = require('path');
const {
    SECONDARY_MATRIX,
    SECONDARY_BASELINE,
} = require('../shared/secondary-models');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);

const models = args.models
    ? String(args.models).split(',').map((s) => s.trim()).filter(Boolean)
    : SECONDARY_MATRIX;

const extra = [];
if (args.limit) extra.push(`--limit=${args.limit}`);
if (args.pr) extra.push(`--pr=${args.pr}`);
// Production shipped config
extra.push('--guard=content', '--contentthresh=0.3');
if (args.gate) extra.push('--gate');

const ROOT = path.join(__dirname, '../..');
const results = [];

for (const model of models) {
    console.log(`\n════ dedup matrix · model=${model} ════`);
    const cmd = [
        'node',
        'evals/dedup/run.js',
        `--model=${model}`,
        ...extra,
    ];
    // Point dataset at shared secondary smoke if dedup/datasets empty
    const env = { ...process.env };
    const r = spawnSync(cmd[0], cmd.slice(1), {
        cwd: ROOT,
        stdio: 'inherit',
        env,
    });
    results.push({
        model,
        status: r.status === 0 ? 'pass' : r.status === 1 ? 'gate' : 'infra',
        code: r.status,
    });
}

console.log('\n════ DEDUP MATRIX SUMMARY ════');
for (const r of results) {
    const icon =
        r.status === 'pass' ? '✅' : r.status === 'gate' ? '⚠️' : '❌';
    console.log(`  ${icon} ${r.model} (${r.status}, exit ${r.code})`);
}

const infra = results.filter((r) => r.status === 'infra');
const gate = results.filter((r) => r.status === 'gate');
if (infra.length) process.exit(2);
if (gate.length && args.gate) process.exit(1);
console.log(
    `\nBaseline prod secondary: ${SECONDARY_BASELINE}. Compare each BYOK candidate against it.`,
);
