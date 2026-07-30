#!/usr/bin/env node
// Compare two finder-recall artifacts and fail when the candidate regresses
// beyond an explicit tolerance. This is the PR signal: base branch vs head branch
// on the same model/cases, with a small margin for LLM/judge noise.
const fs = require('fs');

function parseArgs(argv) {
    const out = {
        base: '',
        head: '',
        recallDropMax: Number(process.env.FINDER_RECALL_DROP_MAX || 0.05),
        precisionDropMax: Number(process.env.FINDER_PRECISION_DROP_MAX || 0.15),
        fidelityDropMax: Number(process.env.FINDER_FIDELITY_DROP_MAX || 0.10),
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
        if (!m) continue;

        const key = m[1];
        const inlineValue = m[2];
        const value = inlineValue ?? argv[i + 1];
        const consumesNext = inlineValue === undefined && value && !String(value).startsWith('--');

        if (key === 'base') {
            out.base = value || '';
            if (consumesNext) i += 1;
        } else if (key === 'head') {
            out.head = value || '';
            if (consumesNext) i += 1;
        } else if (key === 'recall-drop-max') {
            out.recallDropMax = Number(value);
            if (consumesNext) i += 1;
        } else if (key === 'precision-drop-max') {
            out.precisionDropMax = Number(value);
            if (consumesNext) i += 1;
        } else if (key === 'fidelity-drop-max') {
            out.fidelityDropMax = Number(value);
            if (consumesNext) i += 1;
        }
    }

    return out;
}

function readArtifact(file) {
    if (!file) throw new Error('missing artifact path');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function metric(artifact, key) {
    const value = artifact?.metrics?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pct(value) {
    return value == null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function checkDrop({ label, base, head, maxDrop }) {
    if (base == null || head == null) return null;
    const drop = base - head;
    if (drop > maxDrop) {
        return `${label} dropped ${pct(drop)} (${pct(base)} → ${pct(head)}), max ${pct(maxDrop)}`;
    }
    return null;
}

function main() {
    const args = parseArgs(process.argv);
    const base = readArtifact(args.base);
    const head = readArtifact(args.head);

    if (base.model !== head.model) {
        throw new Error(`model mismatch: base=${base.model} head=${head.model}`);
    }

    const failures = [
        checkDrop({
            label: 'recall_mean',
            base: metric(base, 'recall_mean'),
            head: metric(head, 'recall_mean'),
            maxDrop: args.recallDropMax,
        }),
        checkDrop({
            label: 'precision_mean',
            base: metric(base, 'precision_mean'),
            head: metric(head, 'precision_mean'),
            maxDrop: args.precisionDropMax,
        }),
        checkDrop({
            label: 'fidelity_mean',
            base: metric(base, 'fidelity_mean'),
            head: metric(head, 'fidelity_mean'),
            maxDrop: args.fidelityDropMax,
        }),
    ].filter(Boolean);

    console.log(`════ finder-recall regression check · model=${head.model} ════`);
    console.log(`base recall=${pct(metric(base, 'recall_mean'))} precision=${pct(metric(base, 'precision_mean'))} fidelity=${pct(metric(base, 'fidelity_mean'))}`);
    console.log(`head recall=${pct(metric(head, 'recall_mean'))} precision=${pct(metric(head, 'precision_mean'))} fidelity=${pct(metric(head, 'fidelity_mean'))}`);

    if (failures.length) {
        console.error(`\n❌ REGRESSION: ${failures.join('; ')}`);
        process.exit(1);
    }

    console.log(
        `\n✅ no finder regression beyond tolerances ` +
            `(recall ${pct(args.recallDropMax)}, precision ${pct(args.precisionDropMax)}, fidelity ${pct(args.fidelityDropMax)})`,
    );
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exit(2);
}
