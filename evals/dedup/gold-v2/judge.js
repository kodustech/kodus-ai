#!/usr/bin/env node
/**
 * Gold de duplicatas v2 (#1821): um juiz por vez, uma chamada por (modelo, PR)
 * com todas as sugestoes do PR. Grupos de UM problema cada; a sugestao que
 * reporta mais de um problema vai para multiProblem e nao cola grupos.
 * Opus 5.5 pelo Claude Code CLI e GPT-6 Astra pelo Codex CLI, assinatura, sem
 * ferramentas. Respostas em gold-v2/runs/<judge>/<model>/.
 *
 *   node evals/dedup/gold-v2/judge.js --judge=opus|astra [--models=a,b] [--prs=a,b] [--par=4] [--force]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const flag = (n) => process.argv.includes(`--${n}`);
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

const JUDGE = arg('judge');
if (!['opus', 'astra'].includes(JUDGE)) {
    console.error('--judge=opus|astra');
    process.exit(2);
}
const PAR = Number(arg('par', '4'));

const CONF = { type: 'string', enum: ['low', 'mid', 'high'] };
const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['groups', 'multiProblem', 'unique'],
    properties: {
        groups: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'members', 'kind', 'confidence', 'problem', 'rationale'],
                properties: {
                    id: { type: 'string' },
                    members: { type: 'array', items: { type: 'string' } },
                    kind: { type: 'string', enum: ['same_location', 'cross_location', 'systemic_pattern'] },
                    confidence: CONF,
                    problem: { type: 'string' },
                    rationale: { type: 'string' },
                },
            },
        },
        multiProblem: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'problems', 'relatedGroups', 'uncoveredProblems', 'confidence'],
                properties: {
                    id: { type: 'string' },
                    problems: { type: 'array', items: { type: 'string' } },
                    relatedGroups: { type: 'array', items: { type: 'string' } },
                    uncoveredProblems: { type: 'array', items: { type: 'string' } },
                    confidence: CONF,
                },
            },
        },
        unique: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'confidence'],
                properties: { id: { type: 'string' }, confidence: CONF },
            },
        },
    },
};

const INSTRUCTIONS = fs.readFileSync(path.join(__dirname, 'judge-prompt.md'), 'utf8');

const { diffFor } = require('../gold/judge-context');

function buildPrompt(caseId, suggestions) {
    // Stable per-judge shuffle, so position in the list carries no signal.
    const order = [...suggestions].sort((a, b) => sha(`${JUDGE}|${a.id}`).localeCompare(sha(`${JUDGE}|${b.id}`)));
    const { title, diff } = diffFor(caseId, suggestions);
    const list = order
        .map((s) => {
            const lines = `${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}`;
            const summary = s.oneSentenceSummary ? `Summary: ${s.oneSentenceSummary}\n` : '';
            return `### ${s.id}\nFile: ${s.relevantFile} (lines ${lines})\n${summary}${s.suggestionContent || ''}`;
        })
        .join('\n\n');
    return `${INSTRUCTIONS}\n\n# PR: ${title}\n\n## Diff (line numbers are the PR head)\n\n${diff}\n\n## Suggestions (${order.length})\n\n${list}\n`;
}

function validate(ans, ids) {
    const errs = [];
    const seen = new Map();
    const gids = new Set();
    for (const g of ans.groups || []) {
        if ((g.members || []).length < 2) errs.push(`group ${g.id} with fewer than 2 members: ${JSON.stringify(g.members)}`);
        if (gids.has(g.id)) errs.push(`duplicate group id ${g.id}`);
        gids.add(g.id);
        for (const id of g.members || []) seen.set(id, (seen.get(id) || 0) + 1);
    }
    for (const m of ans.multiProblem || []) {
        seen.set(m.id, (seen.get(m.id) || 0) + 1);
        for (const g of m.relatedGroups || []) if (!gids.has(g)) errs.push(`multiProblem ${m.id} points at unknown group ${g}`);
        if ((m.problems || []).length < 2) errs.push(`multiProblem ${m.id} lists fewer than 2 problems`);
    }
    for (const u of ans.unique || []) seen.set(u.id, (seen.get(u.id) || 0) + 1);
    for (const id of ids) {
        const n = seen.get(id) || 0;
        if (n === 0) errs.push(`missing ${id}`);
        if (n > 1) errs.push(`${id} appears ${n} times`);
    }
    for (const id of seen.keys()) if (!ids.includes(id)) errs.push(`unknown id ${id}`);
    return errs;
}

function run(cmd, args, input, env, cwd) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}: ${(err || out).slice(-800)}`))));
        p.stdin.end(input);
    });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-judge-'));
const schemaFile = path.join(tmp, 'schema.json');
fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA));
const cleanEnv = () => {
    const env = { ...process.env };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) delete env[k];
    return env;
};

async function callJudge(prompt) {
    if (JUDGE === 'opus') {
        const out = await run(
            'claude',
            ['-p', '--model', 'claude-opus-5-5', '--effort', 'high', '--tools', '', '--output-format', 'json',
                '--json-schema', JSON.stringify(SCHEMA), '--no-session-persistence', '--setting-sources', '',
                '--system-prompt', 'You group duplicate code review suggestions. Answer only with the requested JSON.'],
            prompt, cleanEnv(), tmp,
        );
        const r = JSON.parse(out);
        if (r.is_error) throw new Error(`claude error: ${String(r.result).slice(0, 500)}`);
        const ans = r.structured_output ?? JSON.parse(r.result);
        return { ans, usage: r.usage, costUsd: r.total_cost_usd };
    }
    const outFile = path.join(tmp, `out-${crypto.randomUUID()}.json`);
    await run(
        'codex',
        ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high',
            '--output-schema', schemaFile, '-o', outFile, '-'],
        prompt, cleanEnv(), tmp,
    );
    const ans = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    fs.rmSync(outFile, { force: true });
    return { ans };
}

async function label(model, caseId, suggestions) {
    const dir = path.join(__dirname, 'runs', JUDGE, model);
    const file = path.join(dir, `${caseId}.json`);
    if (!flag('force') && fs.existsSync(file)) return 'cached';
    fs.mkdirSync(dir, { recursive: true });
    const ids = suggestions.map((s) => s.id);
    if (ids.length < 2) {
        const ans = { groups: [], multiProblem: [], unique: ids.map((id) => ({ id, confidence: 'high' })) };
        fs.writeFileSync(file, JSON.stringify({ judge: JUDGE, model, caseId, trivial: true, answer: ans }, null, 2));
        return 'trivial';
    }
    let prompt = buildPrompt(caseId, suggestions);
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const t0 = Date.now();
        try {
            const r = await callJudge(prompt);
            const errs = validate(r.ans, ids);
            last = { attempt, errs, ms: Date.now() - t0 };
            if (!errs.length) {
                fs.writeFileSync(file, JSON.stringify({ judge: JUDGE, model, caseId, promptSha: sha(prompt), attempt, ms: Date.now() - t0, usage: r.usage, costUsd: r.costUsd, answer: r.ans }, null, 2));
                return `ok (${attempt})`;
            }
            prompt = `${buildPrompt(caseId, suggestions)}\n\n# Your previous answer was invalid\n\n${errs.slice(0, 20).join('\n')}\n\nEvery suggestion id must appear exactly once: in one group, in multiProblem, or in unique.\n`;
        } catch (e) {
            last = { attempt, error: String(e.message || e).slice(0, 800) };
        }
    }
    throw new Error(`failed after 3 attempts: ${JSON.stringify(last)}`);
}

(async () => {
    const models = (arg('models') || '').split(',').filter(Boolean);
    const prs = (arg('prs') || '').split(',').filter(Boolean);
    const golds = fs.readdirSync(__dirname).filter((f) => /^09\.10\.26_.*\.json$/.test(f) && !/\.(labels|review)\.json$/.test(f))
        .map((f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')))
        .filter((g) => g.prs && (!models.length || models.includes(g.model)));
    const queue = [];
    for (const g of golds) for (const [caseId, pr] of Object.entries(g.prs)) if (!prs.length || prs.includes(caseId)) queue.push({ model: g.model, caseId, suggestions: pr.suggestions });
    console.log(`${JUDGE}: ${queue.length} (model, PR) units, par ${PAR}`);
    let i = 0;
    let failed = 0;
    const worker = async () => {
        while (i < queue.length) {
            const u = queue[i++];
            try {
                const st = await label(u.model, u.caseId, u.suggestions);
                console.log(`[${JUDGE}] ${u.model} ${u.caseId} (${u.suggestions.length}): ${st}`);
            } catch (e) {
                failed++;
                console.log(`[${JUDGE}] ${u.model} ${u.caseId}: FAILED ${String(e.message).slice(0, 400)}`);
            }
        }
    };
    await Promise.all(Array.from({ length: PAR }, worker));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`${JUDGE}: done, ${failed} failed`);
    process.exit(failed ? 2 : 0);
})();
