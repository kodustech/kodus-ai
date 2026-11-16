import { type BlockerFixView, classifyBlocker, KODY_FIX_PREFIX } from '@libs/runtime/blockers/catalog';
import { type Lesson, lessonsFor } from '@libs/runtime/blockers/lessons';
import { applyRecipeChange } from '@libs/runtime/blockers/recipe-edit';
import { parseRecipe } from '@libs/runtime/protocol/recipe';
import type { EnvironmentLearnAttempt, EnvironmentLearnRecord, EnvironmentSetupRecord, RuntimeRunProjection } from '@libs/runtime/run';

import { type EnvironmentRepository, type RuntimeLessonReader } from '../../domain/ports';
import { RuntimeBlockerFixView, RuntimeBlockerGroupView, type RuntimeMembershipBlockerGroupView } from './environment-view';

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
    for (const g of groups.values()) {
        const tried = triedOn(setup?.learn, g.signature);
        if (tried.length) g.tried = tried;
    }
    return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** Why Kodus did not try a hypothesis Kody sent, in the dev's words (EnvironmentLearnAttempt.refusal). */
const REFUSED: Record<NonNullable<EnvironmentLearnAttempt['refusal']>, string> = {
    not_json: 'its answer was not a change Kodus could read',
    not_allowed: 'it was a change Kodus does not make on its own',
    not_in_evidence: 'it named a value that is not in the evidence',
    already_set: 'the recipe already had it',
    not_higher: 'it did not raise the current value',
    unknown_service: 'it named a service the recipe does not have',
    duplicate: 'it repeated an earlier try',
    edit_failed: 'the recipe could not take the edit',
};

/**
 * Blocker.tried (docs §5): each attempt of the learn loop on this signature, the earlier setups' included,
 * oldest first, as one line a dev reads: the change and how its boot ended.
 */
export function triedOn(learn: EnvironmentLearnRecord | undefined, signature: string): string[] {
    return (learn?.attempts ?? [])
        .filter((a) => a.signature === signature)
        .sort((a, b) => a.at.localeCompare(b.at) || a.n - b.n)
        .map((a) => {
            if (a.result === 'refused' || !a.fix) return `A change Kody proposed was not tried: ${a.refusal ? REFUSED[a.refusal] : 'it was not a change Kodus could try'}`;
            const ended = {
                trying: 'booting now',
                booted: `booted on ${a.cleanBoots ?? 2} clean machines`,
                booted_once: 'booted once, then not on the second clean machine',
                blocked: a.blocker && a.blocker.signature !== signature ? `blocked by something else (${a.blocker.title})` : `still blocked${a.blocker ? ` (${a.blocker.title})` : ''}`,
            }[a.result];
            return `${a.fix.label}: ${ended}`;
        });
}

/** The lessons that may apply to this environment's repo, or none when the store is unreachable (the cards still show). */
export async function memoryFor(reader: RuntimeLessonReader | undefined, env: { organizationId: string; repositoryId: string }) {
    const lessons = reader ? await reader.listByOrganization(env.organizationId).catch(() => []) : [];
    return { lessons, organizationId: env.organizationId, repositoryId: env.repositoryId };
}

/**
 * What the committed recipe's services.needs asks for that the environment
 * does not hold: a connected repository that is not one of its repositories
 * ("Add <repo> to this environment"), or one Kodus is not connected to
 * ("Connect <repo>"). Read from the recipe the latest setup read on the
 * default branch, against the repositories as they are now, so adding the
 * repository clears the card at once. A recipe Kodus inferred or Kody wrote
 * is not committed, and says nothing here.
 */
export function membershipBlockerGroups(
    setup: EnvironmentSetupRecord | null,
    members: ReadonlyArray<Pick<EnvironmentRepository, 'repositoryId' | 'repositoryName' | 'fullName'>>,
    connected: ReadonlyArray<{ repositoryId: string; repositoryName: string }>,
): RuntimeMembershipBlockerGroupView[] {
    const text = recipeText(setup);
    if (!text) return [];
    const parsed = parseRecipe(text);
    if (!parsed.ok || !parsed.recipe.needs?.length) return [];
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const groups: RuntimeMembershipBlockerGroupView[] = [];
    for (const need of parsed.recipe.needs) {
        if (members.some((m) => same(m.fullName, need.repo) || same(m.repositoryName, need.repo))) continue;
        const repo = connected.find((r) => same(r.repositoryName, need.repo));
        const evidence = { lines: [`services.needs: - repo: ${need.repo} (alias ${need.alias})`] };
        groups.push(
            repo
                ? {
                      signature: `needs_member:${need.repo.toLowerCase()}`,
                      kind: 'other_repo',
                      title: `The recipe needs ${need.repo}, which is not part of this environment`,
                      count: 1,
                      ...(setup?.updatedAt ? { lastAt: setup.updatedAt } : {}),
                      state: 'open',
                      evidence,
                      fixes: [
                          {
                              id: `add_repository:${repo.repositoryId}`,
                              action: 'add_repository',
                              who: 'one_click',
                              label: `Add ${need.repo} to this environment`,
                              detail: `Boots it beside this repository at ws/${need.alias}, at its default branch, and asks for a setup.`,
                              repositoryId: repo.repositoryId,
                              repository: need.repo,
                              alias: need.alias,
                          },
                      ],
                  }
                : {
                      signature: `needs_connection:${need.repo.toLowerCase()}`,
                      kind: 'other_repo',
                      title: `The recipe needs ${need.repo}, which is not connected to Kodus`,
                      count: 1,
                      ...(setup?.updatedAt ? { lastAt: setup.updatedAt } : {}),
                      state: 'open',
                      evidence,
                      fixes: [
                          {
                              id: `connect_repository:${need.repo.toLowerCase()}`,
                              action: 'connect_repository',
                              who: 'settings',
                              label: `Connect ${need.repo} to Kodus`,
                              detail: `Add ${need.repo} to the repositories of the Git integration, then add it to this environment.`,
                              repository: need.repo,
                          },
                      ],
                  },
        );
    }
    return groups;
}
