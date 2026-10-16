#!/usr/bin/env node
// conversation: a developer answers a Kody comment in a PR thread, and the
// conversation agent (ConversationAgentProvider, the class production runs)
// replies with the PR's head in a local sandbox. Checks the reply against what
// the code says (cases.js), through the judge asking whether the reply asserts
// it (assertsClaim, evals/investigation/recall-judge.js), and that Kody did not
// declare an action nobody asked for.
//
//   node evals/conversation/run.js [--model=<id>] [--gate] [--output=<result.json>] [--limit=N] [--concurrency=N] [--show]
//
// --show  prints each reply, to read what the judge read
//
// The agent runs as an org with no BYOK config and no MCP servers: its slot is
// the eval's model, and its tools are the sandbox's (grep, read, listDir, exec)
// and the decision tool. Writes (memories, rules) need MCP, so this eval does
// not cover them.
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/AGENTS.md).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { execFileSync } = require('child_process');
const { applyModelEnv } = require('../shared/tier0-models');
const { countTokens, tokensUsed } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { languageOf } = require('../format/checks');
const { assertsClaim, loadJudgeKey, JUDGE_MODEL } = require('../investigation/recall-judge');
const { CASES } = require('./cases');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const MODEL = args.model || 'deepseek-v4-flash@fireworks';
const TARGET = (require('./targets.json').models || {})[MODEL] || {};
const cases = CASES.slice(0, args.limit ? Number(args.limit) : undefined);

// libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
applyModelEnv(MODEL);
countTokens();
const { ConversationAgentProvider } = require('../../libs/agents/infrastructure/services/agents/conversation/conversationAgent.ts');
const { readDecision } = require('../../libs/agents/infrastructure/services/agents/conversation/conversation-decision.ts');
const { PermissionValidationService } = require('../../libs/ee/shared/services/permissionValidation.service.ts');
const { ParametersService } = require('../../libs/organization/infrastructure/adapters/services/parameters.service.ts');
const { LocalSandboxService, sandboxEnv } = require('../../libs/sandbox/infrastructure/providers/local-sandbox.service.ts');
const { AiSdkAgentRunner } = require('../../libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner.ts');

// The run state of each case, to read the decision the agent declared: the
// provider returns only the reply text. Observed, not changed.
const runs = new AsyncLocalStorage();
const runOriginal = AiSdkAgentRunner.prototype.run;
AiSdkAgentRunner.prototype.run = async function observedRun(...a) {
    const state = await runOriginal.apply(this, a);
    runs.getStore()?.push(state);
    return state;
};

// The org: no stored BYOK config (production's PermissionValidationService
// routes the conversation task to the env/managed model), its language from
// language_config, no MCP.
const { EVAL_ORG: ORG, evalPermissionService } = require('../shared/org-route');

// The PR's head as a git checkout, like the production sandbox's clone.
function writeRepo(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-conversation-'));
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), content);
    }
    // sandboxEnv drops GIT_DIR and the other variables that outrank -C: run from
    // a git hook, git would otherwise work on the caller's repository.
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', env: sandboxEnv({ GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' }) });
    git('init', '-q', '-b', 'feature');
    git('add', '-A');
    git('commit', '-q', '-m', 'head of the pull request');
    return dir;
}

// The thread as GitHub returns it, and the context the use case builds from it
// (reply-thread.ts: getOriginalKodyComment, getOthersReplies, prepareContext).
// Kody's comment carries the body GitHub's adapter posts for a finding
// (formatBodyForGitHub, run on the case's finding as production gives it); the
// developer's reply, and any other humans', are comments pointing at it.
const { GithubService } = require('../../libs/platform/infrastructure/adapters/services/github/github.service.ts');
const { getTranslationsForLanguageByCategory, TranslationsCategory } = require('../../libs/common/utils/translations/translations.ts');
const { getOriginalKodyComment, getOthersReplies, prepareContext } = require('../../libs/platform/application/use-cases/codeManagement/reply-thread.ts');
const { PlatformType } = require('../../libs/core/domain/enums/platform-type.enum.ts');
const github = Object.create(GithubService.prototype);
const REPOSITORY = { id: 'repo-1', name: 'service', fullName: 'acme/service' };

function threadContext(c) {
    const finding = { oneSentenceSummary: c.kodyComment.title || '', label: 'bug', severity: 'high', language: 'typescript' };
    const translations = getTranslationsForLanguageByCategory(c.language, TranslationsCategory.ReviewComment);
    const body = github.formatBodyForGitHub(
        { suggestion: finding, body: { suggestionContent: c.kodyComment.text }, path: c.kodyComment.file, start_line: 1, line: 1 },
        REPOSITORY,
        translations,
        false,
    );
    const at = (n) => new Date(Date.UTC(2026, 9, 16, 10, n)).toISOString();
    const comments = [
        { id: 1, body, path: c.kodyComment.file, diff_hunk: c.kodyComment.diffHunk, user: { login: 'kody-ai[bot]', type: 'Bot' }, created_at: at(0) },
        ...(c.otherReplies || []).map((r, i) => ({ id: 10 + i, body: r.text, path: c.kodyComment.file, in_reply_to_id: 1, user: { login: r.author, type: 'User' }, created_at: at(1 + i) })),
        { id: 99, body: c.reply, path: c.kodyComment.file, in_reply_to_id: 1, user: { login: 'dev', type: 'User' }, created_at: at(9) },
    ];
    const reply = comments[comments.length - 1];
    return prepareContext({
        comment: reply,
        originalKodyComment: getOriginalKodyComment(reply, comments, PlatformType.GITHUB),
        originalSuggestion: { suggestionId: `s-${c.id}`, label: 'bug', brokenKodyRulesIds: [] },
        gitUser: { id: 1, username: 'dev' },
        othersReplies: getOthersReplies(reply, comments, PlatformType.GITHUB),
        pullRequestNumber: 7,
        repository: REPOSITORY,
        pullRequestDescription: '',
        platformType: PlatformType.GITHUB,
        headRef: 'feature',
        baseRef: 'main',
        defaultBranch: 'main',
    });
}

async function runCase(c, judgeKey) {
    const dir = writeRepo(c.repo);
    const sandbox = {
        remoteCommands: new LocalSandboxService(undefined).buildRemoteCommands(dir),
        cleanup: async () => fs.rmSync(dir, { recursive: true, force: true }),
        type: 'local',
        sandboxId: `eval-${c.id}`,
        repoDir: dir,
        baseBranch: 'main',
    };
    // The production parameters service over a repository that holds the
    // team's language_config: the service's own lookup runs, only the storage
    // is in memory.
    const parametersRepository = { findByKey: async (key) => (key === 'language_config' ? { configKey: key, configValue: c.language, active: true } : null) };
    const agent = new ConversationAgentProvider(new ParametersService(parametersRepository), evalPermissionService(null));
    const states = [];
    try {
        const reply = await runs.run(states, () => agent.execute(c.reply, { organizationAndTeamData: ORG, prepareContext: threadContext(c), thread: { id: `eval-${c.id}` }, sandbox }));
        if (!String(reply || '').trim()) throw new Error('the agent returned no reply');
        if (args.show) console.log(`\n── ${c.id} — ${c.reply}\n${reply}\n`);
        const decision = states.length ? readDecision(states[states.length - 1].steps) : undefined;
        const right = await assertsClaim(judgeKey, c.golden, reply);
        const want = c.language === 'pt-BR' ? 'pt' : 'en';
        const lang = languageOf(reply);
        const detail = [
            { what: `says: ${c.golden.slice(0, 120)}${right ? '' : ` — replied: ${String(reply).replace(/\s+/g, ' ').slice(0, 160)}`}`, ok: right },
            { what: `declares no action nobody asked for (intent: ${decision?.intent ?? 'none'})`, ok: decision?.intent !== 'act' },
            { what: `replies in ${c.language} (read as ${lang})`, ok: ['unknown', want].includes(lang) },
        ];
        // The whole reply, for whoever reads the verdict after the judge.
        return { hits: detail.filter((d) => d.ok).length, total: detail.length, detail, reply: String(reply).slice(0, 4000) };
    } finally {
        await sandbox.cleanup();
    }
}

async function main() {
    const judgeKey = loadJudgeKey();
    if (!judgeKey) {
        console.error(`not measured: no key for the judge (${JUDGE_MODEL}); set JUDGE_API_KEY`);
        return 2;
    }
    const results = new Array(cases.length);
    let errored = 0;
    let next = 0;
    const worker = async () => {
        while (next < cases.length) {
            const i = next++;
            const c = cases[i];
            try {
                results[i] = { id: c.id, checks: c.checks, ...(await runCase(c, judgeKey)) };
            } catch (error) {
                errored += 1;
                console.error(`  ${c.id}: ${String(error.message || error).slice(0, 200)}`);
                results[i] = { id: c.id, checks: c.checks, hits: 0, total: 0, unmeasured: true };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency) || 4) }, worker));

    const hits = results.reduce((n, r) => n + r.hits, 0);
    const total = results.reduce((n, r) => n + r.total, 0);
    const result = {
        eval: 'conversation',
        question: evalQuestion('evals/conversation'),
        model: MODEL,
        judge: JUDGE_MODEL,
        runs: 1,
        metric: { name: 'of reply checks right', value: total ? hits / total : null, floor: TARGET.floor ?? null, baseline: TARGET.observed ?? null },
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: cases.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    for (const r of results) {
        const failed = (r.detail || []).filter((d) => !d.ok);
        console.log(`  ${r.unmeasured ? 'N/A ' : failed.length ? 'MISS' : 'ok  '} ${r.id}${failed.length ? `: ${failed.map((d) => d.what).join(' · ')}` : ''}`);
    }
    console.log(`conversation: ${hits}/${total} reply checks right (judge ${JUDGE_MODEL}) · ${errored} of ${cases.length} cases did not measure`);
    if (errored > cases.length * 0.05) {
        console.error(`not measured: ${errored} of ${cases.length} cases failed to run (see above)`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape — ${problems.join('; ')}`);
        return 2;
    }
    if (args.gate && result.metric.floor === null) {
        console.error(`not measured: no floor for ${MODEL} in evals/conversation/targets.json, so --gate cannot judge it`);
        return 2;
    }
    if (args.gate && result.metric.value < result.metric.floor) {
        console.error(`GATE FAILED: ${(result.metric.value * 100).toFixed(1)}% below the floor in evals/conversation/targets.json`);
        return 1;
    }
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(2);
    });
