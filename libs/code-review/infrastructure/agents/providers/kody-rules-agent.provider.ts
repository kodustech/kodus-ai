import { Injectable, Optional } from '@nestjs/common';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { createLogger } from '@libs/core/log/logger';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';
import { fileMatchesRulePath } from '@libs/common/utils/kody-rules/file-patterns';
import { runStructuredReviewCall } from '@libs/llm/structured-review-call';
import { LLM_TASK } from '@libs/llm/byok-config';
import { BaseCodeReviewAgentProvider } from '@libs/code-review/infrastructure/agents/providers/base-code-review-agent.provider';
import { resolveReviewAgentModel } from '@libs/code-review/infrastructure/agents/collaborators/model-factory';
import { mapAgentFindings } from '@libs/code-review/infrastructure/agents/collaborators/finding-mapper';
import { runAgentWithTrace } from '@libs/code-review/infrastructure/agents/collaborators/review-observability';
import {
    judgeKodyRulesSharded,
    inlineRuleReferences,
    inlineLoadedReferences,
    findUnresolvedReferenceRules,
    shardViolationsWireSchema,
    type RunJudge,
    type RawShardViolation,
    type ShardViolation,
} from '@libs/code-review/infrastructure/agents/collaborators/kody-rules-sharded.judge';
import { ExternalReferenceLoaderService } from '@libs/kodyRules/infrastructure/adapters/services/externalReferenceLoader.service';
import { buildDetectorViolations } from '@libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler';
import {
    ReviewAgentIdentity,
    ReviewAgentInput,
    ReviewAgentOutput,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';
import {
    IKodyRule,
    KodyRulesScope,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * Agent that validates code changes against Kody Rules (team-defined rules).
 *
 * Unlike the bug/security/performance agents that look for general issues,
 * this agent focuses exclusively on checking whether changed code violates
 * the team's custom rules (scope: FILE and PULL_REQUEST, type: STANDARD).
 *
 * Memory rules (type: MEMORY) are handled by the other agents via their
 * system prompts — this agent only handles formal STANDARD rules.
 */
@Injectable()
export class KodyRulesAgentProvider extends BaseCodeReviewAgentProvider {
    private readonly shardLogger = createLogger('KodyRulesShardedAgent');

    constructor(
        permissionValidationService: PermissionValidationService,
        observabilityService: ObservabilityService,
        @Optional()
        documentationSearchService?: DocumentationSearchExaService,
        @Optional()
        byokErrorCounter?: ByokErrorCounter,
        // Resolves each rule's `@file:` citations from the Context OS
        // (contextReferenceId). @Optional so unit tests can `new` the provider
        // without it — absent = external refs simply aren't inlined.
        @Optional()
        private readonly externalReferenceLoaderService?: ExternalReferenceLoaderService,
    ) {
        super(
            permissionValidationService,
            observabilityService,
            documentationSearchService,
            byokErrorCounter,
        );
    }

    protected getIdentity(): ReviewAgentIdentity {
        return {
            name: 'kodus-rules-review-agent',
            description:
                'Code review agent specialized in validating code changes against ' +
                'team-defined rules and conventions. Investigates code to check ' +
                'compliance with each rule before reporting violations.',
            goal:
                'Check every applicable rule against the changed code. ' +
                'Only report violations you confirmed with evidence from the code.',
            expertise: [
                'Custom team rule validation',
                'Convention compliance checking',
                'Path-based rule filtering',
                'Code pattern matching against examples',
            ],
        };
    }

    protected getCategoryLabel(): string {
        return 'kody_rules';
    }

    /**
     * Override execute to filter team rules and forward them to the base
     * agent. The previous implementation stashed the formatted rules on a
     * `this.currentRules` field, but since the provider is a NestJS
     * singleton that field raced across concurrent reviews — two orgs
     * hitting the same worker at once could end up validated against each
     * other's rules. Now we pre-filter the `active`/non-memory rules and
     * let the base class read them off the input object, so there is no
     * shared mutable state per request.
     */
    async execute(
        input: ReviewAgentInput & { kodyRules?: Partial<IKodyRule>[] },
    ): Promise<ReviewAgentOutput> {
        const rules = (input.kodyRules || []).filter(
            (r) => r.type !== KodyRulesType.MEMORY && r.status === 'active',
        );

        if (rules.length === 0) {
            return {
                suggestions: [],
                agentName: this.getIdentity().name,
                turnsUsed: 0,
                durationMs: 0,
            };
        }

        const formatted = this.formatKodyRules(rules, input.changedFiles);

        if (!formatted) {
            return {
                suggestions: [],
                agentName: this.getIdentity().name,
                turnsUsed: 0,
                durationMs: 0,
            };
        }

        // DETERMINISTIC SHARDED PATH (issue #1449).
        //
        // The old agentic loop (super.execute) let the LLM decide which files
        // to open within a turn budget; on large PRs it starved and never read
        // the violating file (measured: gpt-5.4 40%, kimi 58% occurrence-recall
        // on the frozen github-cases set). We replace the traversal with a
        // deterministic file×rule sweep: code iterates every changed file and
        // issues ONE single-shot judgment per file with its path-applicable
        // rules batched in, plus one whole-PR call for pull-request-scope rules.
        // Coverage is now structural (the model only judges, never decides where
        // to look). Validated at 91-100% occurrence-recall across gpt-5.4 /
        // gpt-5.4-mini / kimi at ~same-or-lower cost.
        const startTime = Date.now();

        // Route each rule by its compiled shape (issue #1449):
        //   T0 mechanical (has a `detector`) → deterministic regex over added
        //     lines, ZERO LLM (the only part that stays free under any BYOK).
        //   T1/T2 semantic (no detector) → the sharded single-shot LLM judge.
        const mechanicalRules = rules.filter((r) => r.detector);
        const semanticRules = rules.filter((r) => !r.detector);

        // T0 — run compiled detectors in code.
        const detectorViolations = buildDetectorViolations(
            mechanicalRules,
            input.changedFiles,
        );

        // T1/T2 — semantic rules via the LLM judge (skip the model entirely when
        // every applicable rule is mechanical — pure-T0 reviews cost nothing).
        let judgeViolations: ShardViolation[] = [];
        let shardsRun = 0;
        let shardsErrored = 0;
        if (semanticRules.length > 0) {
            const { byokConfig, main } = await resolveReviewAgentModel(
                input,
                this.permissionValidationService,
                // Route the Kody-Rules review agent to its own task — falls back
                // to the org's codeReview model when no override is set.
                LLM_TASK.kodyRulesReview,
            );
            this.shardLogger.log({
                message: `[AGENT] ${this.getIdentity().name} (sharded) using model: ${main.modelName} for PR#${input.prNumber} (${semanticRules.length} semantic, ${mechanicalRules.length} mechanical rules)`,
                context: this.getIdentity().name,
            });

            // Single-shot structured call on the LOCAL (Vercel) stack — no tools,
            // no loop. One model = the org's BYOK model or our
            // managed default (kimi-k2.7-code via Moonshot); there is no 2nd-model
            // fallback (removed in 04b-05), only the same-model latency guard.
            // See runStructuredReviewCall for the model policy. runAiSdkLLMInSpan
            // (inside the helper) emits the `tu`-stamped LLM-usage span so the
            // sharded path's tokens still reach the user-facing token analytics.
            const runJudge: RunJudge = async ({ system, user, filename }) => {
                const parsed = await runStructuredReviewCall({
                    byokConfig: byokConfig ?? undefined,
                    // Wire schema, NOT the zod object: zodSchema() would
                    // re-derive `required` from the zod input side and
                    // reintroduce the OpenAI-strict 400. See the
                    // shardViolationsWireSchema doc.
                    schema: shardViolationsWireSchema,
                    system,
                    user,
                    runName: 'kodus-rules-review-agent.shard',
                    organizationId:
                        input.organizationAndTeamData?.organizationId,
                    attrs: {
                        prNumber: input.prNumber,
                        agentName: this.getIdentity().name,
                        ...(filename ? { file: filename } : {}),
                    },
                    observabilityService: this.observabilityService,
                });
                return ((parsed as any)?.violations ??
                    []) as RawShardViolation[];
            };

            // T2a — inline the rule's own `sourcePath` (IDE-sync / centralized)
            // via the sandbox read so the judge sees the full convention.
            let rulesForJudge = await inlineRuleReferences(
                semanticRules,
                input.remoteCommands?.read?.bind(input.remoteCommands),
                this.shardLogger,
            );

            // T2b — inline the `@file:` citations authored in the rule BODY.
            // Current-arch rules store these as a `contextReferenceId` (Context
            // OS), NOT an inline field, and the review path reads rules raw — so
            // the sharded judge used to see the bare "@file:X" marker and judge
            // blind. Resolve them through the same loader the PR-level path uses
            // (contextReferenceId -> ContextPack -> file content, same or cross
            // repo). Best-effort: any failure degrades to the rule text alone.
            rulesForJudge = await this.inlineContextOsReferences(
                rulesForJudge,
                input,
            );

            // Open the Langfuse root observation the sharded judge runs under.
            // Every OTHER review agent runs inside runAgentWithTrace (via the
            // base provider's agentic loop); this override bypassed super.execute
            // and with it that wrapper, so the shard `generateText` spans emitted
            // detached — no named trace, no org/team/PR/session tags — and the
            // agent showed ZERO traces in Langfuse. Wrapping the judge here nests
            // every shard span under a `kodus-rules-review-agent` trace, tagged
            // like the generalist. No-op passthrough when tracing is disabled.
            const result = await runAgentWithTrace(
                {
                    traceName: this.getIdentity().name,
                    organizationId:
                        input.organizationAndTeamData?.organizationId,
                    teamId: input.organizationAndTeamData?.teamId,
                    prNumber: input.prNumber,
                    repositoryId: input.repositoryId,
                },
                // Sanitized span input: shape only, never the file patches.
                {
                    prNumber: input.prNumber,
                    semanticRules: rulesForJudge.length,
                    mechanicalRules: mechanicalRules.length,
                    changedFiles: input.changedFiles?.length ?? 0,
                },
                () =>
                    judgeKodyRulesSharded({
                        changedFiles: input.changedFiles,
                        rules: rulesForJudge,
                        runJudge,
                        prTitle: input.prTitle,
                        prBody: input.prBody,
                        logger: this.shardLogger,
                    }),
            );
            judgeViolations = result.violations;
            shardsRun = result.shardsRun;
            shardsErrored = result.shardsErrored;

            // Escalate a TOTAL shard failure. When every judge shard errored
            // (e.g. an OpenAI-strict wire-schema 400 for a BYOK org, which
            // 400s every shard identically — the #1523/#1526 regression), the
            // judge path returns zero violations and the review used to
            // complete "successfully" with only warn logs — a green review
            // that evaluated none of its semantic kody-rules. Throw so the
            // orchestrator's allSettled marks this agent PARTIAL_ERROR
            // (surfaced by execution health) instead of silently reporting a
            // healthy, rule-free review. A partial shard failure still
            // degrades to the surviving shards' findings, as before.
            // The message reaches the PR logs UI and the check text, so it
            // states what happened and what to do — the reasoning above is for
            // whoever reads this code, and the diagnostic breadcrumbs
            // (wire-schema 400 / provider outage / model unavailability) are in
            // the shard warn logs.
            if (shardsRun > 0 && shardsErrored === shardsRun) {
                throw new Error(
                    `Kody Rules could not be evaluated: all ${shardsRun} rule check(s) failed to run. Your semantic Kody Rules were not applied to this PR.`,
                );
            }

            // Surface a PARTIAL shard failure (some shards died while others
            // posted). We deliberately do NOT throw — the surviving shards'
            // findings still ship — but a silent degrade is exactly the
            // "one shard dead while the other posts" shape of the wire-schema
            // regression: the review looks healthy yet a subset of semantic
            // kody-rules were never evaluated, and today that only shows up as
            // an `, N errored` fragment in an info line (easy to miss, not
            // alertable). Emit a structured WARN with the counts so the
            // partial degrade is greppable/alertable per-execution.
            if (shardsErrored > 0 && shardsErrored < shardsRun) {
                this.shardLogger.warn({
                    message: `[kody-rules] PARTIAL judge-shard failure for PR#${input.prNumber}: ${shardsErrored}/${shardsRun} shard(s) errored — the surviving ${shardsRun - shardsErrored} shard(s) posted, but the semantic kody-rules on the failed shard(s) were NOT evaluated. Review degraded (not failed). Check the shard warn logs for the cause (wire-schema 400 / provider blip / model unavailability).`,
                    context: this.getIdentity().name,
                    metadata: {
                        prNumber: input.prNumber,
                        shardsRun,
                        shardsErrored,
                        shardsSucceeded: shardsRun - shardsErrored,
                    },
                });
            }
        }

        // Merge both streams; downstream mapping/verify/dedup are identical.
        const allViolations: ShardViolation[] = [
            ...detectorViolations,
            ...judgeViolations,
        ];

        // Reuse the shared finding→CodeSuggestion mapping (ruleUuid
        // reconciliation, path canonicalization, kody-rule severity) so verify
        // / dedup downstream behave exactly as with the agentic path.
        const mapped = mapAgentFindings(
            { findings: { suggestions: allViolations } },
            {
                changedFiles: input.changedFiles,
                kodyRules: rules,
                prNumber: input.prNumber,
                isKodyRules: true,
                identityName: this.getIdentity().name,
                labelPolicy: {
                    categoryLabel: this.getCategoryLabel(),
                    allowedLabels: this.getAllowedSuggestionLabels(input),
                    supportsMixed: this.supportsMixedLabels(),
                },
                logger: this.shardLogger,
            },
        );

        const durationMs = Date.now() - startTime;
        this.shardLogger.log({
            message: `[AGENT] ${this.getIdentity().name} (sharded) done for PR#${input.prNumber}: ${mapped.suggestions.length} suggestions (${detectorViolations.length} from ${mechanicalRules.length} detectors, ${judgeViolations.length} from ${shardsRun} shards${shardsErrored ? `, ${shardsErrored} errored` : ''}) in ${durationMs}ms`,
            context: this.getIdentity().name,
        });

        return {
            suggestions: mapped.suggestions,
            agentName: this.getIdentity().name,
            turnsUsed: shardsRun,
            durationMs,
        };
    }

    /**
     * Override to include the request's rules in the category prompt. The
     * formatted rule section is derived from `input.kodyRules` each call
     * instead of from instance state, so concurrent reviews cannot see
     * each other's rule set.
     */
    protected getCategoryPrompt(input: ReviewAgentInput): string {
        const rules = (
            (
                input as ReviewAgentInput & {
                    kodyRules?: Partial<IKodyRule>[];
                }
            ).kodyRules || []
        ).filter(
            (r) => r.type !== KodyRulesType.MEMORY && r.status === 'active',
        );
        const formatted = this.formatKodyRules(rules, input.changedFiles);

        const base = `## Focus: Team Rules & Conventions

You validate code against the team's custom rules listed below. Your ONLY job is to check these rules — do not look for general bugs, security issues, or performance problems.

### How to analyze:
1. **Read each rule carefully**: Understand what the rule requires and what path patterns it applies to.
2. **Check applicability**: Only check a rule if the changed files match its path pattern (if specified).
3. **Investigate with tools**: Use readFile/grep to verify whether the changed code complies with each rule.
4. **Use examples**: If a rule has examples, compare the changed code against them.
5. **Report violations only**: Do NOT report code that correctly follows the rules.

### What to report:
- Code that violates a specific team rule
- Include which rule was violated (by title)
- Include evidence from the code showing the violation
- **Report EVERY occurrence, not just the first.** If the same rule is violated
  on multiple lines — even within the same file — emit a SEPARATE finding for
  EACH violating line, each anchored to its own relevantLinesStart. Do NOT
  collapse repeated violations of one rule into a single finding; downstream
  dedup folds them into one comment with an "Also found in" list, so the team
  still gets one comment per rule but learns every place to fix.

### Skip:
- General bugs, security issues, performance problems (handled by other agents)
- Code that follows the rules correctly
- Rules whose path patterns don't match any changed file`;

        if (formatted) {
            return `${base}\n\n${formatted}`;
        }
        return base;
    }

    /**
     * Override user prompt: send full diffs + PR context.
     * PR-level rules need to see the full picture (e.g., "every PR must have tests").
     * File-level rules benefit from seeing the diff to understand what changed.
     */
    protected buildUserPrompt(input: ReviewAgentInput): string {
        const diffsSection =
            input.changedFiles
                ?.map((file) => {
                    const diff =
                        (file as any).patchWithLinesStr ??
                        (file as any).patch ??
                        '';
                    return `### ${file.filename}\n\`\`\`diff\n${diff}\n\`\`\``;
                })
                .join('\n\n') || 'No changed files provided.';

        const prDescription = input.prBody ? input.prBody : '';
        const prContextSection = input.prTitle
            ? `\n  <PRContext>Title: ${input.prTitle}\nDescription: ${prDescription || '(empty)'}</PRContext>`
            : '';

        // Commit list (oldest→newest) so commit-hygiene rules are judged
        // against real commit boundaries rather than inferred from the diff.
        const commits = input.commits ?? [];
        const commitsSection = commits.length
            ? `\n  <Commits>\n${commits
                  .map(
                      (c, i) =>
                          `    ${i + 1}. ${(c.sha || '').substring(0, 8)} ${
                              (c.message || '').split('\n')[0]
                          }`,
                  )
                  .join(
                      '\n',
                  )}\n    NOTE: The diff above may be an aggregate of these commits or only an incremental push (a subset). It is NOT a single commit. Use this list — not the diff or PR description — to judge commit-hygiene rules.\n  </Commits>`
            : '';

        return `<ReviewTask>${prContextSection}
  <Diffs>
${diffsSection}
  </Diffs>${commitsSection}

  <OutputFormat>
After investigating with tools, respond with ONLY a JSON block.
There are TWO formats depending on the rule scope:

**File-level rule violation** (scope: Per-file) — includes file, lines, and code:
\`\`\`json
{
  "ruleUuid": "1b2e3c4d-5678-90ab-cdef-1234567890ab",
  "relevantFile": "src/api/paginator.py",
  "language": "python",
  "suggestionContent": "Violates rule 'No console.log in production code': the function debugFoo leaves console.log calls that should have been removed before merging.",
  "existingCode": "console.log('user:', user);",
  "improvedCode": "logger.debug('user:', user);",
  "oneSentenceSummary": "Violates 'No console.log in production code'",
  "relevantLinesStart": 42,
  "relevantLinesEnd": 44
}
\`\`\`

**PR-level rule violation** (scope: Pull request level) — NO file, lines, or code:
\`\`\`json
{
  "ruleUuid": "9f8e7d6c-5432-10ba-fedc-0987654321ba",
  "suggestionContent": "Violates rule 'PRs touching the auth module require a test file': changes to src/auth/* landed without a matching src/auth/**.test.ts.",
  "oneSentenceSummary": "Violates 'PRs touching the auth module require a test file'"
}
\`\`\`

Full response structure:
\`\`\`json
{
  "reasoning": "Summary of which rules you checked and what you found",
  "suggestions": [ ...file-level and/or PR-level violations... ]
}
\`\`\`

CRITICAL — ruleUuid discipline:
- "ruleUuid" is MANDATORY on every suggestion. Copy it exactly from the "**UUID**: \`...\`" line of the Team Rules section above.
- You MUST NOT invent a UUID, leave it blank, or put a placeholder like "uuid-of-the-violated-rule".
- If you notice an issue in the code that is real but does NOT match any of the rules listed above (e.g. an XSS risk when no XSS rule was provided, or a generic bug), **DO NOT REPORT IT**. Discard it. A different agent handles bugs, security, and performance — your job is ONLY team rules compliance. Reporting something without a matching ruleUuid is an error.
- If no rule is violated, return an empty suggestions array.

Other format rules:
- For PR-level rules, do NOT include "relevantFile", "relevantLinesStart", "relevantLinesEnd", "existingCode", or "improvedCode".
- For file-level rules, ALL fields including file and lines are required.

If no violations found, respond with \`{"reasoning": "Checked all rules, no violations found", "suggestions": []}\`.
  </OutputFormat>

  <Rules>
    <Rule>Check EVERY rule against the diffs and use tools to investigate further if needed.</Rule>
    <Rule>For PR-level rules (e.g., "must have tests", "PR description requirements"), evaluate the PR as a whole — check the PR title, description, and the full list of changed files. Do NOT attach these to a specific file.</Rule>
    <Rule>For file-level rules, check the diff of each applicable file and report with file path and line numbers.</Rule>
    <Rule>If a rule has a Reference file, use readFile to read it and understand the expected pattern before checking.</Rule>
    <Rule>Only report actual violations — not code that follows the rules.</Rule>
    <Rule>Include the rule title in the suggestionContent so the team knows which rule was violated.</Rule>
    <Rule>If you spot a real issue that does NOT map to any listed rule, DROP IT. Your scope is only team rules. Other agents cover generic bugs, security, performance.</Rule>
    <Rule>Only flag lines that are present in the &lt;Diffs&gt; above. readFile/grep return the FULL file including code this PR did not touch — surrounding lines are context only. Never report a violation whose evidence (existingCode / relevantLines) lies outside the diff hunks.</Rule>
    <Rule>Commit-hygiene rules (e.g. "don't mix mechanical and behavioral changes", "separate commits and call out which are mechanical") MUST be judged against the &lt;Commits&gt; list, NOT the aggregated diff or the PR description. Seeing several commits' changes together, or an incremental push that is purely mechanical, is NOT a violation — you are just viewing more than one commit at once, or a subset. This rule is HIGH-PRECISION and targets only WHOLESALE mechanical changes — project/file-wide reformatting, mass renames, or import re-sorting — that are bundled into the SAME commit as unrelated behavioral logic. The following are NOT violations and must NOT be reported: incidental comments or docstrings, local whitespace/indentation, and formatting that is a normal part of implementing the change in that commit; a commit that is entirely mechanical (e.g. "fix lint", "style: formatting"); or mechanical changes already isolated in their own commit. When in doubt, do NOT report.</Rule>
  </Rules>
</ReviewTask>`;
    }

    /**
     * Resolve each rule's `@file:` citations from the Context OS
     * (`contextReferenceId`) and inline the fetched content into the rule text,
     * so the sharded judge sees the authoritative convention instead of the bare
     * marker. Uses the SAME loader the PR-level path uses (handles same- and
     * cross-repo via `getRepositoryContentFile`). No-op when the loader isn't
     * wired (unit tests) or no rule carries a `contextReferenceId`. Best-effort:
     * any failure degrades to the rule text alone.
     */
    private async inlineContextOsReferences(
        rules: Partial<IKodyRule>[],
        input: ReviewAgentInput,
    ): Promise<Partial<IKodyRule>[]> {
        if (!this.externalReferenceLoaderService) return rules;
        // Pre-filter: only rules that actually cite an external reference reach
        // the loader — each resolution is an (uncached) network round-trip, so
        // don't pay it for rules that carry no contextReferenceId.
        const refRules = rules.filter((r) => r.contextReferenceId);
        if (refRules.length === 0) return rules;

        try {
            const analysisContext = {
                organizationAndTeamData: input.organizationAndTeamData,
                repository: input.repositoryId
                    ? {
                          id: input.repositoryId,
                          name:
                              input.repositoryFullName?.split('/').pop() ??
                              input.repositoryFullName,
                      }
                    : undefined,
                // `getRepositoryContentFile` fetches from `head.ref` (fallback
                // `base.ref`) and dereferences both objects — a bare `{ number }`
                // throws "Cannot read properties of undefined (reading 'ref')".
                // We only carry the base branch here (the reviewed head branch's
                // ref isn't on the agent input), so point both at it: reference
                // files are the established convention, which lives on the base
                // branch anyway.
                pullRequest: {
                    number: input.prNumber,
                    head: { ref: input.baseBranch },
                    base: { ref: input.baseBranch },
                },
            } as any;

            const { referencesMap } =
                await this.externalReferenceLoaderService.loadReferencesForRules(
                    refRules,
                    analysisContext,
                );

            // Surface rules whose reference failed to resolve — otherwise the
            // judge-blind degradation is invisible (inlineLoadedReferences logs
            // only on success, and the loader swallows per-rule fetch errors).
            const unresolved = findUnresolvedReferenceRules(
                refRules,
                referencesMap,
            );
            if (unresolved.length > 0) {
                this.shardLogger.warn({
                    message: `[kody-rules-shard] ${unresolved.length} rule(s) with a contextReferenceId resolved ZERO references for PR#${input.prNumber}; judging those without their referenced file(s)`,
                    context: this.getIdentity().name,
                    metadata: {
                        organizationAndTeamData: input.organizationAndTeamData,
                        prNumber: input.prNumber,
                        ruleUuids: unresolved.map((r) => r.uuid),
                    },
                });
            }

            return inlineLoadedReferences(rules, referencesMap, this.shardLogger);
        } catch (err) {
            this.shardLogger.warn({
                message: `[kody-rules-shard] Context OS reference load failed for PR#${input.prNumber}; judging without external refs: ${err instanceof Error ? err.message : String(err)}`,
                context: this.getIdentity().name,
                metadata: {
                    organizationAndTeamData: input.organizationAndTeamData,
                    prNumber: input.prNumber,
                    err,
                },
            });
            return rules;
        }
    }

    /**
     * Format Kody Rules into a structured prompt section.
     * Filters rules by path applicability to changed files.
     */
    private formatKodyRules(
        rules: Partial<IKodyRule>[],
        changedFiles: { filename: string }[],
    ): string {
        const changedPaths = changedFiles.map((f) => f.filename);

        const applicableRules = rules.filter((rule) => {
            // If no path pattern, rule applies to all files
            if (!rule.path) return true;

            // Check if any changed file matches the path pattern
            return changedPaths.some((filePath) =>
                this.matchesPathPattern(filePath, rule.path!),
            );
        });

        this.shardLogger.log({
            message: `[kody-rules-eval] ${applicableRules.length}/${rules.length} rule(s) selected for the kody-rules agent (${changedFiles.length} changed file(s))`,
            context: KodyRulesAgentProvider.name,
            metadata: {
                selectedRules: applicableRules.map((r) => ({
                    uuid: r.uuid,
                    title: r.title,
                    path: r.path,
                })),
                droppedByPath: rules.length - applicableRules.length,
            },
        });

        if (applicableRules.length === 0) return '';

        const formatted = applicableRules.map((rule, i) => {
            const parts = [
                `### Rule ${i + 1}: ${rule.title}`,
                `**UUID**: \`${rule.uuid}\``,
                `**Description**: ${rule.rule}`,
            ];

            if (rule.path) {
                parts.push(`**Applies to**: files matching \`${rule.path}\``);
            }

            if (rule.scope) {
                parts.push(
                    `**Scope**: ${rule.scope === KodyRulesScope.FILE ? 'Per-file' : 'Pull request level'}`,
                );
            }

            if (rule.examples && rule.examples.length > 0) {
                parts.push('**Examples**:');
                for (const ex of rule.examples) {
                    const label = ex.isCorrect ? 'Correct' : 'Incorrect';
                    parts.push(`- ${label}:\n\`\`\`\n${ex.snippet}\n\`\`\``);
                }
            }

            if (rule.sourcePath) {
                const anchor = rule.sourceAnchor
                    ? ` (section: ${rule.sourceAnchor})`
                    : '';
                const toolHint =
                    'use readFile to read this file from the current repository; if the file lives in another repo, use readReference with repo="owner/repo" and path="path"';
                parts.push(
                    `**Reference**: \`${rule.sourcePath}\`${anchor} — ${toolHint} for the full pattern/convention`,
                );
            }

            if (rule.extendedContext?.todo) {
                parts.push(
                    `**Additional context**: ${rule.extendedContext.todo}`,
                );
            }

            return parts.join('\n');
        });

        return `## Team Rules to Validate (${applicableRules.length} rules)\n\nCheck EVERY rule below against the changed code. Report violations only.\n\n${formatted.join('\n\n---\n\n')}`;
    }

    /**
     * Path pattern matching. Supports exact match, directory prefix, and
     * globs (`*`, `**`) via the shared minimatch-backed util.
     *
     * The hand-rolled regex we had before compiled `**\/*.ts` to
     * `.*\/[^/]*\.ts`, which required a `/` somewhere and silently missed
     * root-level files like `foo.ts` or `src/foo.ts`.
     */
    private matchesPathPattern(filePath: string, pattern: string): boolean {
        return fileMatchesRulePath(filePath, pattern);
    }
}
