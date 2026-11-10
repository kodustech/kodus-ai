import { type BlockerFixView, classifyBlocker, KODY_FIX_PREFIX } from '@libs/runtime/blockers/catalog';
import { type Lesson, lessonsFor } from '@libs/runtime/blockers/lessons';
import { applyRecipeChange } from '@libs/runtime/blockers/recipe-edit';
import type { EnvironmentSetupRecord, RuntimeRunProjection } from '@libs/runtime/run';

import { type RuntimeLessonReader } from '../../domain/ports';
import { RuntimeBlockerFixView, RuntimeBlockerGroupView } from './environment-view';

/** The recipe text the setup read, when the worker kept it (never shown as is; only the diff of a fix). */
// An inferred or authored recipe is not on the default branch yet: a one-field fix PR waits for the recipe PR.
const recipeText = (setup: EnvironmentSetupRecord | null) =>
    setup?.recipe?.state === 'found' && setup.recipe.origin !== 'inferred' && setup.recipe.origin !== 'authored' ? setup.recipe.content : undefined;

/** A catalog fix for the product: a recipe change becomes its diff, or plain guidance when it cannot be made by a PR. */
export function fixView(fix: BlockerFixView, recipe?: { text?: string; path?: string }): RuntimeBlockerFixView {
    const { recipeChange, ...rest } = fix;
    if (!recipeChange) return rest;
    if (!recipe?.text) {
        return { ...rest, who: 'dev', detail: `${rest.detail ?? ''} Kodus read no recipe for this environment, so the change is not offered as a PR.`.trim() };
    }
    const edit = applyRecipeChange(recipe.text, recipeChange, recipe.path);
    if ('error' in edit) return { ...rest, who: 'dev', detail: `${rest.detail ?? ''} Not offered as a PR: ${edit.error}.`.trim() };
    return { ...rest, recipeDiff: edit.diff };
}

/**
 * The environment's blockers grouped by signature, read by the catalog
 * (docs §4): the latest setup's blockers, with its failure bundle, and the
 * reasons of its could_not_boot Runs. Classified on every read, so a better
 * catalog applies to what was already recorded.
 */
export function blockerGroups(setup: EnvironmentSetupRecord | null, runs: RuntimeRunProjection[], memory?: { lessons: Lesson[]; organizationId: string; repositoryId: string }) {
    const groups = new Map<string, RuntimeBlockerGroupView & { recipeChanges: Map<string, BlockerFixView['recipeChange']> }>();
    const recipe = { text: recipeText(setup), path: setup?.recipe?.path };
    const add = (input: { kind: string; signature: string; message: string; bundle?: EnvironmentSetupRecord['failureBundle'] }, at?: string, pr?: number) => {
        const c = classifyBlocker(input);
        const g = groups.get(c.signature) ?? {
            signature: c.signature,
            kind: c.kind,
            title: c.title,
            count: 0,
            state: 'open' as const,
            evidence: c.evidence,
            fixes: c.fixes.map((f) => fixView(f, recipe)),
            recipeChanges: new Map(c.fixes.filter((f) => f.recipeChange).map((f) => [f.id, f.recipeChange])),
        };
        g.count += 1;
        if (!g.lastAt || (at && at > g.lastAt)) {
            g.lastAt = at;
            if (pr !== undefined) g.lastPr = pr;
        }
        groups.set(c.signature, g);
    };
    for (const b of setup?.blockers ?? []) add({ kind: b.kind, signature: b.signature, message: b.message, bundle: setup?.failureBundle }, b.at);
    // The fix Kody's learn loop proved (two clean boots) comes first on its card, as a one-field recipe PR (a repository recipe only:
    // an inferred one is proposed whole by the recipe PR).
    const proven = setup?.learn?.proven;
    const target = proven && proven.origin === 'repository' ? groups.get(proven.signature) : undefined;
    if (proven && target) {
        const fix: BlockerFixView = {
            id: `${KODY_FIX_PREFIX}${proven.fix.id}`,
            action: proven.fix.action,
            who: 'dev',
            label: `${proven.fix.label} (Kody's fix)`,
            detail: `Kody tried this change on ${proven.cleanBoots} clean machines and the app answered every time. Opens a PR on the recipe with the one-field change.`,
            recipeChange: proven.change,
        };
        target.fixes = [fixView(fix, recipe), ...target.fixes];
        target.recipeChanges.set(fix.id, proven.change);
    }
    for (const r of runs.filter((x) => x.state === 'could_not_boot')) {
        const reason = (r.reason ?? 'could_not_boot').slice(0, 500);
        add({ kind: 'unknown', signature: reason, message: reason }, r.finishedAt ?? r.updatedAt, r.prNumber);
    }
    // What worked before comes first (ADR-018); the catalog's order stays among the rest.
    if (memory?.lessons.length) {
        for (const g of groups.values()) {
            const known = lessonsFor(memory.lessons, { organizationId: memory.organizationId, repositoryId: memory.repositoryId, signature: g.signature });
            if (!known.length) continue;
            g.fixes = g.fixes.map((f) => {
                const l = known.filter((x) => x.fix.id === f.id).sort((a, b) => (a.scope === b.scope ? b.helped - a.helped : a.scope === 'repo' ? -1 : 1))[0];
                return l ? { ...f, learned: { lessonId: l.lessonId, scope: l.scope, helped: l.helped, lastAt: l.lastAt } } : f;
            });
            g.fixes = [...g.fixes.filter((f) => f.learned), ...g.fixes.filter((f) => !f.learned)];
        }
    }
    return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** The lessons that may apply to this environment's repo, or none when the store is unreachable (the cards still show). */
export async function memoryFor(reader: RuntimeLessonReader | undefined, env: { organizationId: string; repositoryId: string }) {
    const lessons = reader ? await reader.listByOrganization(env.organizationId).catch(() => []) : [];
    return { lessons, organizationId: env.organizationId, repositoryId: env.repositoryId };
}
