import type { BlockerKind } from '@libs/runtime/contracts/enums';
import type { FailureBundle } from '@libs/runtime/protocol';
import { MAX_HEALTH_TIMEOUT_SECONDS } from '@libs/runtime/protocol/recipe';

import { authoredFilesRule, bootTimeoutRule, composeRefusedRule, imageTooLargeRule, outOfMemoryRule, repoRefusedRule } from './rules/build';
import {
    authoredFilesUnsupportedRule,
    backendUnavailableRule,
    hostUnavailableRule,
    builderFailedRule,
    buildStateEvictedRule,
    cellUnavailableRule,
    environmentNotPreparedRule,
    imageLoadRule,
    isolationUnavailableRule,
    machineMinutesExhaustedRule,
    memoryUnavailableRule,
    noCapacityRule,
    orgCapacityRule,
    sizeUnavailableRule,
} from './rules/cell';
import { noRecipeRule, platformStepRule, recipeNeedsRule, recipeOutdatedRule, securityViolationRule } from './rules/declared';
import { buildEgressRule, credentialRule, egressRule, platformDeniedRule } from './rules/egress';
import { LOG_BLOCKER_RULES } from './rules/log';
import { type BlockerRule, linesOf } from './rules/rule';
import { fallbackRule, notReadyRule, recipeStepRule, serviceExitedRule, setupSignatureRule, suiteUnrunnableRule } from './rules/setup';

// The classifier of blockers and its catalog of fixes (docs §4, ADR-015):
// what blocked an environment, read from what the cell and the worker saw
// (the kind and signature, the reason and the redacted failure bundle),
// becomes one of the typed kinds, a stable signature that groups it in
// Environment Health, a plain-language title and the fixes in order, the
// first one recommended. Deterministic rules only; an unknown stays unknown.
//
// Everything here is a template filled with structured fields (S-23): a
// title or a fix never carries repository text beyond an identifier the
// rule extracted and checked (an env var name, a host, a service, a port).

/**
 * The kind a blocker card shows: every kind the classifier names
 * (contracts/enums.ts BLOCKER_KINDS), plus `not_ready`, the card of a setup
 * whose ready check never answered.
 */
export type BlockerKindView = BlockerKind | 'not_ready';

export type FixAction =
    /** Approve an outbound host for the environment; kept outside the recipe (§10). */
    | 'approve_host'
    /** Ask for the setup again: the failure was Kodus's, not the repo's. */
    | 'retry_setup'
    /** Give the app a test value for an env var, through a recipe PR. */
    | 'set_env'
    /** Give the ready check more time, through a recipe PR. */
    | 'raise_health_timeout'
    | 'pin_version'
    | 'add_packages'
    | 'bump_machine'
    | 'use_mock'
    | 'add_seed_step'
    | 'fix_recipe'
    | 'fix_listen_address'
    /** Kody's learn loop only (blockers/hypothesis.ts): point the ready check at another path, through a recipe PR. */
    | 'set_health_path'
    /** Kody's learn loop only: make another exposed http service the public one, through a recipe PR. */
    | 'set_public_service'
    /** Connect a cell of the organization's own: its claims there take no slot of the shared Kodus cells. */
    | 'use_own_cell'
    /** Create an org secret for a host that needs a credential (Settings, Secrets), its name and host prefilled. */
    | 'add_secret';

/**
 * Who makes a fix, and where: Kody, Kodus in one click, the dev in the
 * repository (`dev`), or the dev in Kodus's own settings (`settings`: the
 * machine size, a cell of the org's own). A reader that does not know
 * `settings` yet tells those fixes apart by their action.
 */
export type FixWho = 'kody' | 'one_click' | 'dev' | 'settings';

/** The fixes Kodus applies by opening a PR with a one-field recipe change. */
export const RECIPE_PR_ACTIONS = ['set_env', 'raise_health_timeout', 'set_health_path', 'set_public_service'] as const;
export type RecipePrAction = (typeof RECIPE_PR_ACTIONS)[number];
export const isRecipePrAction = (a: FixAction): a is RecipePrAction => (RECIPE_PR_ACTIONS as readonly string[]).includes(a);
/** The id prefix of a fix Kody's learn loop proved; the product adds it to the card from the setup record. */
export const KODY_FIX_PREFIX = 'kody:';

/** A recipe change a fix proposes: the field it sets, always under services.compose. */
export type RecipeChange = {
    path: ['env', string] | ['health_timeout'] | ['health'] | ['public'];
    value: string;
};

export interface BlockerFixView {
    /** Stable per blocker: action plus its parameter. */
    id: string;
    action: FixAction;
    who: FixWho;
    label: string;
    /** What the dev does, in a sentence; for `dev` fixes, the whole fix. */
    detail?: string;
    /** For approve_host, and add_secret's host. */
    host?: string;
    /** For add_secret: the variable the repository reads the credential from (its .npmrc's ${NAME}). */
    secretName?: string;
    /** For recipe fixes: applied by a PR on the recipe, shown as a diff first (ENV-05). */
    recipeChange?: RecipeChange;
}

export interface BlockerEvidence {
    /** The log lines that matched, redacted by the cell. */
    lines: string[];
    service?: string;
    /** A failed build: the name of the step that failed (evidence.ts). */
    step?: string;
}

export interface ClassifiedBlocker {
    kind: BlockerKindView;
    signature: string;
    title: string;
    evidence: BlockerEvidence;
    fixes: BlockerFixView[];
}

export interface BlockerInput {
    kind: string;
    signature: string;
    message: string;
    bundle?: FailureBundle;
}

/**
 * The longest wait a fix proposes for the ready check: the most a setup
 * waits, which the recipe contract owns (the parser caps health_timeout at
 * it). Re-exported for the worker's ready check.
 */
export { MAX_HEALTH_TIMEOUT_SECONDS };

// The rules and the helpers callers import from this path (README "Who imports what").
export { credentialNeeded, deniedEgressBundle, FULL_ACCESS_FIX_PREFIX, isApprovableDeniedHost, isPackageRegistry, MAX_PR_DENIED_HOSTS, prOnlyDeniedHosts } from './rules/egress';
export { fullEvidenceOf, FULL_EVIDENCE_LINES } from './evidence';
export { matchedBlockerLine, testValueFor } from './rules/log';
export { notReadyWaited, SUITE_UNRUNNABLE_SIGNATURE } from './rules/setup';
export type { BlockerRule } from './rules/rule';

/**
 * The classifier's rules, in the order they are tried: the first card wins.
 * The order is the policy. A rule placed above another reclassifies every
 * blocker both read, which changes the fix Environment Health shows and the
 * lesson Kody learns; __tests__/classify-blocker.pinned.spec.ts holds the
 * cards that must not change.
 *
 * 1. What the cell or the worker declared (a Kodus step, a security stop, the recipe).
 * 2. Signatures of a boot the hub or the cell could not place or run, then of a build the cell refused.
 * 3. Outbound access: a credential, the deny list, a host the build or the app was denied.
 * 4. The log lines, rule by rule (rules/log.ts).
 * 5. What only the setup names (its ready check, its steps, a recipe step), then the fallback.
 */
export const BLOCKER_RULES: readonly BlockerRule[] = [
    platformStepRule,
    securityViolationRule,
    recipeOutdatedRule,
    recipeNeedsRule,
    noRecipeRule,
    environmentNotPreparedRule,
    buildStateEvictedRule,
    cellUnavailableRule,
    orgCapacityRule,
    machineMinutesExhaustedRule,
    noCapacityRule,
    bootTimeoutRule,
    outOfMemoryRule,
    builderFailedRule,
    imageLoadRule,
    imageTooLargeRule,
    composeRefusedRule,
    sizeUnavailableRule,
    memoryUnavailableRule,
    isolationUnavailableRule,
    backendUnavailableRule,
    hostUnavailableRule,
    authoredFilesUnsupportedRule,
    authoredFilesRule,
    repoRefusedRule,
    credentialRule,
    platformDeniedRule,
    buildEgressRule,
    egressRule,
    // Before the log rules: its evidence is the runner's output, which they would read as another failure.
    suiteUnrunnableRule,
    ...LOG_BLOCKER_RULES,
    notReadyRule,
    setupSignatureRule,
    recipeStepRule,
    serviceExitedRule,
    fallbackRule,
];

/** The card of the first rule that reads the blocker, and that rule's id. */
export function classifyBlockerWithRule(input: BlockerInput): { rule: string; blocker: ClassifiedBlocker } {
    const ctx = { input, lines: linesOf(input) };
    for (const rule of BLOCKER_RULES) {
        const blocker = rule.classify(ctx);
        if (blocker) return { rule: rule.id, blocker };
    }
    // fallbackRule always reads; this is never reached.
    throw new Error('no blocker rule read the blocker');
}

export function classifyBlocker(input: BlockerInput): ClassifiedBlocker {
    return classifyBlockerWithRule(input).blocker;
}
