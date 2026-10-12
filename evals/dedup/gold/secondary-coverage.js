#!/usr/bin/env node
/**
 * Analysis only (does not touch the gold): for every suggestion that reports
 * more than one defect, list its secondary defects and whether another
 * suggestion of the same (model, PR) reports each one as ITS main defect.
 * A secondary defect with no such suggestion would be lost if a "core
 * extractor" kept only each suggestion's main defect.
 *
 *   node evals/dedup/gold/secondary-coverage.js [--models=a,b] [--prs=a,b] [--par=8]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const PAR = Number(arg('par', '8'));
const RUNS = path.join(__dirname, 'runs', 'secondary');

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'mainDefect', 'secondary'], properties: {
        id: { type: 'string' },
        mainDefect: { type: 'string' },
        secondary: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['defect', 'coveredBy'], properties: { defect: { type: 'string' }, coveredBy: { type: 'array', items: { type: 'string' } } } } },
    } } } },
};

const TASK = `# Task

Below are all the code review suggestions one reviewer model produced for one pull request.

Some suggestions report more than one defect. The FIRST defect a suggestion reports is its main defect; anything else it reports as a problem (after "Also", "Additionally", "Separately", in the WHY, or as an extra point) is a secondary defect. A remark that is only part of the fix for the main defect is not a secondary defect.

For every suggestion that has at least one secondary defect, output:
- id
- mainDefect: one sentence.
- secondary: each secondary defect (one sentence), with coveredBy = the ids of OTHER suggestions in this list whose MAIN defect is that same defect (same problem, same fix). Empty when no other suggestion has it as its main defect.

Leave out suggestions that report a single defect. Only use ids from the list.`;

function call(judge, prompt) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secondary-'));
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
        args = ['-p', '--model', 'claude-opus-5-5', '--effort', 'high', '--tools', '', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA), '--no-session-persistence', '--setting-sources', '', '--system-prompt', 'You analyze code review suggestions. Answer only with the requested JSON.'];
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

async function ask(judge, prompt, ids, file) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).answer;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const ans = await call(judge, prompt);
        const ok = ans.items.every((it) => ids.includes(it.id) && it.secondary.every((s) => s.coveredBy.every((c) => ids.includes(c) && c !== it.id)));
        if (ok) {
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
            const sugs = pr.suggestions.filter((s) => !s.unusable);
            if (sugs.length) tasks.push({ model: gold.model, caseId, sugs });
        }
    }
    console.log(`secondary: ${tasks.length} (model, PR) units, par ${PAR}`);
    let i = 0;
    let failed = 0;
    await Promise.all(Array.from({ length: PAR }, async () => {
        while (i < tasks.length) {
            const t = tasks[i++];
            try {
                const list = t.sugs.map((s) => `### ${s.id}\nFile: ${s.relevantFile} (lines ${s.relevantLinesStart}-${s.relevantLinesEnd})\n${s.suggestionContent || ''}`).join('\n\n');
                const prompt = `${TASK}\n\n# Suggestions (${t.sugs.length})\n\n${list}\n`;
                const ids = t.sugs.map((s) => s.id);
                const base = path.join(RUNS, t.model, t.caseId);
                await Promise.all([ask('opus', prompt, ids, `${base}.opus.json`), ask('astra', prompt, ids, `${base}.astra.json`)]);
                console.log(`${t.model} ${t.caseId}: ok`);
            } catch (e) {
                failed++;
                console.log(`FAILED ${t.model} ${t.caseId}: ${String(e.message).slice(0, 300)}`);
            }
        }
    }));
    console.log(`secondary: done, ${failed} failed`);
    process.exit(failed ? 2 : 0);
})();
