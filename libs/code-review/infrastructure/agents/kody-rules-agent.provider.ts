import { Injectable, Optional } from '@nestjs/common';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import {
    BaseCodeReviewAgentProvider,
    ReviewAgentIdentity,
    ReviewAgentInput,
    ReviewAgentOutput,
} from './base-code-review-agent.provider';
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
    constructor(
        promptRunnerService: PromptRunnerService,
        permissionValidationService: PermissionValidationService,
        observabilityService: ObservabilityService,
        @Optional()
        documentationSearchService?: DocumentationSearchExaService,
        @Optional()
        byokErrorCounter?: ByokErrorCounter,
    ) {
        super(
            promptRunnerService,
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

        // Kody Rules check explicit user-defined rules. Coverage recovery
        // and second-chance still help — they push the agent to actually
        // open the changed files when the main loop didn't reach all of
        // them, and any new findings they produce keep their `ruleUuid`
        // because the prompt of those passes carries the rules forward.
        //
        // Synthesis-rescue is the one we MUST skip: its prompt is
        // open-ended ("re-think the review") and emits findings against a
        // generic schema (`label: bug|security|performance`) without
        // `ruleUuid`. For a kody-rules run that path produces:
        //   1. duplicate findings (same violation, re-worded), and
        //   2. findings that lose `ruleUuid`, so they no longer bypass
        //      the verifier — and the verifier doesn't have rules in its
        //      prompt, so it confidently drops them as "hallucinated
        //      rules". We've seen both happen on PR 25.
        return super.execute({
            ...input,
            // Keep the filtered rules list on the passed-down input so
            // buildUserPrompt / ruleUuid reconciliation still works.
            kodyRules: rules,
            skipSynthesisRescue: true,
        });
    }

    /**
     * Override to include the request's rules in the category prompt. The
     * formatted rule section is derived from `input.kodyRules` each call
     * instead of from instance state, so concurrent reviews cannot see
     * each other's rule set.
     */
    protected getCategoryPrompt(input: ReviewAgentInput): string {
        const rules = (
            (input as ReviewAgentInput & {
                kodyRules?: Partial<IKodyRule>[];
            }).kodyRules || []
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

        return `<ReviewTask>${prContextSection}
  <Diffs>
${diffsSection}
  </Diffs>

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
  </Rules>
</ReviewTask>`;
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
        if (filePath === pattern) return true;
        if (pattern.endsWith('/') && filePath.startsWith(pattern)) return true;
        return isFileMatchingGlob(filePath, [pattern]);
    }
}
