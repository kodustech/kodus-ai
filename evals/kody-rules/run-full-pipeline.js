// FULL-PIPELINE runner: drives the REAL KodyRulesAgentProvider.execute() —
// structured-output call (runStructuredReviewCall + wire schema) + mapAgentFindings
// (ruleUuid reconciliation, @@PATH_MISMATCH@@ drop, suggestionContent filter,
// verify) — i.e. BOTH phases, identical to prod. Contrast with
// run-convention-cases.js, which drives only the raw judge (phase 1).
//
//   node evals/kody-rules/run-full-pipeline.js --model=glm-5.2 \
//     --base-url=https://code.verboo.ai/router/v1 --dataset=rails-convention-cases-all
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
if (process.env.HOME) dotenv.config({ path: path.join(process.env.HOME, '.kodus-dev/config'), override: true });
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true];
}));
const MODELKEY = args.model || 'glm-5.2';
const LINE_TOL = 2;
const DATASET = String(args.dataset || 'rails-convention-cases-all').replace(/\.json$/, '');
const cases = require(`./${DATASET}.json`).filter((c) => !args.only || c.caseId.includes(args.only));
const normalizePath = (p) => String(p || '').replace(/^\/+/, '').replace(/\\/g, '/').replace(/\/+/g, '/');
const near = (a, b) => a.file === b.file && Math.abs(a.line - b.line) <= LINE_TOL;

const TOK = { in: 0, out: 0 };
// --byok: route the WHOLE pipeline (judge + verify + fallback) through the same
// model, faithful to a BYOK customer. Without it, verify falls back to the
// managed Groq model (contaminates the measurement). apiKey must be ENCRYPTED
// (byok-to-vercel.ts:392 decrypts it), so we encrypt the plaintext key that
// applyModelEnv resolved into API_OPEN_AI_API_KEY.
function buildByokConfig() {
    if (!args.byok) return null;
    const { encrypt } = require(path.join(__dirname, '../../libs/common/utils/crypto.ts'));
    const plain = process.env.API_OPEN_AI_API_KEY;
    if (!plain) throw new Error('--byok: no resolved key in API_OPEN_AI_API_KEY (applyModelEnv should have set it)');
    const node = {
        provider: 'openai_compatible',
        apiKey: encrypt(plain),
        model: MODELKEY,
        baseURL: args['base-url'] || '',
        maxConcurrentRequests: 2,   // respect verboo's 2-concurrent cap
    };
    return { main: node, fallback: node };
}
function buildProvider(byokConfig) {
    const { KodyRulesAgentProvider } = require(path.join(__dirname, '../../libs/code-review/infrastructure/agents/providers/kody-rules-agent.provider.ts'));
    const permissionValidationService = { getBYOKConfig: async () => byokConfig };
    const observabilityService = {
        runInSpan: async (_n, fn) => (typeof fn === 'function' ? fn() : undefined),
        runLLMInSpan: async (arg) => (arg && typeof arg.exec === 'function' ? arg.exec([]) : undefined),
        runAiSdkLLMInSpan: async (arg) => (arg && typeof arg.exec === 'function' ? arg.exec([]) : undefined),
        startSpan: () => ({ end() {}, update() {} }),
        logTokenUsage: async () => {},
        recordAgentRunUsage: async (p) => { const u = (p && p.usage) || {}; TOK.in += u.inputTokens ?? 0; TOK.out += u.outputTokens ?? 0; },
    };
    return new KodyRulesAgentProvider({}, permissionValidationService, observabilityService);
}

// no-op tools: the sharded judge reads only the diff; T2 @-refs (none here) would
// use read — return empty so nothing crashes.
const remoteCommands = {
    read: async () => '', grep: async () => 'No matches found.', listDir: async () => '',
};

async function main() {
    const { applyModelEnv } = require('../shared/tier0-models');
    applyModelEnv(MODELKEY);
    if (args['base-url']) process.env.API_OPENAI_FORCE_BASE_URL = args['base-url'];
    const byokConfig = buildByokConfig();
    console.log(`byok mode: ${byokConfig ? 'ON (whole pipeline on ' + MODELKEY + ')' : 'OFF (verify falls back to managed Groq)'}`);
    const provider = buildProvider(byokConfig);

    // --summary: exercise the PRODUCTIZED KodyRuleSummaryService (the same
    // generate/hash-guard/swap the agent-review stage runs) instead of the
    // dataset-level preprocessing. Summaries persist to a local JSON cache via
    // the repository stub — generated once, reused across reps/models, exactly
    // like prod. Delete .summary-cache.json to force regeneration.
    let prepareRules = async (rules) => rules;
    if (args.summary) {
        const { KodyRuleSummaryService } = require(path.join(__dirname, '../../libs/kodyRules/infrastructure/adapters/services/kody-rule-summary.service.ts'));
        const cachePath = path.join(__dirname, '.summary-cache.json');
        const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
        const repoStub = {
            findByOrganizationId: async () => ({ uuid: 'eval-doc' }),
            updateRule: async (_doc, ruleUuid, data) => {
                cache[ruleUuid] = data.summary;
                fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
                return { uuid: 'eval-doc' };
            },
        };
        // Trial + no BYOK → generation runs on the env-selected model (the
        // same one under eval), mirroring the managed-default path.
        const permStub = { getBYOKConfig: async () => null, getSubscriptionStatus: async () => 'trial' };
        const obsStub = { runAiSdkLLMInSpan: async ({ exec }) => exec() };
        const summaryService = new KodyRuleSummaryService(permStub, repoStub, obsStub);
        prepareRules = async (rules) => {
            const seeded = rules.map((r) => (cache[r.uuid] ? { ...r, summary: cache[r.uuid] } : r));
            const ensured = await summaryService.ensureSummaries(seeded, { organizationId: 'eval-org', teamId: 'eval-team' });
            const resolved = ensured.map((r) => summaryService.resolveForReview(r));
            const swapped = resolved.filter((r, i) => r.rule !== ensured[i].rule).length;
            console.log(`  summary service: ${swapped}/${rules.length} rules swapped for summaries`);
            return resolved;
        };
    }

    let occT = 0, occC = 0, fileT = 0, fileC = 0;
    for (const c of cases) {
        let out;
        try {
            const rulesForRun = await prepareRules(
                c.rules.map((r) => ({ ...r, type: 'standard', status: 'active', scope: r.scope || 'file' })),
            );
            out = await provider.execute({
                organizationAndTeamData: { organizationId: 'eval-org', teamId: 'eval-team' },
                changedFiles: c.realChangedFiles.map((f) => ({ filename: f.filename, patchWithLinesStr: f.patchWithLinesStr, patch: f.patchWithLinesStr })),
                remoteCommands, prNumber: 1, repositoryId: 'eval-repo', repositoryFullName: 'eval/repo',
                baseBranch: 'main', reviewMode: 'normal', maxSteps: c.maxSteps || 20,
                prTitle: c.title, prBody: c.body,
                kodyRules: rulesForRun,
            });
        } catch (e) { console.error(`  [${c.caseId}] execute threw: ${String(e.message).slice(0, 200)}`); continue; }
        const sugg = out.suggestions || [];
        // --dump=<path>: append this run's raw flags to a JSONL file so an
        // ensemble/double-sampling merge can union findings across runs.
        if (args.dump) {
            fs.appendFileSync(args.dump, JSON.stringify({
                model: MODELKEY, caseId: c.caseId,
                flags: sugg.map((s) => ({ file: s.relevantFile, line: s.relevantLinesStart, uuids: s.brokenKodyRulesIds || (s.ruleUuid ? [s.ruleUuid] : []) })),
            }) + '\n');
        }
        // PR-scope suggestions carry no relevantFile/line by design — report
        // them by rule citation (the occ scoring below can't see them).
        const prScopeUuids = new Set(c.rules.filter((r) => r.scope === 'pull-request').map((r) => r.uuid));
        const prCited = [...new Set(sugg.flatMap((s) => s.brokenKodyRulesIds || (s.ruleUuid ? [s.ruleUuid] : [])).filter((u) => prScopeUuids.has(u)))];
        if (prScopeUuids.size) console.log(`  PR-scope rules: ${prScopeUuids.size} in set → cited in suggestions: ${prCited.length ? prCited.join(', ') : 'NONE'}`);
        const flags = sugg.map((s) => ({ file: normalizePath(s.relevantFile), line: s.relevantLinesStart, uuids: s.brokenKodyRulesIds || (s.ruleUuid ? [s.ruleUuid] : []) }))
            .filter((x) => x.file && Number.isFinite(x.line));

        const changed = c.realChangedFiles.map((f) => normalizePath(f.filename));
        let occTot = 0, occCau = 0, fTot = 0, fCau = 0;
        for (const [uuid, files] of Object.entries(c.groundTruthAll)) {
            const sites = Object.entries(files).flatMap(([fn, hits]) => hits.map((h) => ({ file: normalizePath(fn), line: h.line })));
            const violFiles = Object.keys(files).map(normalizePath);
            const ruleFlags = flags.filter((x) => x.uuids.includes(uuid));
            const flaggedFiles = new Set(ruleFlags.map((x) => x.file));
            occTot += sites.length; occCau += sites.filter((g) => ruleFlags.some((x) => near(x, g))).length;
            fTot += violFiles.length; fCau += violFiles.filter((f) => flaggedFiles.has(f)).length;
        }
        occT += occTot; occC += occCau; fileT += fTot; fileC += fCau;
        const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) : '—');
        console.log(`${c.caseId.padEnd(42)} files=${c.realChangedFiles.length}  final-suggestions=${sugg.length}  OCC ${pct(occCau, occTot)}% (${occCau}/${occTot})  FILE ${pct(fCau, fTot)}% (${fCau}/${fTot})`);
    }
    const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) : '—');
    console.log(`\n════ FULL PIPELINE (execute) — ${MODELKEY} ════`);
    console.log(`OCCURRENCE recall ${pct(occC, occT)}% (${occC}/${occT}) · FILE recall ${pct(fileC, fileT)}% (${fileC}/${fileT}) · tokens in=${TOK.in} out=${TOK.out}`);
}
main().catch((e) => { console.error(e); process.exit(2); });
