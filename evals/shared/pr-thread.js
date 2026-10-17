// A developer's reply in a Kody thread, run through production's conversation
// path for an organization with a connected GitHub: the thread context built by
// the use case's own functions (reply-thread.ts) from GitHub-shaped comments,
// production's local sandbox fetching the PR head from a git remote
// (pr-remote.js), the org's Kodus MCP served by production's server over
// in-memory stores (kodus-mcp.js, github-rest.js), and
// ConversationAgentProvider itself. Used by evals/conversation and
// evals/thread-actions.
//
// Require it after eval-kit's countTokens(): it loads the engine's TypeScript.
//
// A thread: `repo` every file at the PR's head; `kodyComment` { file, diffHunk,
// text, title?, label?, ruleIds? } the comment the developer answers (a Kody
// Rules finding carries `label: 'kody_rules'` and the rule's id, as production
// stores it); `otherReplies` [{ author, text }]; `reply`; `language`.
const { AsyncLocalStorage } = require('async_hooks');

const { ConversationAgentProvider } = require('../../libs/agents/infrastructure/services/agents/conversation/conversationAgent.ts');
const { readDecision } = require('../../libs/agents/infrastructure/services/agents/conversation/conversation-decision.ts');
const { LocalSandboxService } = require('../../libs/sandbox/infrastructure/providers/local-sandbox.service.ts');
const { AiSdkAgentRunner } = require('../../libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner.ts');
const { GithubService } = require('../../libs/platform/infrastructure/adapters/services/github/github.service.ts');
const { getTranslationsForLanguageByCategory, TranslationsCategory } = require('../../libs/common/utils/translations/translations.ts');
const { getOriginalKodyComment, getOthersReplies, prepareContext } = require('../../libs/platform/application/use-cases/codeManagement/reply-thread.ts');
const { PlatformType } = require('../../libs/core/domain/enums/platform-type.enum.ts');
const { writePullRequestRemote } = require('./pr-remote');
const { startGithubRest } = require('./github-rest');

const OWNER = 'acme';
const REPOSITORY = { id: '41000001', name: 'service', fullName: `${OWNER}/service` };

// The run state of each thread, to read the decision the agent declared (the
// provider returns only the reply text) and the prompt it was given. Observed,
// not changed.
const runs = new AsyncLocalStorage();
const runOriginal = AiSdkAgentRunner.prototype.run;
AiSdkAgentRunner.prototype.run = async function observedRun(spec, input, ...rest) {
    const state = await runOriginal.call(this, spec, input, ...rest);
    runs.getStore()?.push({ state, prompt: input?.prompt, mcp: Boolean(spec.tools.get('KODUS_FIND_MEMORIES')) });
    return state;
};

// One organization per thread, so the stores answer per thread as production's do.
const orgOf = (i) => ({
    organizationId: `00000000-0000-4000-8000-${(0xe7a10000 + i).toString(16).padStart(12, '0')}`,
    teamId: `00000000-0000-4000-8000-${(0xe7a20000 + i).toString(16).padStart(12, '0')}`,
});

// The thread as GitHub returns it, and the context the use case builds from it.
// Kody's comment carries the body GitHub's adapter posts for a finding
// (formatBodyForGitHub, run on the case's finding as production gives it); the
// developer's reply, and any other humans', are comments pointing at it.
const github = Object.create(GithubService.prototype);
function threadContext(t, suggestionId) {
    const label = t.kodyComment.label || 'bug';
    const finding = { oneSentenceSummary: t.kodyComment.title || '', label, severity: 'high', language: 'typescript' };
    const translations = getTranslationsForLanguageByCategory(t.language, TranslationsCategory.ReviewComment);
    const body = github.formatBodyForGitHub(
        { suggestion: finding, body: { suggestionContent: t.kodyComment.text }, path: t.kodyComment.file, start_line: 1, line: 1 },
        REPOSITORY,
        translations,
        false,
    );
    const at = (n) => new Date(Date.UTC(2026, 9, 16, 10, n)).toISOString();
    const comments = [
        { id: 1, body, path: t.kodyComment.file, diff_hunk: t.kodyComment.diffHunk, user: { login: 'kody-ai[bot]', type: 'Bot' }, created_at: at(0) },
        ...(t.otherReplies || []).map((r, i) => ({ id: 10 + i, body: r.text, path: t.kodyComment.file, in_reply_to_id: 1, user: { login: r.author, type: 'User' }, created_at: at(1 + i) })),
        { id: 99, body: t.reply, path: t.kodyComment.file, in_reply_to_id: 1, user: { login: 'dev', type: 'User' }, created_at: at(9) },
    ];
    const reply = comments[comments.length - 1];
    return prepareContext({
        comment: reply,
        originalKodyComment: getOriginalKodyComment(reply, comments, PlatformType.GITHUB),
        originalSuggestion: { suggestionId, label, brokenKodyRulesIds: t.kodyComment.ruleIds || [] },
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
const pullRequestRecord = (t, pr, suggestionId) => ({
    number: pr.number,
    title: pr.message,
    status: 'open',
    repository: { ...REPOSITORY, language: 'TypeScript' },
    user: { id: 1, username: 'dev' },
    files: [
        {
            path: t.kodyComment.file,
            filename: t.kodyComment.file,
            suggestions: [{ id: suggestionId, label: t.kodyComment.label || 'bug', severity: 'high', relevantFile: t.kodyComment.file, deliveryStatus: 'sent', comment: { id: 1 }, brokenKodyRulesIds: t.kodyComment.ruleIds || [] }],
        },
    ],
    prLevelSuggestions: [],
});

/**
 * Runs one thread as organization `index` of `kodus` (startKodusMcp), with the
 * org's existing Kody Rules and memories in `rules`. Returns the reply, the
 * decision the agent declared, the prompt it got and what it wrote. Throws when
 * the agent ran without the Kodus MCP tools: that is not a run of production.
 */
async function runThread(t, { index, kodus, id = `t${index}`, rules = [] }) {
    const org = orgOf(index);
    const suggestionId = `s-${id}`;
    const pr = writePullRequestRemote({ files: t.repo, changed: [t.kodyComment.file] });
    let githubRest;
    let sandbox;
    try {
        githubRest = await startGithubRest({ pr, owner: OWNER, repository: REPOSITORY });
        kodus.addOrganization({ organizationAndTeamData: org, language: t.language, github: { host: githubRest.host, owner: OWNER }, repository: REPOSITORY, pullRequest: pullRequestRecord(t, pr, suggestionId), rules });
        // The clone params the chat use case builds (buildSandboxCloneParams),
        // with the PR's remote as the clone URL and no token.
        sandbox = await new LocalSandboxService(undefined).createSandboxWithRepo({ cloneUrl: pr.remote, branch: pr.head, baseBranch: pr.base, prNumber: pr.number, platform: PlatformType.GITHUB });
        const agent = new ConversationAgentProvider(kodus.parametersService, kodus.permissionValidationService, kodus.mcpManagerService);
        const seen = [];
        const reply = await runs.run(seen, () => agent.execute(t.reply, { organizationAndTeamData: org, prepareContext: threadContext(t, suggestionId), thread: { id: `eval-${id}` }, sandbox }));
        if (!String(reply || '').trim()) throw new Error('the agent returned no reply');
        // The agent proceeds without MCP when it cannot connect.
        if (!seen.length || !seen.every((r) => r.mcp)) throw new Error('the agent ran without the Kodus MCP tools');
        return {
            reply: String(reply),
            decision: readDecision(seen[seen.length - 1].state.steps),
            prompt: seen[0].prompt,
            written: kodus.writtenBy(org.organizationId),
            org,
        };
    } finally {
        await sandbox?.cleanup();
        await githubRest?.close();
        pr.cleanup();
    }
}

module.exports = { runThread, orgOf, OWNER, REPOSITORY };
