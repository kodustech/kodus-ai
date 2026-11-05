// The gold-v3 judge: Claude (Haiku 5.5 by default, GOLD_JUDGE_MODEL to change) matches one pull request's review comments to
// its golden issues (judge-rule.md), reading the code at the PR's head when it
// needs to. One conversation per pull request; the answer comes through the
// submit_matches tool.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');

// Haiku 5.5 by default: it agreed with Opus 5.5 on 249 of 252 comments of two
// earlier runs, at about a thirtieth of the cost (README.md, "The judge").
const JUDGE_MODEL = process.env.GOLD_JUDGE_MODEL || 'claude-haiku-5-5';
const JUDGE_EFFORT = process.env.GOLD_JUDGE_EFFORT || 'high';
const RULE = fs.readFileSync(path.join(__dirname, 'judge-rule.md'), 'utf8');
const MAX_TURNS = 30;
const MAX_READ_LINES = 400;
const MAX_GREP_LINES = 200;

function judgeKey() {
    return process.env.API_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || null;
}

const TOOLS = [
    {
        name: 'read_file',
        description: `Read a file of the repository at the pull request head. Returns numbered lines, at most ${MAX_READ_LINES} per call.`,
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path from the repository root.' },
                startLine: { type: 'integer', description: 'First line to return (1-based). Default 1.' },
                endLine: { type: 'integer', description: 'Last line to return. Default startLine + 399.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'grep',
        description: `Search the repository at the pull request head (git grep, extended regex). Returns path:line:text, at most ${MAX_GREP_LINES} lines.`,
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string' },
                path: { type: 'string', description: 'Limit the search to this path or folder.' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'submit_matches',
        description: 'Submit the answer: one entry per new comment id.',
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
                        properties: {
                            id: { type: 'string' },
                            match: { type: 'string', description: 'The issueId, or "new".' },
                            reason: { type: 'string' },
                        },
                        required: ['id', 'match', 'reason'],
                    },
                },
            },
            required: ['answers'],
        },
    },
];

const safePath = (p) => {
    const clean = String(p || '').replace(/^\/+/, '');
    if (!clean || clean.split('/').includes('..')) throw new Error(`path not allowed: ${p}`);
    return clean;
};

// The repository at the head, read through git: nothing is checked out or changed.
function repoTools(repoDir, head) {
    const git = (args) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return {
        read_file({ path: p, startLine, endLine }) {
            const lines = git(['show', `${head}:${safePath(p)}`]).split('\n');
            const start = Math.max(1, Number(startLine) || 1);
            const end = Math.min(lines.length, Number(endLine) || start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
            return lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n') || '(empty range)';
        },
        grep({ pattern, path: p }) {
            let out;
            try {
                out = git(['grep', '-n', '-I', '-E', '-e', String(pattern), head, '--', ...(p ? [safePath(p)] : [])]);
            } catch (error) {
                if (error.status === 1) return '(no match)';
                throw error;
            }
            const lines = out.split('\n').filter(Boolean).map((l) => l.replace(`${head}:`, ''));
            return lines.slice(0, MAX_GREP_LINES).join('\n') + (lines.length > MAX_GREP_LINES ? `\n... ${lines.length - MAX_GREP_LINES} more` : '');
        },
    };
}

/**
 * Matches `comments` ([{ id, file, lines, text }]) to `issues` of one PR.
 * Returns { answers: Map id → { match, reason }, usage, ms, turns }.
 * Throws when the judge does not answer every comment (the case is not measured).
 */
async function judgeCase({ caseId, prTitle, repoDir, head, issues, comments, model = JUDGE_MODEL, effort = JUDGE_EFFORT, client = new Anthropic({ apiKey: judgeKey() }) }) {
    const tools = repoTools(repoDir, head);
    const issueIds = new Set(issues.map((i) => i.issueId));
    const payload = {
        pullRequest: { caseId, title: prTitle || null },
        issues: issues.map((i) => ({ issueId: i.issueId, description: i.description, knownIssueText: i.knownIssueText || null, earlierComments: i.earlierComments || [] })),
        newComments: comments,
    };
    const messages = [{ role: 'user', content: `Golden issues and new comments of one pull request:\n\n${JSON.stringify(payload, null, 1)}` }];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
    const startedAt = Date.now();

    for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
        const response = await client.messages.create({
            model,
            max_tokens: 16000,
            thinking: { type: 'adaptive' },
            output_config: { effort },
            system: RULE,
            tools: TOOLS,
            messages,
        });
        usage.calls += 1;
        usage.input += response.usage?.input_tokens || 0;
        usage.output += response.usage?.output_tokens || 0;
        usage.cacheRead += response.usage?.cache_read_input_tokens || 0;
        usage.cacheWrite += response.usage?.cache_creation_input_tokens || 0;
        if (response.stop_reason === 'refusal') throw new Error(`judge refused (${response.stop_details?.category || 'no category'})`);
        if (response.stop_reason === 'max_tokens') throw new Error('judge hit max_tokens');

        messages.push({ role: 'assistant', content: response.content });
        const calls = response.content.filter((b) => b.type === 'tool_use');
        const submit = calls.find((c) => c.name === 'submit_matches');
        if (submit) {
            const answers = new Map();
            for (const a of submit.input?.answers || []) {
                answers.set(a.id, { match: a.match === 'new' || issueIds.has(a.match) ? a.match : 'new', reason: a.reason, rawMatch: a.match });
            }
            const missing = comments.filter((c) => !answers.has(c.id)).map((c) => c.id);
            if (missing.length) throw new Error(`judge left ${missing.length} comment(s) unanswered: ${missing.join(', ')}`);
            return { answers, usage, ms: Date.now() - startedAt, turns: turn };
        }
        if (!calls.length) {
            messages.push({ role: 'user', content: 'Call submit_matches with one answer per new comment id.' });
            continue;
        }
        const results = calls.map((c) => {
            try {
                const fn = tools[c.name];
                if (!fn) throw new Error(`unknown tool ${c.name}`);
                return { type: 'tool_result', tool_use_id: c.id, content: fn(c.input || {}) };
            } catch (error) {
                return { type: 'tool_result', tool_use_id: c.id, content: String(error.message || error).slice(0, 500), is_error: true };
            }
        });
        messages.push({ role: 'user', content: results });
    }
    throw new Error(`judge gave no answer in ${MAX_TURNS} turns`);
}

module.exports = { judgeCase, judgeKey, JUDGE_MODEL, JUDGE_EFFORT, RULE };
