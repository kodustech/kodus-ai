#!/usr/bin/env node
/**
 * Re-checks every duplicate group of the gold (2+ members) under the
 * main-defect rule: Opus 5.5 and GPT-6 Astra, blind to each other, say
 * whether the group stays or should be split, and which members bundle
 * more than one defect. Only proposals are written (runs/recheck/);
 * the gold is not changed. A review page shows the groups where any
 * judge proposes a split.
 *
 *   node evals/dedup/gold/recheck-groups.js [--models=a,b] [--prs=a,b] [--par=6]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { diffFor } = require('./judge-context');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const flag = (n) => process.argv.includes(`--${n}`);
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const PAR = Number(arg('par', '6'));
const RUNS = path.join(__dirname, 'runs', 'recheck');

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'groups', 'unique', 'bundles', 'reasoningPt'],
    properties: {
        verdict: { type: 'string', enum: ['keep', 'split'] },
        groups: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['members', 'defect'], properties: { members: { type: 'array', items: { type: 'string' } }, defect: { type: 'string' } } } },
        unique: { type: 'array', items: { type: 'string' } },
        bundles: { type: 'array', items: { type: 'string' } },
        reasoningPt: { type: 'string' },
    },
};

const RULES = `# Task

The code review suggestions below were labeled as one duplicate group: one PR, one reviewer model. Re-check that decision with the rules below and say whether the group stays as it is or must be split.

# Rules

A group holds suggestions about the SAME defect, so that posting all of them would be redundant. Wording, emphasis, proposed fix and line range may differ.

Still the same defect (keep together):
- The same defect reported at the same place with different line ranges.
- One defect seen from two places: where it is introduced (a broken helper) and where it shows up (a caller that breaks because of it), when one fix resolves both.
- The same mistake repeated at several places (e.g. the same wrong helper in Create and Update), fixed by one change or one find-and-replace. A member that reports more of those places than another is still the same defect.

The main-defect rule (decided by the human reviewer):
- When one suggestion talks about two or more different defects, the FIRST defect it reports is its main defect. The suggestion belongs to the group of its main defect.
- A second defect added at the end ("Also...", "Separately...", "In addition...", a remark in the WHY, or something touched only inside the proposed fix) does NOT link the suggestion to the suggestions about that second defect.
- Such a suggestion is listed in "bundles" (it bundles more than one defect), whatever group it ends up in.
- Different defects with different fixes are different groups even when they sit in the same file, function or lines.

# Output

- verdict: "keep" when every member belongs together under these rules, "split" otherwise.
- groups: the groups you would form from these members (each with 2+ members and a one-sentence defect). With verdict "keep", one group with every member.
- unique: members that end up alone.
- bundles: members that report more than one defect (may be empty).
- reasoningPt: two or three short sentences in Brazilian Portuguese explaining the verdict; refer to suggestions by their labels (S1, S2, ...).
Every member id must appear exactly once, in one of your groups or in unique.`;

function call(judge, prompt) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recheck-'));
    const env = { ...process.env };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) delete env[k];
    const outFile = path.join(tmp, 'out.json');
    let cmd;
    let args;
    if (judge === 'astra') {
        fs.writeFileSync(path.join(tmp, 'schema.json'), JSON.stringify(SCHEMA));
        cmd = 'codex';
        args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high', '--output-schema', path.join(tmp, 'schema.json'), '-o', outFile, '-'];
    } else {
        cmd = 'claude';
        args = ['-p', '--model', 'claude-opus-5-5', '--effort', 'high', '--tools', '', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA), '--no-session-persistence', '--setting-sources', '', '--system-prompt', 'You review duplicate labels of code review suggestions. Answer only with the requested JSON.'];
    }
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { env, cwd: tmp });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => {
            try {
                if (code !== 0) throw new Error(`${cmd} exit ${code}: ${(err || out).slice(-400)}`);
                if (judge === 'astra') resolve(JSON.parse(fs.readFileSync(outFile, 'utf8')));
                else {
                    const r = JSON.parse(out);
                    if (r.is_error) throw new Error(String(r.result).slice(0, 400));
                    resolve(r.structured_output ?? JSON.parse(r.result));
                }
            } catch (e) {
                reject(e);
            } finally {
                fs.rmSync(tmp, { recursive: true, force: true });
            }
        });
        p.stdin.end(prompt);
    });
}

function valid(ans, members) {
    const seen = [...ans.groups.flatMap((g) => g.members), ...ans.unique];
    return members.every((m) => seen.filter((x) => x === m).length === 1) && seen.every((m) => members.includes(m)) && ans.groups.every((g) => g.members.length >= 2) && ans.bundles.every((b) => members.includes(b));
}

async function ask(judge, prompt, members, file) {
    if (!flag('force') && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).answer;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const ans = await call(judge, prompt);
        if (valid(ans, members)) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ judge, answer: ans }, null, 1));
            return ans;
        }
    }
    throw new Error(`${judge}: invalid answer after 3 attempts`);
}

(async () => {
    const models = (arg('models') || '').split(',').filter(Boolean);
    const prs = (arg('prs') || '').split(',').filter(Boolean);
    const tasks = [];
    for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.json') && x !== 'human-overrides.json')) {
        const gold = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
        if (!gold.prs || (models.length && !models.includes(gold.model))) continue;
        for (const [caseId, pr] of Object.entries(gold.prs)) {
            if (prs.length && !prs.includes(caseId)) continue;
            for (const g of pr.groups) if (g.members.length >= 2) tasks.push({ model: gold.model, caseId, pr, g });
        }
    }
    console.log(`recheck: ${tasks.length} groups, par ${PAR}`);
    let i = 0;
    let failed = 0;
    const stats = { keepBoth: 0, splitBoth: 0, splitOne: 0 };
    await Promise.all(Array.from({ length: PAR }, async () => {
        while (i < tasks.length) {
            const t = tasks[i++];
            try {
                const label = Object.fromEntries(t.pr.suggestions.map((s, n) => [s.id, `S${n + 1}`]));
                const byId = Object.fromEntries(t.pr.suggestions.map((s) => [s.id, s]));
                const order = [...t.g.members].sort((a, b) => Number(label[a].slice(1)) - Number(label[b].slice(1)));
                const { title, diff } = diffFor(t.caseId, order.map((m) => byId[m]));
                const list = order.map((m) => {
                    const s = byId[m];
                    return `### ${label[m]} (id ${m})\nFile: ${s.relevantFile} (lines ${s.relevantLinesStart}-${s.relevantLinesEnd})\n${s.oneSentenceSummary ? `Summary: ${s.oneSentenceSummary}\n` : ''}${s.suggestionContent || ''}`;
                }).join('\n\n');
                const prompt = `${RULES}\n\nUse the ids (s_...) in the JSON fields and the labels (S1, S2, ...) in reasoningPt.\n\n# PR: ${title}\n\n## Diff\n\n${diff}\n\n## Group members (${order.length})\n\n${list}\n`;
                const base = path.join(RUNS, t.model, `${t.caseId}__${t.g.groupId}`);
                const [A, B] = await Promise.all([ask('opus', prompt, t.g.members, `${base}.opus.json`), ask('astra', prompt, t.g.members, `${base}.astra.json`)]);
                const sa = A.verdict === 'split';
                const sb = B.verdict === 'split';
                if (sa && sb) stats.splitBoth++;
                else if (sa || sb) stats.splitOne++;
                else stats.keepBoth++;
            } catch (e) {
                failed++;
                console.log(`FAILED ${t.model} ${t.caseId} ${t.g.groupId}: ${String(e.message).slice(0, 300)}`);
            }
        }
    }));
    console.log(`recheck: keep (both) ${stats.keepBoth}, split (both) ${stats.splitBoth}, split (one) ${stats.splitOne}, failed ${failed}`);
    process.exit(failed ? 2 : 0);
})();
