import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import { type ClassifiedBlocker, classifyBlocker } from '@libs/runtime/blockers/catalog';
import {
    applyLearnFix,
    checkHypothesis,
    hasCandidates,
    LEARN_TASK,
    type LearnFix,
    learnEvidenceFrom,
    learnPrompt,
    lessonsForPrompt,
    MAX_HYPOTHESES_PER_BLOCKER,
    parseHypothesisAnswer,
    type PromptAttempt,
} from '@libs/runtime/blockers/hypothesis';
import { type Lesson, lessonIdFor } from '@libs/runtime/blockers/lessons';
import type { FailureBundle } from '@libs/runtime/protocol';
import { type EnvironmentLearnAttempt, type EnvironmentLearnRecord, type EnvironmentSetupRecord, recipeDigest, setupLearnScopeId } from '@libs/runtime/run';

import { LlmBudgetExceededError, type LlmGateway } from '../agent/llm-gateway';
import { isCancellation } from '../workflow-cancellation';
import type { LessonStore } from './lesson.store';

// Kody's learn loop (docs "Ciclo de aprender", Inc. 1): a default-branch
// setup ended blocked on something the deterministic catalog cannot fix by
// itself. An LLM, through the product's gateway with the setup token (budgeted
// like a Run, S-47), picks one typed recipe change; Kodus checks it
// (blockers/hypothesis.ts), boots it on a new clean setup claim, and only a
// change that boots from zero twice (ENV-06) is proven. The default-branch
// recipe never changes here: the dev opens the PR. At most three hypotheses
// per blocker signature, counted across setups; then the card stays.
//
// Every LLM call, boot, clock read and save is a step, so a resumed workflow
// replays the same answers instead of asking again.

export type SetupStepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export type LearnBootOutcome = { ready: true } | { ready: false; blocker: { kind: string; signature: string; message: string }; bundle?: FailureBundle };

export interface LearnLoopOptions {
    llm: LlmGateway;
    lessons?: Pick<LessonStore, 'record' | 'listForRepo'>;
}

export interface LearnLoopContext {
    cmd: RuntimeEnvironmentSetupRequested;
    rec: EnvironmentSetupRecord;
    previous: EnvironmentSetupRecord | null;
    step: SetupStepRunner;
    clock: () => Promise<string>;
    save: (rec: EnvironmentSetupRecord) => Promise<void>;
    /** Boots this recipe on a new clean setup claim, checks it answers and releases it; `label` keeps its claim and steps apart. */
    boot: (recipeText: string, label: string) => Promise<LearnBootOutcome>;
}

/** Blockers the catalog only answers with "run the setup again" from a Kodus step: nothing in the recipe to try. */
const NOT_LEARNABLE = new Set(['platform', 'resources', 'security_violation', 'recipe_outdated']);

/**
 * The blocker the loop works on, or null when it does not run: only a
 * default-branch setup that booted (or tried to) with a recipe, blocked on an
 * unknown, on a not_ready, or on a failure the catalog has no rule for; and
 * only when the recipe is Kodus's inferred one or the failure is in a recipe
 * field (the ready check).
 */
export function learnTarget(rec: EnvironmentSetupRecord): { classified: ClassifiedBlocker; blocker: EnvironmentSetupRecord['blockers'][number] } | null {
    if (rec.state !== 'blocked' || rec.refSource !== 'default_branch' || rec.recipe?.state !== 'found' || !rec.recipe.content) return null;
    // A recipe Kody wrote is not on the default branch: a one-field PR has no file to change. Its blocker goes back to Kody's author instead (V3).
    if (rec.recipe.origin === 'authored') return null;
    if (!rec.steps.some((s) => s.name === 'boot')) return null;
    const blocker = rec.blockers[0];
    if (!blocker) return null;
    const classified = classifyBlocker({ kind: blocker.kind, signature: blocker.signature, message: blocker.message, bundle: rec.failureBundle });
    const noRule = classified.fixes.length > 0 && classified.fixes.every((f) => f.action === 'retry_setup') && !NOT_LEARNABLE.has(classified.kind);
    const catalogCannotFix = classified.kind === 'unknown' || classified.kind === 'not_ready' || noRule;
    if (!catalogCannotFix) return null;
    if (rec.recipe.origin !== 'inferred' && classified.kind !== 'not_ready') return null;
    return { classified, blocker };
}

const CAUSE: Record<LearnFix['action'], string> = {
    set_env: 'The app reads an environment variable the machine did not set.',
    raise_health_timeout: 'The app takes longer to answer than the ready check waited.',
    set_health_path: 'The ready check called a path the app does not answer.',
    set_public_service: 'The ready check called a service that is not the app.',
};

const summaryOf = (fix: LearnFix) => {
    const [field, name] = fix.change.path;
    if (field === 'env') return `Set ${name} in services.compose.env of the recipe.`;
    if (field === 'health_timeout') return 'Raised services.compose.health_timeout in the recipe.';
    if (field === 'health') return `Set services.compose.health to ${fix.change.value} in the recipe.`;
    return `Set services.compose.public to ${fix.change.value} in the recipe.`;
};

const promptAttempt = (a: EnvironmentLearnAttempt): PromptAttempt => ({
    ...(a.fix ? { fixId: a.fix.id } : {}),
    result: a.result,
    ...(a.refusal ? { refusal: a.refusal } : {}),
    ...(a.blocker ? { newBlocker: a.blocker.signature } : {}),
});

export class SetupLearnLoop {
    constructor(private readonly opts: LearnLoopOptions) {}

    /** Runs the loop on a blocked setup and records it on `rec.learn`; never throws (a failure leaves the deterministic card). */
    async run(ctx: LearnLoopContext): Promise<void> {
        const { cmd, rec, previous } = ctx;
        // No setup token: the product has no LLM gateway for this setup, the loop is off.
        if (!cmd.llmToken) return;
        const target = learnTarget(rec);
        if (!target) return;
        const signature = target.classified.signature;

        // The count per signature and this blocker's earlier attempts come from the previous setup of the environment.
        const carried = previous && previous.environmentId === rec.environmentId && previous.key !== rec.key ? previous.learn : undefined;
        const tried = new Map((carried?.tried ?? []).map((t) => [t.signature, t.count]));
        const learn: EnvironmentLearnRecord = {
            tried: [],
            attempts: (carried?.attempts ?? []).filter((a) => a.signature === signature && a.result !== 'trying'),
        };
        const sync = () => {
            learn.tried = [...tried].map(([s, count]) => ({ signature: s, count })).slice(-20);
        };
        rec.learn = learn;
        const count = () => tried.get(signature) ?? 0;

        const stop = async (why: NonNullable<EnvironmentLearnRecord['stopped']>) => {
            learn.stopped = why;
            sync();
            await ctx.save(rec);
        };
        if (count() >= MAX_HYPOTHESES_PER_BLOCKER) return stop('cap');

        const recipeText = rec.recipe!.content!;
        const origin = rec.recipe!.origin === 'inferred' ? 'inferred' : 'repository';
        const evidence = learnEvidenceFrom({ blocker: target.blocker, bundle: rec.failureBundle, recipe: { text: recipeText, origin } });
        // Nothing the LLM could choose: do not spend a call.
        if (!evidence || !hasCandidates(evidence.candidates)) return stop('nothing_to_try');

        const lessons = await ctx.step('learn:lessons', async () => {
            const all = await this.opts.lessons?.listForRepo?.(rec.organizationId, rec.repositoryId).catch(() => [] as Lesson[]);
            return lessonsForPrompt(all ?? [], { organizationId: rec.organizationId, repositoryId: rec.repositoryId, signature });
        });

        while (count() < MAX_HYPOTHESES_PER_BLOCKER) {
            const n = count() + 1;
            const messages = learnPrompt(evidence, lessons, learn.attempts.map(promptAttempt));
            const answer = await ctx.step(`learn:llm:${n}`, async () => {
                try {
                    const res = await this.opts.llm.complete({
                        runId: setupLearnScopeId(cmd.key),
                        organizationId: cmd.organizationId,
                        runToken: cmd.llmToken!,
                        sealedFor: cmd.key,
                        task: LEARN_TASK,
                        messages,
                    });
                    return { ok: true as const, text: res.text };
                } catch (e) {
                    return { ok: false as const, code: e instanceof LlmBudgetExceededError ? ('budget' as const) : ('llm_unavailable' as const) };
                }
            });
            // No answer is no hypothesis: it is not counted, and the loop stops for this setup.
            if ('code' in answer) return stop(answer.code);
            tried.set(signature, n);
            sync();

            const at = await ctx.clock();
            const parsed = parseHypothesisAnswer(answer.text);
            if ('reason' in parsed) {
                learn.attempts.push({ n, signature, result: 'refused', refusal: parsed.reason, setupKey: rec.key, at });
                await ctx.save(rec);
                continue;
            }
            if (parsed.hypothesis.kind === 'cannot_fix') return stop('cannot_fix');
            const checked = checkHypothesis(
                parsed.hypothesis,
                evidence,
                learn.attempts.flatMap((a) => (a.fix ? [a.fix.id] : [])),
            );
            if ('reason' in checked) {
                learn.attempts.push({ n, signature, result: 'refused', refusal: checked.reason, setupKey: rec.key, at });
                await ctx.save(rec);
                continue;
            }
            const fix = checked.fix;
            const edited = applyLearnFix(recipeText, fix);
            if (!('text' in edited)) {
                learn.attempts.push({
                    n,
                    signature,
                    fix: { id: fix.id, action: fix.action, label: fix.label },
                    result: 'refused',
                    refusal: 'edit_failed',
                    setupKey: rec.key,
                    at,
                });
                await ctx.save(rec);
                continue;
            }

            const attempt: EnvironmentLearnAttempt = {
                n,
                signature,
                fix: { id: fix.id, action: fix.action, label: fix.label },
                result: 'trying',
                setupKey: rec.key,
                at,
            };
            learn.attempts.push(attempt);
            await ctx.save(rec);

            const first = await ctx.boot(edited.text, `learn-${n}`);
            if ('blocker' in first) {
                attempt.result = 'blocked';
                attempt.blocker = blockerView(first);
                await ctx.save(rec);
                continue;
            }
            // ENV-06: a second boot from zero on another clean machine, or it is not proven.
            const replay = await ctx.boot(edited.text, `learn-${n}-replay`);
            if ('blocker' in replay) {
                attempt.result = 'booted_once';
                attempt.cleanBoots = 1;
                attempt.blocker = blockerView(replay);
                await ctx.save(rec);
                continue;
            }
            attempt.result = 'booted';
            attempt.cleanBoots = 2;
            learn.proven = {
                signature,
                fix: attempt.fix!,
                change: fix.change,
                content: edited.text,
                digest: recipeDigest(edited.text),
                cleanBoots: 2,
                origin,
            };
            await stop('proven');
            await this.recordLesson(ctx, target.classified, fix, `${rec.key}#learn-${n}`);
            return;
        }
        return stop('cap');
    }

    /** The two clean boots are the independent replay ADR-018 asks for; the lesson keeps the typed fix, never a value. */
    private async recordLesson(ctx: LearnLoopContext, c: ClassifiedBlocker, fix: LearnFix, fixedSetupKey: string) {
        const store = this.opts.lessons;
        const { rec } = ctx;
        if (!store || !rec.sha) return;
        const at = await ctx.clock();
        const lessonId = lessonIdFor(rec.organizationId, rec.repositoryId, c.signature, fix.id);
        const lesson: Lesson = {
            lessonId,
            organizationId: rec.organizationId,
            scope: 'repo',
            repositoryId: rec.repositoryId,
            environmentId: rec.environmentId,
            signature: c.signature,
            kind: c.kind,
            problem: c.title,
            cause: CAUSE[fix.action],
            fix: { id: fix.id, action: fix.action, summary: summaryOf(fix) },
            origin: { sha: rec.sha, ...(rec.branch ? { branch: rec.branch } : {}), blockedSetupKey: rec.key, fixedSetupKey, at },
            helped: 1,
            state: 'active',
            firstAt: at,
            lastAt: at,
        };
        await ctx.step('learn:lesson', () => store.record(lesson)).catch((error: unknown) => {
            if (isCancellation(error)) throw error;
        });
    }
}

const blockerView = (out: Extract<LearnBootOutcome, { ready: false }>) => {
    const c = classifyBlocker({ ...out.blocker, bundle: out.bundle });
    return { kind: c.kind, signature: c.signature, title: c.title.slice(0, 200) };
};
