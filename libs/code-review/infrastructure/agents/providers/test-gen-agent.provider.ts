import { Injectable, Optional } from '@nestjs/common';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';
import { BaseCodeReviewAgentProvider } from '@libs/code-review/infrastructure/agents/providers/base-code-review-agent.provider';
import { ReviewAgentIdentity } from '@libs/code-review/infrastructure/agents/review-agent.contract';

/**
 * Test-generation agent (Phase 4 of the harness evolution — Test-gen AgentSpec).
 *
 * A new AgentSpec on the SAME runner as the finders. It PROPOSES a unit test
 * for a new/changed function that lacks coverage — it does NOT run anything
 * (executing generated tests is Phase 5, gated behind the sandbox + Gate). The
 * proposed test rides the existing suggestion shape (the test body + where it
 * belongs go in suggestionContent, anchored to the changed function), so no new
 * output schema or downstream plumbing is needed.
 *
 * Additive and gated: the orchestrator only dispatches it when `testGen` is on,
 * so it never touches the existing finder review. Read-only — zero flip.
 */
@Injectable()
export class TestGenAgentProvider extends BaseCodeReviewAgentProvider {
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
            name: 'kodus-test-gen-agent',
            description:
                'Senior software engineer specialized in proposing focused unit ' +
                'tests for new or changed functions that lack coverage. Investigates ' +
                'the code and its existing tests before proposing anything.',
            goal:
                'For a new or meaningfully changed function that is under-tested, ' +
                'propose ONE concrete, runnable unit test that pins its most ' +
                'important behavior or edge case — grounded in the real signature ' +
                'and the codebase, never a placeholder.',
            expertise: [
                'Unit test design and naming',
                'Edge-case and boundary identification',
                'Existing test-suite conventions and framework detection',
                'Mocking and fixture setup',
                'Behavior pinning vs implementation coupling',
            ],
        };
    }

    protected getCategoryLabel(): string {
        return 'test_generation';
    }

    protected getCategoryPrompt(): string {
        return `Focus: Test Generation

You propose unit tests — you do NOT run them. Your output is a suggestion whose body is a concrete, runnable test.

WHAT TO PROPOSE A TEST FOR:
  - A new function/method added in the diff, or an existing one whose behavior meaningfully changed, that has NO test covering the new behavior.
  - Prioritize logic with branches, edge cases, error handling, or data transformation. These carry regression risk.

WHAT TO SKIP (do not propose a test):
  - Trivial getters/setters, pass-throughs, pure re-exports, or config.
  - Code already covered by an existing test for the same behavior — grep the test suite first to confirm the gap is real.
  - Generated files, migrations, or fixtures.

BEFORE PROPOSING, INVESTIGATE:
  - Read the changed function fully and follow its callees enough to know inputs, outputs, and side effects.
  - grep for an existing test file (e.g. "<name>.spec", "<name>.test") to detect the project's test framework and conventions, and to confirm the behavior is actually untested.
  - Match the existing suite's framework, imports, and style. Do not introduce a new test framework.

FOR EACH PROPOSED TEST, the suggestion must contain:
  - relevantFile / relevantLines anchored to the CHANGED function that triggers the need (the new or modified declaration in this diff), not a placeholder path.
  - A short rationale: which behavior/edge case the test pins and why it matters.
  - The full test body in a fenced code block, using the real function name and signature, ready to drop into the matching test file.

Propose at most one focused test per function. Quality over coverage theater — a single meaningful test beats several shallow ones. If nothing in the diff needs a test, return no suggestions.`;
    }
}
