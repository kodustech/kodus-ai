#!/usr/bin/env node
/**
 * Coverage labels for multi-part groups (needsUnifiedComment): which parts of
 * the group's problem (facets: locations or defects) each member reports, so a
 * later "best suggestion" eval knows which members are complete.
 *
 * Opus 5.5 and GPT-6 Astra label each group blind; per-member `complete` is
 * compared, agreement stays (high), disagreement goes to an Opus arbiter that
 * sees both answers unlabeled (mid if decisive, low otherwise). Writes to the
 * gold: group.coverageVaries / facets / coverageConfidence, member.coverage / covers.
 *
 *   node evals/dedup/gold/coverage.js [--models=a,b] [--par=6] [--write]
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
const RUNS = path.join(__dirname, 'runs', 'coverage');

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['facets', 'members'],
    properties: {
        facets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'description'], properties: { id: { type: 'string' }, description: { type: 'string' } } } },
        members: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'covers', 'complete'], properties: { id: { type: 'string' }, covers: { type: 'array', items: { type: 'string' } }, complete: { type: 'boolean' } } } },
    },
};
const ARB_SCHEMA = {
    ...SCHEMA,
    required: ['facets', 'members', 'decisive', 'reasoning'],
    properties: { ...SCHEMA.properties, decisive: { type: 'boolean' }, reasoning: { type: 'string' } },
};

const TASK = `# Task

The code review suggestions below were grouped as duplicates: they report the same problem, but the problem has several parts. A part (facet) is a distinct code location that needs its own edit (e.g. "Create, line 45" and "Update, line 129"), or a distinct defect that the merged comment must carry.

1. List the facets of this group's problem, using only what the members actually report (ids F1, F2, ...; one short description each, naming the location or the defect).
2. For every member, list the facets it reports as a problem. A facet counts only when the suggestion states it ("this also happens in Update" counts; a vague "and elsewhere" does not). Mentioning something only inside the proposed fix, or only as context, does not count.
3. complete = true when the member covers every facet.

Every member id must appear exactly once.`;

function call(judge, prompt, schema) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-'));
    const env = { ...process.env };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) delete env[k];
    return new Promise((resolve, reject) => {
        let args;
        let cmd;
        const outFile = path.join(tmp, 'out.json');
        if (judge === 'astra') {
            fs.writeFileSync(path.join(tmp, 'schema.json'), JSON.stringify(schema));
            cmd = 'codex';
            args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high', '--output-schema', path.join(tmp, 'schema.json'), '-o', outFile, '-'];
        } else {
            cmd = 'claude';
            args = ['-p', '--model', 'claude-opus-5-5', '--effort', 'high', '--tools', '', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--no-session-persistence', '--setting-sources', '', '--system-prompt', 'You label code review suggestions. Answer only with the requested JSON.'];
        }
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
    const ids = new Set(ans.facets.map((f) => f.id));
    const seen = ans.members.map((m) => m.id);
    return members.every((m) => seen.filter((x) => x === m).length === 1) && seen.every((m) => members.includes(m)) && ans.members.every((m) => m.covers.every((f) => ids.has(f)));
}

async function ask(judge, prompt, schema, members, file) {
    if (!flag('force') && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).answer;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const ans = await call(judge, prompt, schema);
        if (valid(ans, members)) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ judge, answer: ans }, null, 1));
            return ans;
        }
    }
    throw new Error(`${judge}: invalid answer after 3 attempts`);
}

function groupPrompt(caseId, pr, g) {
    const byId = Object.fromEntries(pr.suggestions.map((s) => [s.id, s]));
    const order = [...g.members].sort((a, b) => sha(a).localeCompare(sha(b)));
    const { title, diff } = diffFor(caseId, order.map((m) => byId[m]));
    const list = order.map((m) => {
        const s = byId[m];
        return `### ${m}\nFile: ${s.relevantFile} (lines ${s.relevantLinesStart}-${s.relevantLinesEnd})\n${s.oneSentenceSummary ? `Summary: ${s.oneSentenceSummary}\n` : ''}${s.suggestionContent || ''}`;
    }).join('\n\n');
    return `${TASK}\n\n# PR: ${title}\n\n## Group problem\n\n${g.defect}\n\n## Diff\n\n${diff}\n\n## Members (${order.length})\n\n${list}\n`;
}

(async () => {
    const models = (arg('models') || '').split(',').filter(Boolean);
    const prs = (arg('prs') || '').split(',').filter(Boolean);
    const tasks = [];
    const golds = {};
    for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.json') && x !== 'human-overrides.json')) {
        const gold = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
        if (!gold.prs || (models.length && !models.includes(gold.model))) continue;
        golds[f] = gold;
        for (const [caseId, pr] of Object.entries(gold.prs)) for (const g of pr.groups) if (g.needsUnifiedComment && (!prs.length || prs.includes(caseId))) tasks.push({ f, model: gold.model, caseId, pr, g });
    }
    console.log(`coverage: ${tasks.length} groups, par ${PAR}`);
    let i = 0;
    let failed = 0;
    const stats = { agree: 0, arbitrated: 0, varies: 0 };
    await Promise.all(Array.from({ length: PAR }, async () => {
        while (i < tasks.length) {
            const t = tasks[i++];
            try {
                const base = path.join(RUNS, t.model, `${t.caseId}__${t.g.groupId}`);
                const prompt = groupPrompt(t.caseId, t.pr, t.g);
                const [A, B] = await Promise.all([ask('opus', prompt, SCHEMA, t.g.members, `${base}.opus.json`), ask('astra', prompt, SCHEMA, t.g.members, `${base}.astra.json`)]);
                const ca = Object.fromEntries(A.members.map((m) => [m.id, m.complete]));
                const cb = Object.fromEntries(B.members.map((m) => [m.id, m.complete]));
                const agree = t.g.members.every((m) => ca[m] === cb[m]);
                let final = A;
                let conf = 'high';
                if (!agree) {
                    const flip = parseInt(sha(t.g.groupId).slice(0, 2), 16) % 2 === 1;
                    const [j1, j2] = flip ? [B, A] : [A, B];
                    const arbPrompt = `${prompt}\n# Your role\n\nTwo independent labelers answered this and disagreed on which members are complete. Decide yourself from the text and the diff; both can be wrong. decisive=true only when the text settles it.\n\n## Labeler 1\n\n${JSON.stringify(j1, null, 1)}\n\n## Labeler 2\n\n${JSON.stringify(j2, null, 1)}\n`;
                    final = await ask('opus', arbPrompt, ARB_SCHEMA, t.g.members, `${base}.arbiter.json`);
                    conf = final.decisive ? 'mid' : 'low';
                    stats.arbitrated++;
                } else stats.agree++;
                const covers = Object.fromEntries(final.members.map((m) => [m.id, m]));
                t.g.facets = final.facets;
                t.g.coverageVaries = !t.g.members.every((m) => covers[m].complete);
                t.g.coverageConfidence = conf;
                t.g.coverageVotes = { opus: ca, astra: cb };
                if (final.reasoning) t.g.coverageArbiterReasoning = final.reasoning;
                for (const s of t.pr.suggestions) if (covers[s.id]) {
                    s.coverage = covers[s.id].complete ? 'complete' : 'partial';
                    s.covers = covers[s.id].covers;
                }
                if (t.g.coverageVaries) stats.varies++;
            } catch (e) {
                failed++;
                console.log(`FAILED ${t.model} ${t.caseId} ${t.g.groupId}: ${String(e.message).slice(0, 300)}`);
            }
        }
    }));
    console.log(`coverage: agree ${stats.agree}, arbitrated ${stats.arbitrated}, coverageVaries ${stats.varies}, failed ${failed}`);
    if (flag('write') && !failed) {
        for (const [f, gold] of Object.entries(golds)) fs.writeFileSync(path.join(__dirname, f), `${JSON.stringify(gold, null, 2)}\n`);
        console.log(`wrote ${Object.keys(golds).length} gold files`);
    }
    process.exit(failed ? 2 : 0);
})();
