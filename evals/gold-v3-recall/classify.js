#!/usr/bin/env node
// Classifies the gold v3's valid TPs of a set by defect class (classify-rule.md),
// to know how many bugs of each class a set holds.
//   node evals/gold-v3-recall/classify.js --set=light [--model=claude-haiku-5-5] [--out=<file>]
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { repoTools, TOOLS, judgeKey } = require('./judge');
const { validIssues } = require('./score');

const ROOT = path.join(__dirname, '../..');
const GOLD = path.join(ROOT, 'evals/dedup/gold-v3');
const BENCH = process.env.BENCH_REPOS_ROOT || path.join(process.env.HOME || '', 'projects/benchmark');
const RULE = fs.readFileSync(path.join(__dirname, 'classify-rule.md'), 'utf8');
const CLASSES = ['consumer-outside-diff', 'sibling-not-updated', 'edge-case-logic', 'error-handling', 'state-concurrency', 'security', 'performance', 'spec-mismatch', 'other'];

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const model = args.model || 'claude-haiku-5-5';
const out = args.out || path.join(GOLD, `classes-${args.set || 'light'}-${model}.json`);
const cases = require(path.join(ROOT, 'evals/investigation/recall-tests.js')).CASE_SETS[args.set || 'light'];
const gold = JSON.parse(fs.readFileSync(path.join(GOLD, 'golden.json'), 'utf8')).prs;
const issuesCtx = JSON.parse(fs.readFileSync(path.join(GOLD, 'judge-issues.json'), 'utf8')).cases;
const repos = JSON.parse(fs.readFileSync(path.join(GOLD, 'repos.json'), 'utf8'));
const upstream = Object.fromEntries(Object.values(JSON.parse(fs.readFileSync(path.join(GOLD, 'upstream-verification.json'), 'utf8')).prs).flatMap((p) => Object.entries(p.tps).map(([id, v]) => [id, v.status])));
// A dataset's file name differs from its caseId for some cases: index by caseId.
const DATASETS = (() => {
    const dir = path.join(ROOT, 'evals/investigation/datasets');
    const byId = {};
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        try {
            const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const v = (Array.isArray(d) ? d[0] : d)?.vars;
            if (v?.caseId) byId[v.caseId] = v;
        } catch {}
    }
    return byId;
})();
const dataset = (c) => {
    if (!DATASETS[c]) throw new Error(`no dataset for ${c}`);
    return DATASETS[c];
};

const SUBMIT = {
    name: 'submit_classes',
    description: 'Submit one class per bug id.',
    strict: true,
    input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
            answers: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { id: { type: 'string' }, class: { type: 'string', enum: CLASSES }, where: { type: 'string', enum: ['in-diff', 'outside-diff'] }, reason: { type: 'string' } },
                    required: ['id', 'class', 'where', 'reason'],
                },
            },
        },
        required: ['answers'],
    },
};

async function classifyCase(client, c) {
    const valid = validIssues(gold[c] || [], upstream);
    const bugs = (issuesCtx[c]?.issues || []).filter((i) => valid.has(i.issueId)).map((i) => ({ id: i.issueId, description: i.description, knownIssueText: i.knownIssueText, reportedAt: i.earlierComments }));
    if (!bugs.length) return [];
    const v = dataset(c);
    const files = (typeof v.prFiles === 'string' ? JSON.parse(v.prFiles) : v.prFiles || []).map((f) => f.filename);
    const tools = repoTools(path.join(BENCH, repos[c].repo), repos[c].head);
    const messages = [{ role: 'user', content: JSON.stringify({ pullRequest: { title: v.prTitle, changedFiles: files }, bugs }, null, 1) }];
    for (let turn = 0; turn < 30; turn += 1) {
        const r = await client.messages.create({ model, max_tokens: 16000, thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, system: RULE, tools: [...TOOLS.filter((t) => t.name !== 'submit_matches'), SUBMIT], messages });
        messages.push({ role: 'assistant', content: r.content });
        const calls = r.content.filter((b) => b.type === 'tool_use');
        const submit = calls.find((x) => x.name === 'submit_classes');
        if (submit) return submit.input.answers.map((a) => ({ ...a, caseId: c }));
        if (!calls.length) {
            messages.push({ role: 'user', content: 'Call submit_classes with one answer per bug id.' });
            continue;
        }
        messages.push({
            role: 'user',
            content: calls.map((x) => {
                try {
                    return { type: 'tool_result', tool_use_id: x.id, content: tools[x.name](x.input || {}) };
                } catch (e) {
                    return { type: 'tool_result', tool_use_id: x.id, content: String(e.message).slice(0, 300), is_error: true };
                }
            }),
        });
    }
    throw new Error(`${c}: no answer`);
}

(async () => {
    const client = new Anthropic({ apiKey: judgeKey() });
    // Resume: cases already classified in --out are kept.
    const results = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')).items : [];
    const done = new Set(results.map((r) => r.caseId));
    const todo = cases.filter((c) => !done.has(c));
    let i = 0;
    const work = async () => {
        while (i < todo.length) {
            const c = todo[i++];
            try {
                results.push(...(await classifyCase(client, c)));
                console.log('ok', c);
            } catch (e) {
                console.log('FAIL', c, e.message.slice(0, 200));
            }
        }
    };
    await Promise.all(Array.from({ length: 6 }, work));
    fs.writeFileSync(out, JSON.stringify({ model, set: args.set || 'light', rule: 'classify-rule.md', items: results }, null, 1));
    const count = {};
    for (const r of results) count[r.class] = (count[r.class] || 0) + 1;
    console.log(model, results.length, JSON.stringify(count));
    process.exit(0);
})();
