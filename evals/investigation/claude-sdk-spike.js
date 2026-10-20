#!/usr/bin/env node
/**
 * #2113 T1: what the pinned Claude Agent SDK actually does, measured before the
 * executor is built on it. Each scenario runs the real `claude` binary.
 *
 *   node evals/investigation/claude-sdk-spike.js                 # scripted fake server, no key
 *   node evals/investigation/claude-sdk-spike.js --upstream=api  # Anthropic API, API_ANTHROPIC_API_KEY
 *   --betas=off                                                   # as non-first-party routes run
 *
 * The SDK is not a dependency yet (T30 pins it); CLAUDE_SDK_DIR points at a
 * folder with `@anthropic-ai/claude-agent-sdk` installed.
 *
 * Answers, written to evals/results/claude-sdk-spike-<date>.json:
 *   - RSS and spawn latency of one subprocess (query() → system/init)
 *   - where PostToolBatch `additionalContext` lands in the next request
 *   - whether a Stop `block` counts toward maxTurns
 *   - PreToolUse deny: what the model sees
 *   - PostToolBatch `continue: false`: how the query ends
 *   - the assistant-message `error` field and result subtype on 401 / 429
 *   - "result then exit 1" on max turns
 *   - what `outputFormat` sends upstream
 *   - which tools the model is offered with `tools: []`
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { startFakeLlmServer } = require('../shared/fake-llm-server');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const UPSTREAM = args.upstream || 'fake';
const MODEL = args.model || 'claude-sonnet-5-5';
const RESULTS_DIR = path.join(__dirname, '..', 'results');

async function loadSdk() {
    const dir = process.env.CLAUDE_SDK_DIR;
    const req = dir ? require('module').createRequire(path.join(dir, 'package.json')) : require;
    const [sdk, zod] = await Promise.all([
        import(pathToFileURL(req.resolve('@anthropic-ai/claude-agent-sdk')).href),
        import(pathToFileURL(req.resolve('zod')).href),
    ]);
    const version = JSON.parse(fs.readFileSync(path.join(path.dirname(req.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8')).version;
    return { sdk, z: zod.z || zod.default || zod, version };
}

function rssKb(pid) {
    try {
        return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) || 0;
    } catch {
        return 0;
    }
}

/** Spawns the CLI ourselves so the pid is known; samples RSS until it exits. */
function trackedSpawner(probe) {
    return (opts) => {
        const child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, signal: opts.signal, stdio: ['pipe', 'pipe', 'pipe'] });
        probe.pid = child.pid;
        probe.spawnedAt = Date.now();
        probe.maxRssKb = 0;
        const timer = setInterval(() => {
            probe.maxRssKb = Math.max(probe.maxRssKb, rssKb(child.pid));
        }, 100);
        child.on('exit', (code, signal) => {
            clearInterval(timer);
            probe.exitCode = code;
            probe.exitSignal = signal;
        });
        child.stderr.on('data', (d) => {
            probe.stderr = ((probe.stderr || '') + d).slice(-4000);
        });
        return child;
    };
}

function sessionEnv(baseUrl, token, home) {
    return {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: token,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_MAX_RETRIES: '0',
        // Non-first-party routes (OpenRouter, LiteLLM) run with experimental betas off.
        ...(args.betas === 'off' ? { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' } : {}),
    };
}

function toolsServer(sdk, z, handlers = {}) {
    const read = sdk.tool('readFile', 'Read a file of the repository under review.', { path: z.string() }, async (a) => ({
        content: [{ type: 'text', text: handlers.readFile ? handlers.readFile(a) : `contents of ${a.path}` }],
    }));
    const submit = sdk.tool(
        'submitResult',
        'Submit the final findings.',
        { suggestions: z.array(z.object({ relevantFile: z.string() })) },
        async () => ({ content: [{ type: 'text', text: 'submitted' }] }),
    );
    return sdk.createSdkMcpServer({ name: 'kodus', version: '1', tools: [read, submit] });
}

const TOOL_NAMES = ['mcp__kodus__readFile', 'mcp__kodus__submitResult'];

async function runQuery(ctx, { prompt, options = {}, hooks }) {
    const probe = {};
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'csdk-spike-'));
    const startedAt = Date.now();
    const messages = [];
    let thrown;
    try {
        for await (const m of ctx.sdk.query({
            prompt,
            options: {
                model: MODEL,
                systemPrompt: 'You review code. Use the tools, then call submitResult.',
                tools: [],
                settingSources: [],
                persistSession: false,
                cwd: home,
                env: sessionEnv(ctx.baseUrl, ctx.token, home),
                mcpServers: { kodus: toolsServer(ctx.sdk, ctx.z) },
                allowedTools: TOOL_NAMES,
                maxTurns: 8,
                spawnClaudeCodeProcess: trackedSpawner(probe),
                ...(hooks ? { hooks } : {}),
                ...options,
            },
        })) {
            if (m.type === 'system' && m.subtype === 'init' && !probe.initAt) probe.initAt = Date.now();
            messages.push(m);
        }
    } catch (e) {
        thrown = String(e?.message || e).slice(0, 500);
    }
    fs.rmSync(home, { recursive: true, force: true });
    const result = messages.find((m) => m.type === 'result');
    return {
        ms: Date.now() - startedAt,
        spawnToInitMs: probe.initAt && probe.spawnedAt ? probe.initAt - probe.spawnedAt : null,
        maxRssMb: probe.maxRssKb ? Math.round(probe.maxRssKb / 1024) : null,
        exitCode: probe.exitCode,
        thrown,
        resultSubtype: result?.subtype,
        resultIsError: result?.is_error,
        numTurns: result?.num_turns,
        structuredOutput: result?.structured_output,
        assistantErrors: messages.filter((m) => m.type === 'assistant' && m.error).map((m) => m.error),
        assistantTexts: messages.filter((m) => m.type === 'assistant').flatMap((m) => (m.message.content || []).filter((c) => c.type === 'text').map((c) => c.text)),
        toolUses: messages.filter((m) => m.type === 'assistant').flatMap((m) => (m.message.content || []).filter((c) => c.type === 'tool_use').map((c) => c.name)),
        stderrTail: probe.stderr ? probe.stderr.slice(-600) : undefined,
    };
}

/** Requests the CLI made to the model endpoint during one scenario. */
function modelCalls(server, since) {
    return server.calls.slice(since).filter((c) => /\/v1\/messages$/.test(c.path));
}

function lastUserContent(body) {
    const users = (body?.messages || []).filter((m) => m.role === 'user');
    return users[users.length - 1]?.content;
}

function where(body, needle) {
    const hits = [];
    if (JSON.stringify(body?.system || '').includes(needle)) hits.push('system');
    (body?.messages || []).forEach((m, i) => {
        const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
        blocks.forEach((b, j) => {
            if (JSON.stringify(b).includes(needle)) hits.push(`messages[${i}].${m.role}.content[${j}].${b.type}`);
        });
    });
    return hits;
}

async function scenarios(ctx) {
    const { server } = ctx;
    const out = {};
    let mark;

    // 1. Plain tool loop: explore → submit. Spawn latency, RSS, paths hit, tools offered.
    mark = server ? server.calls.length : 0;
    out.toolLoop = await runQuery(ctx, { prompt: 'Review the change in a.ts.' });
    if (server) {
        const calls = server.calls.slice(mark);
        out.toolLoop.pathsHit = [...new Set(calls.map((c) => `${c.method} ${c.path}`))];
        const first = modelCalls(server, mark)[0];
        out.toolLoop.toolsOffered = (first?.body?.tools || []).map((t) => t.name);
        out.toolLoop.firstRequestKeys = Object.keys(first?.body || {}).sort();
        out.toolLoop.firstRequestFields = { thinking: first?.body?.thinking, output_config: first?.body?.output_config, context_management: first?.body?.context_management, max_tokens: first?.body?.max_tokens };
        out.toolLoop.anthropicBeta = first?.headers?.['anthropic-beta'];
        out.toolLoop.modelRequests = modelCalls(server, mark).length;
    }

    // 2. PostToolBatch additionalContext: where does the note land in the next request?
    const NOTE = 'BUDGET-NOTE-7f3a: you have 2 steps left.';
    mark = server ? server.calls.length : 0;
    out.postToolBatchNote = await runQuery(ctx, {
        prompt: 'Review the change in a.ts.',
        hooks: { PostToolBatch: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: NOTE } })] }] },
    });
    if (server) {
        const second = modelCalls(server, mark)[1];
        out.postToolBatchNote.noteLocation = where(second?.body, 'BUDGET-NOTE-7f3a');
        out.postToolBatchNote.lastUserContent = lastUserContent(second?.body);
    }

    // 3. Stop block: model never submits; Stop blocks once with the finalize note. Does it count toward maxTurns?
    for (const maxTurns of [1, 2]) {
        mark = server ? server.calls.length : 0;
        let stopCalls = 0;
        if (server) ctx.script = (body) => ({ text: 'I found a bug in a.ts.' });
        const r = await runQuery(ctx, {
            prompt: 'Review the change in a.ts.',
            options: { maxTurns },
            hooks: {
                Stop: [
                    {
                        hooks: [
                            async (input) => {
                                stopCalls += 1;
                                if (input.stop_hook_active) return {};
                                return { decision: 'block', reason: 'FINALIZE-NOTE-91c: call submitResult now with what you found.' };
                            },
                        ],
                    },
                ],
            },
        });
        ctx.script = undefined;
        r.stopHookCalls = stopCalls;
        if (server) {
            r.modelRequests = modelCalls(server, mark).length;
            r.finalizeNoteLocation = where(modelCalls(server, mark)[1]?.body, 'FINALIZE-NOTE-91c');
        }
        out[`stopBlockMaxTurns${maxTurns}`] = r;
    }

    // 4. PreToolUse deny: readFile denied with a reason.
    mark = server ? server.calls.length : 0;
    out.preToolUseDeny = await runQuery(ctx, {
        prompt: 'Review the change in a.ts.',
        hooks: {
            PreToolUse: [
                {
                    hooks: [
                        async (input) =>
                            input.tool_name === 'mcp__kodus__readFile'
                                ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'DENY-REASON-55: finalize now.' } }
                                : {},
                    ],
                },
            ],
        },
    });
    if (server) out.preToolUseDeny.denyLocation = where(modelCalls(server, mark)[1]?.body, 'DENY-REASON-55');

    // 5. PostToolBatch continue:false: how does the query end?
    out.continueFalse = await runQuery(ctx, {
        prompt: 'Review the change in a.ts.',
        hooks: { PostToolBatch: [{ hooks: [async () => ({ continue: false, stopReason: 'policy stop' })] }] },
    });

    // 6. Max turns: result then exit code?
    if (server) ctx.script = (body) => ({ tool: (body.tools || []).find((t) => t.name === 'mcp__kodus__readFile') });
    out.maxTurns = await runQuery(ctx, { prompt: 'Review the change in a.ts.', options: { maxTurns: 2 } });
    ctx.script = undefined;

    // 7. outputFormat: what is sent upstream and what comes back.
    mark = server ? server.calls.length : 0;
    out.outputFormat = await runQuery(ctx, {
        prompt: 'Classify severity of: null deref in a.ts.',
        options: {
            mcpServers: {},
            allowedTools: [],
            maxTurns: 1,
            outputFormat: { type: 'json_schema', schema: { type: 'object', properties: { severity: { type: 'string', enum: ['low', 'high'] } }, required: ['severity'] } },
        },
    });
    if (server) {
        const first = modelCalls(server, mark)[0];
        out.outputFormat.toolsOffered = (first?.body?.tools || []).map((t) => t.name);
        out.outputFormat.outputConfig = first?.body?.output_config ?? first?.body?.output_format;
        out.outputFormat.anthropicBeta = first?.headers?.['anthropic-beta'];
        out.outputFormat.modelRequests = modelCalls(server, mark).length;
    }

    // 8. Upstream errors: the assistant `error` field and the result.
    if (server) {
        for (const status of [401, 429, 529]) {
            server.failNext({ status, headers: status === 429 ? { 'retry-after': '1' } : {} });
            out[`upstream${status}`] = await runQuery(ctx, { prompt: 'Review the change in a.ts.' });
        }
    }
    return out;
}

async function main() {
    const { sdk, z, version } = await loadSdk();
    const ctx = { sdk, z };
    if (UPSTREAM === 'fake') {
        ctx.token = 'spike-session-token';
        const server = await startFakeLlmServer({ auth: { anthropicKey: ctx.token }, anthropicScript: (body, seq) => ctx.script && ctx.script(body, seq) });
        ctx.server = server;
        ctx.baseUrl = server.origin;
    } else if (UPSTREAM === 'api') {
        require('dotenv').config({ path: path.join(__dirname, '../../.env') });
        ctx.token = process.env.API_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
        if (!ctx.token) {
            console.error('no Anthropic key (API_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY)');
            process.exit(2);
        }
        ctx.baseUrl = 'https://api.anthropic.com';
    } else {
        console.error(`unknown --upstream=${UPSTREAM}`);
        process.exit(2);
    }

    const runs = Number(args.runs || 1);
    const all = [];
    for (let i = 0; i < runs; i++) all.push(await scenarios(ctx));
    if (ctx.server) await ctx.server.close();

    const spawn = all.flatMap((r) => Object.values(r).map((s) => s.spawnToInitMs).filter((v) => v != null)).sort((a, b) => a - b);
    const rss = all.flatMap((r) => Object.values(r).map((s) => s.maxRssMb).filter((v) => v != null)).sort((a, b) => a - b);
    const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null);
    const report = {
        date: new Date().toISOString(),
        sdkVersion: version,
        upstream: UPSTREAM,
        experimentalBetas: args.betas === 'off' ? 'off' : 'on',
        model: MODEL,
        platform: `${os.platform()}-${os.arch()}`,
        node: process.version,
        spawnToInitMs: { p50: pct(spawn, 0.5), p95: pct(spawn, 0.95), n: spawn.length },
        maxRssMb: { p50: pct(rss, 0.5), max: rss[rss.length - 1] ?? null, n: rss.length },
        scenarios: all[0],
    };
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const suffix = args.betas === 'off' ? '-betas-off' : '';
    const file = path.join(RESULTS_DIR, `claude-sdk-spike-${UPSTREAM}${suffix}-${report.date.slice(0, 10)}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nwritten ${path.relative(process.cwd(), file)}`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});
