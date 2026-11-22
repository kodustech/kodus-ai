import { classifyBlocker } from '@libs/runtime/blockers/catalog';
import type { RecipeAuthorLast } from '@libs/runtime/contracts/recipe-author';
import { type EnvironmentSetupBlocker, type EnvironmentSetupRecord, isRecipeFailureBlocker } from '@libs/runtime/run';

import { recipeBoundTimeout } from './boot-phases';

/**
 * The authored recipe of the environment's last setup, for the next one to
 * start from (RepoLaunch): with no `failure` it booted and answered, or never
 * got its chance (a platform or capacity failure, or no cell, is no verdict
 * on it); with one, its boot failed on the recipe's account
 * (isRecipeFailureBlocker). A recipe the setup refused before booting it
 * (its parse, its resources) is never recorded as found, so it is not here.
 */
export function lastAuthoredRecipe(previous: EnvironmentSetupRecord | null, key: string): { sha?: string; last: RecipeAuthorLast } | undefined {
    const r = previous?.recipe;
    if (!previous || previous.key === key || previous.state === 'setting_up' || r?.origin !== 'authored' || r.state !== 'found' || !r.content) return undefined;
    const last: RecipeAuthorLast = {
        recipe: r.content,
        ...(r.files?.length ? { files: r.files } : {}),
        ...(r.notes ? { notes: r.notes.slice(0, 1_000) } : {}),
    };
    if (previous.state === 'active') return { sha: r.sha, last };
    const failed = withBuildTimeout(previous, recipeFailureOf(previous.blockers[0], previous.failureBundle));
    if (!failed) return { sha: r.sha, last };
    return { sha: r.sha, last: { ...last, failure: failed.failure } };
}

/**
 * How a boot failed on its recipe's account, as Kody's author gets it back
 * (`last.failure`: the catalog's signature and title, and its evidence lines,
 * a failed build's last lines among them), with the catalog's kind. Undefined
 * when the failure is no verdict on the recipe (isRecipeFailureBlocker, or a
 * failure the catalog reads as Kodus's platform).
 */
export function recipeFailureOf(
    b: EnvironmentSetupBlocker | undefined,
    bundle: EnvironmentSetupRecord['failureBundle'],
): { kind: string; failure: NonNullable<RecipeAuthorLast['failure']> } | undefined {
    if (!b || !isRecipeFailureBlocker(b)) return undefined;
    const c = classifyBlocker({ kind: b.kind, signature: b.signature, message: b.message, bundle });
    if (c.kind === 'platform') return undefined;
    const evidence = (c.evidence.lines.length ? c.evidence.lines : [b.message]).slice(-20).map((l) => l.slice(0, 500));
    return { kind: c.kind, failure: { signature: c.signature.slice(0, 256), title: (c.title || b.message).slice(0, 500), evidence } };
}

export const BUILD_TIMEOUT_TITLE = "The build did not finish within the setup's limit";

/**
 * A boot_timeout whose slowest phases are the recipe's own build
 * (recipeBoundTimeout), titled plainly, with those phases and their times as
 * its evidence: a Dockerfile restructured (no install after copying the
 * source, no node_modules copied between stages) shortens it. Undefined for
 * any other timeout; any other failure is returned as it came.
 */
function withBuildTimeout(rec: EnvironmentSetupRecord, failed: ReturnType<typeof recipeFailureOf>): ReturnType<typeof recipeFailureOf> & { buildTimeout?: true } {
    if (failed?.failure.signature !== 'boot_timeout') return failed;
    const boot = [...rec.steps].reverse().find((s) => s.name === 'boot');
    const evidence = recipeBoundTimeout(boot?.phases);
    if (!evidence) return failed;
    return { kind: failed.kind, failure: { signature: 'boot_timeout', title: BUILD_TIMEOUT_TITLE, evidence }, buildTimeout: true };
}

/**
 * Failures a rewrite of the recipe does not fix, though they go back to Kody
 * on the next setup: the boot outlived the machine's memory (a machine size),
 * and an outbound host an admin approves. A boot that outlived the setup's
 * ceiling only when its time went to the recipe's build (withBuildTimeout),
 * and once per setup: each try costs a whole ceiling.
 */
const NOT_REPAIRABLE_SIGNATURES: ReadonlySet<string> = new Set(['boot_timeout', 'out_of_memory']);

/**
 * The failure a repair inside this setup sends back to Kody, or undefined
 * when there is none to make: only a blocked default-branch setup booting a
 * recipe Kody wrote or Kodus inferred (never one the customer committed), whose boot failed on the recipe's account
 * (recipeFailureOf), never on a credential sent out, the machine's memory,
 * a host to approve, or a timeout the recipe's build did not cause.
 */
export function repairFailureOf(rec: EnvironmentSetupRecord): ReturnType<typeof recipeFailureOf> {
    const r = rec.recipe;
    if (rec.state !== 'blocked' || rec.refSource !== 'default_branch' || (r?.origin !== 'authored' && r?.origin !== 'inferred') || r.state !== 'found' || !r.content || !r.digest) return undefined;
    const failed = withBuildTimeout(rec, recipeFailureOf(rec.blockers[0], rec.failureBundle));
    if (!failed || failed.kind === 'security_violation') return undefined;
    const sig = failed.failure.signature;
    if (failed.buildTimeout) return rec.repairs?.some((r) => r.blocker.signature === sig) ? undefined : { kind: failed.kind, failure: failed.failure };
    if (NOT_REPAIRABLE_SIGNATURES.has(sig) || sig.startsWith('external_service:egress:')) return undefined;
    return failed;
}
