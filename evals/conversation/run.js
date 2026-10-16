#!/usr/bin/env node
// conversation: a developer answers a Kody comment in a PR thread, and the
// conversation agent (ConversationAgentProvider, the class production runs)
// replies. Checks the reply against what the code says (cases.js), through the
// judge asking whether the reply asserts it (assertsClaim,
// evals/investigation/recall-judge.js), that Kody acted on nothing nobody asked
// for (no `act` decision, nothing written to the org's stores), and its
// language.
//
//   node evals/conversation/run.js [--model=<id>] [--gate] [--output=<result.json>] [--limit=N] [--concurrency=N] [--show]
//
// --show  prints each reply, to read what the judge read; --show=prompt also the prompt
//
// Each case runs as its own organization with a connected GitHub, as
// production wires one (evals/shared/kodus-mcp.js): no BYOK config (its slot is
// the eval's model), its team's language, and the Kodus MCP connection the
// mcp-manager gives it, served in this process by production's MCP server over
// in-memory stores and the PR's GitHub (evals/shared/github-rest.js). The
// sandbox is production's local one, fetched from a git remote that carries
// the base branch and the PR head (evals/shared/pr-remote.js). The agent's
// tools are what production gives it: the Kodus MCP tools, the sandbox's, and
// the decision tool.
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/AGENTS.md).
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { applyModelEnv } = require('../shared/tier0-models');
const { countTokens, tokensUsed } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { languageOf } = require('../format/checks');
const { assertsClaim, loadJudgeKey, JUDGE_MODEL } = require('../investigation/recall-judge');
const { writePullRequestRemote } = require('../shared/pr-remote');
const { startGithubRest } = require('../shared/github-rest');
const { startKodusMcp } = require('../shared/kodus-mcp');
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
const { LocalSandboxService } = require('../../libs/sandbox/infrastructure/providers/local-sandbox.service.ts');
const { AiSdkAgentRunner } = require('../../libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner.ts');

// The run state of each case, to read the decision the agent declared (the
// provider returns only the reply text), and the prompt it was given. Observed,
// not changed.
const runs = new AsyncLocalStorage();
const runOriginal = AiSdkAgentRunner.prototype.run;
AiSdkAgentRunner.prototype.run = async function observedRun(spec, input, ...rest) {
    const state = await runOriginal.call(this, spec, input, ...rest);
    runs.getStore()?.push({ state, prompt: input?.prompt, mcp: Boolean(spec.tools.get('KODUS_FIND_MEMORIES')) });
    return state;
};

// One organization per case, so the stores answer per case as production's do.
const orgOf = (i) => ({
    organizationId: `00000000-0000-4000-8000-${(0xe7a10000 + i).toString(16).padStart(12, '0')}`,
    teamId: `00000000-0000-4000-8000-${(0xe7a20000 + i).toString(16).padStart(12, '0')}`,
});

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
const OWNER = 'acme';
const REPOSITORY = { id: '41000001', name: 'service', fullName: `${OWNER}/service` };

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

// The pull request as Kodus stored it after the review: the comment Kody
// posted is a sent suggestion on the file.
const pullRequestRecord = (c, pr) => ({
    number: pr.number,
    title: pr.message,
    status: 'open',
    repository: { ...REPOSITORY, language: 'TypeScript' },
    user: { id: 1, username: 'dev' },
    files: [{ path: c.kodyComment.file, filename: c.kodyComment.file, suggestions: [{ id: `s-${c.id}`, label: 'bug', severity: 'high', relevantFile: c.kodyComment.file, deliveryStatus: 'sent', comment: { id: 1 } }] }],
    prLevelSuggestions: [],
});

async function runCase(c, i, judgeKey, kodus) {
    const org = orgOf(i);
    const pr = writePullRequestRemote({ files: c.repo, changed: [c.kodyComment.file] });
    const github = await startGithubRest({ pr, owner: OWNER, repository: REPOSITORY });
    let sandbox;
    try {
        kodus.addOrganization({ organizationAndTeamData: org, language: c.language, github: { host: github.host, owner: OWNER }, repository: REPOSITORY, pullRequest: pullRequestRecord(c, pr) });
        // The clone params the chat use case builds (buildSandboxCloneParams),
        // with the PR's remote as the clone URL and no token.
        sandbox = await new LocalSandboxService(undefined).createSandboxWithRepo({ cloneUrl: pr.remote, branch: pr.head, baseBranch: pr.base, prNumber: pr.number, platform: PlatformType.GITHUB });
        const agent = new ConversationAgentProvider(kodus.parametersService, kodus.permissionValidationService, kodus.mcpManagerService);
        const seen = [];
        const reply = await runs.run(seen, () => agent.execute(c.reply, { organizationAndTeamData: org, prepareContext: threadContext(c), thread: { id: `eval-${c.id}` }, sandbox }));
        if (!String(reply || '').trim()) throw new Error('the agent returned no reply');
        // The agent proceeds without MCP when it cannot connect: that is not
        // the run this eval measures.
        if (!seen.length || !seen.every((r) => r.mcp)) throw new Error('the agent ran without the Kodus MCP tools');
        if (args.show === 'prompt') console.log(`\n── ${c.id} prompt\n${seen[0].prompt}\n`);
        if (args.show) console.log(`\n── ${c.id} — ${c.reply}\n${reply}\n`);
        const decision = readDecision(seen[seen.length - 1].state.steps);
        const written = kodus.writtenBy(org.organizationId);
        const writes = written.rules.length + written.issues.length;
        const right = await assertsClaim(judgeKey, c.golden, reply);
        const want = c.language === 'pt-BR' ? 'pt' : 'en';
        const lang = languageOf(reply);
        const detail = [
            { what: `says: ${c.golden.slice(0, 120)}${right ? '' : ` — replied: ${String(reply).replace(/\s+/g, ' ').slice(0, 160)}`}`, ok: right },
            { what: `acts on nothing nobody asked for (intent: ${decision?.intent ?? 'none'}, writes: ${writes})`, ok: decision?.intent !== 'act' && writes === 0 },
            { what: `replies in ${c.language} (read as ${lang})`, ok: ['unknown', want].includes(lang) },
        ];
        // The whole reply, for whoever reads the verdict after the judge.
        return { hits: detail.filter((d) => d.ok).length, total: detail.length, detail, reply: String(reply).slice(0, 4000) };
    } finally {
        await sandbox?.cleanup();
        await github.close();
        pr.cleanup();
    }
}

async function main() {
    const judgeKey = loadJudgeKey();
    if (!judgeKey) {
        console.error(`not measured: no key for the judge (${JUDGE_MODEL}); set JUDGE_API_KEY`);
        return 2;
    }
    const kodus = await startKodusMcp();
    const results = new Array(cases.length);
    let errored = 0;
    let next = 0;
    const worker = async () => {
        while (next < cases.length) {
            const i = next++;
            const c = cases[i];
            try {
                results[i] = { id: c.id, checks: c.checks, ...(await runCase(c, i, judgeKey, kodus)) };
            } catch (error) {
                errored += 1;
                console.error(`  ${c.id}: ${String(error.message || error).slice(0, 200)}`);
                results[i] = { id: c.id, checks: c.checks, hits: 0, total: 0, unmeasured: true };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency) || 4) }, worker));
    await kodus.close();

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
