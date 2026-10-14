// The same comparison, through the prompts and chunking production actually uses.
//
// `llm-vs-analyzers.js` sends one model call carrying the whole diff and only
// the category prompt. Production does neither: it renders the full agent
// prompt (identity + category + rules + output contract) and splits the files
// into token-budget batches, one call each. On a 39-file pull request that is
// the difference between a focused prompt and a 190k-token wall, and it biases
// the measurement AGAINST the reviewer — while the analyzer side of the
// comparison is production code either way.
//
// Closes the two largest gaps by calling production's own builders. Still
// missing, and still a floor rather than a ceiling: the agent's tool loop (no
// sandbox here), the other four agents, and the post-processing.
//
//   node evals/security-analyzers/agent-path.js --dataset=... --analyzers=... --model=kimi-k2.7-code
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (module, filename) {
    const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2021', sourcefile: filename,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    });
    module._compile(code, filename);
};
require('tsconfig-paths/register');

const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
}));
const MODEL = args.model || 'kimi-k2.7-code';
const LIMIT = Number(args.limit || Infinity);
const CONCURRENCY = Number(args.concurrency || 4);
const BUDGET = Number(args.budget || 60000); // per-chunk diff token budget

const { applyModelEnv } = require('../shared/tier0-models');
const { buildEvalModel } = require('../shared/build-model');
const {
    buildSelfContainedSystemPrompt,
    buildSelfContainedUserPrompt,
} = require('../../libs/code-review/infrastructure/agents/prompts/prompt-builder.ts');
const { chunkFilesByTokenBudget } = require(
    '../../libs/code-review/infrastructure/agents/collaborators/context-fit-planner.ts',
);
const { buildCategoryReviewPrompt } = require(
    '../../libs/code-review/infrastructure/agents/prompts/review-prompt-blocks.ts',
);

/** The real SecurityAgentProvider identity, copied from getIdentity(). */
const META = {
    identity: {
        name: 'kodus-security-review-agent',
        description:
            'Application security expert specialized in finding vulnerabilities, ' +
            'auth issues, injection flaws, data exposure, and secrets in code changes. ' +
            'Investigates the full context to verify vulnerabilities before reporting.',
        goal:
            'Find real security vulnerabilities in the code changes by verifying ' +
            'attack vectors, sanitization, and auth flows in the codebase.',
        expertise: [
            'OWASP Top 10 vulnerabilities',
            'Authentication and authorization flows',
            'Input validation and sanitization',
            'Injection attack vectors (SQL, XSS, command, SSRF)',
            'Data exposure and secrets detection',
            'Cryptographic misuse',
        ],
    },
    categoryPrompt: buildCategoryReviewPrompt('security'),
    categoryLabel: 'security',
    allowedLabels: ['security'],
    supportsMixed: false,
};

function addedLines(patch) {
    const out = new Set();
    let cursor = 0;
    for (const line of String(patch || '').split('\n')) {
        const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (h) { cursor = parseInt(h[1], 10); continue; }
        if (line.startsWith('+')) { out.add(cursor); cursor++; }
        else if (!line.startsWith('-')) cursor++;
    }
    return out;
}

/** Production asks for { reasoning, suggestions: [...] } inside a fence. */
function parseSuggestions(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1] : text;
    const brace = body.match(/\{[\s\S]*\}/);
    if (!brace) return [];
    try {
        const parsed = JSON.parse(brace[0]);
        return Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    } catch { return []; }
}

async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
}

async function main() {
    applyModelEnv(MODEL);
    const { generateText } = require('ai');
    const model = buildEvalModel({}, MODEL);

    const raw = JSON.parse(fs.readFileSync(args.dataset, 'utf8'));
    const all = Array.isArray(raw) ? raw : (raw.samples || Object.values(raw).find(Array.isArray));
    const vuln = all.filter((s) => s.tranche === 'vuln').slice(0, LIMIT);

    const analyzerHit = new Set();
    for (const f of String(args.analyzers || '').split(',').filter(Boolean)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        const rows = Array.isArray(j) ? j : Object.values(j).find(Array.isArray);
        for (const r of rows) if (r.detected) analyzerHit.add(r.id);
    }

    process.stderr.write(`reviewing ${vuln.length} samples via the production prompt path (${MODEL})\n`);

    const results = await pool(vuln, CONCURRENCY, async (sample, idx) => {
        const files = (sample.files || []).map((f) => ({
            filename: f.path, patch: f.patch,
            ...(f.content ? { fileContent: f.content } : {}),
        }));

        // Production splits by token budget; one model call per batch.
        const chunks = chunkFilesByTokenBudget(files, BUDGET);
        const suggestions = [];
        let errors = 0;

        for (const [n, chunk] of chunks.entries()) {
            const input = {
                changedFiles: chunk,
                languageResultPrompt: 'en-US',
                prNumber: 1,
                prTitle: sample.summary || 'chore: update',
                prBody: '',
                // no remoteCommands → self-contained mode, the no-sandbox path
            };
            try {
                const res = await generateText({
                    model,
                    system: buildSelfContainedSystemPrompt(input, META),
                    prompt: buildSelfContainedUserPrompt(input, META),
                    maxRetries: 2,
                });
                suggestions.push(...parseSuggestions(res.text || ''));
            } catch (e) {
                errors++;
                if (n === 0) process.stderr.write(`\n  [${sample.id}] ${String(e.message || e).slice(0, 80)}\n`);
            }
        }

        const expected = new Map((sample.expected || []).map((e) => [e.path, new Set(e.lines)]));
        const addedByFile = new Map(files.map((f) => [f.filename, addedLines(f.patch)]));

        const hitsExpected = suggestions.some((s) => {
            const set = expected.get(s.relevantFile);
            if (!set) return false;
            const a = Number(s.relevantLinesStart), b = Number(s.relevantLinesEnd || s.relevantLinesStart);
            for (let l = Math.min(a, b); l <= Math.max(a, b); l++) if (set.has(l)) return true;
            return false;
        });

        process.stderr.write(`${idx + 1} `);
        return {
            id: sample.id, cwe: sample.cweLabel, language: sample.language,
            chunks: chunks.length, errors,
            llmFindings: suggestions.length,
            llmDetected: hitsExpected,
            llmFileHit: suggestions.some((s) => expected.has(s.relevantFile)),
            llmInDiff: suggestions.some((s) => addedByFile.get(s.relevantFile)?.has(Number(s.relevantLinesStart))),
            analyzerDetected: analyzerHit.has(sample.id),
        };
    });

    const n = results.length;
    const llm = results.filter((r) => r.llmDetected).length;
    const ana = results.filter((r) => r.analyzerDetected).length;
    const both = results.filter((r) => r.llmDetected && r.analyzerDetected).length;
    const anaOnly = results.filter((r) => r.analyzerDetected && !r.llmDetected).length;
    const llmOnly = results.filter((r) => r.llmDetected && !r.analyzerDetected).length;
    const failed = results.filter((r) => r.errors > 0).length;
    const pct = (x) => `${((x / n) * 100).toFixed(1)}%`;

    console.log(`\n\n=== production prompt path (${MODEL}) ===`);
    console.log(`samples: ${n}   samples with any chunk error: ${failed}`);
    console.log(`mean chunks per sample: ${(results.reduce((a, r) => a + r.chunks, 0) / n).toFixed(1)}`);
    console.log(`mean suggestions per sample: ${(results.reduce((a, r) => a + r.llmFindings, 0) / n).toFixed(2)}\n`);
    console.log(`LLM detected       : ${llm}/${n}  (${pct(llm)})`);
    console.log(`analyzers detected : ${ana}/${n}  (${pct(ana)})`);
    console.log(`  both             : ${both}`);
    console.log(`  analyzer ONLY    : ${anaOnly}`);
    console.log(`  LLM ONLY         : ${llmOnly}`);
    console.log(`  neither          : ${results.filter((r) => !r.llmDetected && !r.analyzerDetected).length}`);
    console.log(`\nLLM hit the right FILE: ${results.filter((r) => r.llmFileHit).length}/${n}`);

    const out = args.json || path.join(__dirname, 'agent-path-run.json');
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`\nper-sample: ${out}`);
}

main().catch((e) => { console.error(e); process.exit(2); });
