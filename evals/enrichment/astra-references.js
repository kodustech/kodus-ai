#!/usr/bin/env node
/**
 * References for the enrichment eval (#1821), written by Astra (gpt-6-astra
 * on the Codex subscription) with read-only access to the repository at the
 * PR head. One call per PR, covering that PR's items.
 *
 *   node evals/enrichment/astra-references.js [--par=4] [--cases=a,b]
 *     -> evals/enrichment/dataset/references/<caseId>.json
 *
 * Only items a PR's reference file lacks are written; items no longer in the
 * dataset are dropped from it on that write.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const DIR = path.join(__dirname, 'dataset');
const OUT = path.join(DIR, 'references');
const REPOS = JSON.parse(fs.readFileSync(path.join(__dirname, '../dedup/gold-v3/trabalho/repos.json'), 'utf8'));
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const PAR = Number(arg('par', 4));
const ONLY = arg('cases', '') ? new Set(arg('cases', '').split(',')) : null;

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['issueId', 'defectStatement', 'anchorCoversDefect', 'fixability', 'contextSufficient', 'obligations', 'exampleFix', 'notes'],
                properties: {
                    issueId: { type: 'string' },
                    defectStatement: { type: 'string' },
                    anchorCoversDefect: { type: 'boolean' },
                    fixability: { type: 'string', enum: ['local', 'needs-wider-change', 'no-code-fix'] },
                    contextSufficient: { type: 'boolean' },
                    obligations: { type: 'array', items: { type: 'string' } },
                    exampleFix: { type: ['string', 'null'] },
                    notes: { type: 'string' },
                },
            },
        },
    },
};

const INSTRUCTIONS = `You are writing the reference answers of an evaluation dataset. You have read-only access to the repository at the pull request head (the current directory). Read whatever you need.

Each item below is a code-review finding that is a confirmed true positive. A later step ("enrichment") will receive ONLY the frozen input shown for the item (the finding, the cited code, a numbered window of the file around it, and the file's diff) and must produce a fix: replacement code for EXACTLY the cited lines relevantLinesStart..relevantLinesEnd, or abstain.

For each item return:
- defectStatement: one or two sentences, the defect in concrete terms (what is wrong, where, what breaks). Use the gold description and the finding; correct them if the code says otherwise.
- anchorCoversDefect: true if the cited lines contain the defective code (or the line where the fix belongs).
- fixability: "local" if a correct fix can be written as a replacement of exactly the cited lines (deleting them counts); "needs-wider-change" if a correct fix must also change code outside the cited lines; "no-code-fix" if the problem is not fixed by changing code (process, missing tests elsewhere, design decision).
- contextSufficient: true if someone who sees ONLY the frozen input (not the repository) can write a correct fix without guessing names, signatures or behavior that are not shown there.
- obligations: 1-4 short, checkable behavioral requirements a correct fix must meet (what must change and what must be preserved). Do not prescribe one implementation when several are valid.
- exampleFix: when fixability is "local", the full replacement text for exactly the cited lines, keeping the file's indentation, as it would replace them in the file; an empty string means "delete these lines". null otherwise.
- notes: anything a grader must know (alternative valid fixes, traps). Short.

Items with anchorStatus other than "ok" have no usable cited code: set anchorCoversDefect false, fixability by the defect itself, contextSufficient false, exampleFix null.`;

const items = JSON.parse(fs.readFileSync(path.join(DIR, 'items.json'), 'utf8')).items;
const byCase = new Map();
for (const it of items) (byCase.get(it.caseId) || byCase.set(it.caseId, []).get(it.caseId)).push(it);
fs.mkdirSync(OUT, { recursive: true });

function prompt(caseId, list) {
    const body = list.map((it) => [
        `### ${it.issueId}`,
        `Gold description: ${it.gold.comment}`,
        `Finding: ${JSON.stringify(it.finding)}`,
        `anchorStatus: ${it.deterministic.anchorStatus}`,
        `Cited code (existingCode):\n${it.deterministic.existingCode || '(none)'}`,
        `File window (lines ${it.context.windowLines.join('-')}):\n${it.context.window || '(none)'}`,
        `File diff:\n${it.context.filePatch || '(none)'}`,
    ].join('\n\n')).join('\n\n');
    return `${INSTRUCTIONS}\n\nPull request: ${caseId}\n\n${body}\n`;
}

function run(caseId, list) {
    const { repo, head } = REPOS[caseId];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-ref-'));
    const wt = path.join(tmp, 'wt');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', wt, head], { stdio: 'ignore' });
    fs.writeFileSync(path.join(tmp, 'schema.json'), JSON.stringify(SCHEMA));
    fs.writeFileSync(path.join(tmp, 'prompt.txt'), prompt(caseId, list));
    return new Promise((resolve) => {
        const p = spawn('bash', ['-c', `codex exec --skip-git-repo-check --sandbox read-only -m gpt-6-astra -c model_reasoning_effort=high -C "${wt}" --output-schema "${tmp}/schema.json" -o "${tmp}/out.json" - < "${tmp}/prompt.txt" > "${tmp}/log.txt" 2>&1`]);
        p.on('close', (code) => {
            let ok = false;
            try {
                const out = JSON.parse(fs.readFileSync(path.join(tmp, 'out.json'), 'utf8'));
                const want = new Set(list.map((x) => x.issueId));
                const got = new Set(out.items.map((x) => x.issueId));
                ok = [...want].every((x) => got.has(x));
                if (ok) {
                    const f = path.join(OUT, `${caseId}.json`);
                    const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).items : [];
                    const keep = new Set(items.filter((x) => x.caseId === caseId).map((x) => x.issueId));
                    const merged = [...prev.filter((x) => keep.has(x.issueId) && !want.has(x.issueId)), ...out.items.filter((x) => want.has(x.issueId))];
                    fs.writeFileSync(f, JSON.stringify({ caseId, items: merged }, null, 1));
                }
            } catch {}
            try { execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' }); } catch {}
            if (!ok) fs.copyFileSync(path.join(tmp, 'log.txt'), path.join(OUT, `${caseId}.failed.log`));
            fs.rmSync(tmp, { recursive: true, force: true });
            console.log(`${ok ? 'ok  ' : 'FAIL'} ${caseId} (${list.length}) exit=${code}`);
            resolve(ok);
        });
    });
}

(async () => {
    // Per PR, only the items its reference file does not cover yet.
    const have = (c) => {
        const f = path.join(OUT, `${c}.json`);
        return new Set(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).items.map((x) => x.issueId) : []);
    };
    const todo = [...byCase.entries()]
        .filter(([c]) => !ONLY || ONLY.has(c))
        .map(([c, list]) => [c, list.filter((x) => !have(c).has(x.issueId))])
        .filter(([, list]) => list.length);
    console.log(`PRs to write: ${todo.length}`);
    let i = 0, fail = 0;
    await Promise.all(Array.from({ length: PAR }, async () => {
        while (i < todo.length) {
            const [c, list] = todo[i++];
            if (!(await run(c, list))) fail++;
        }
    }));
    console.log(`done, failed: ${fail}`);
    process.exit(fail ? 1 : 0);
})();
