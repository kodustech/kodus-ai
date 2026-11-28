import { nulJoinedHex } from '@libs/runtime/contracts/derive-id';

import * as yaml from 'js-yaml';

import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { type BlockerKindView, classifyBlocker, type FixAction } from './catalog';
import { UNTRUSTED_YAML } from '@libs/runtime/protocol/yaml-limits';
import { redactPatterns } from '@libs/runtime/redaction';

// Lessons (docs §4 Memory, ADR-018): what fixed a blocker, kept so the next
// time the same blocker shows up, in the same repository or (once an org
// admin promotes it) anywhere in the org, the fix that worked comes first.
//
// A lesson is only born from evidence, never from text: a setup of the
// default branch that boots on a clean machine right after a blocked one,
// with a change Kodus can read and that one of the catalog's fixes names
// (the recipe field it sets, the host that was allowed). That clean boot is
// the independent replay ADR-018 asks for. The action is a typed fix, never a
// command line, and a recipe value is never kept, only the field it set.

export type LessonScope = 'repo' | 'org';

export interface LessonFix {
    /** The catalog fix id, e.g. set_env:SESSION_SECRET. */
    id: string;
    action: FixAction;
    /** What the fix set, in words Kodus wrote (never the value). */
    summary: string;
}

export interface Lesson {
    lessonId: string;
    organizationId: string;
    scope: LessonScope;
    /** The repository it came from; it applies to that repo while the scope is repo. */
    repositoryId: string;
    environmentId: string;
    /** The blocker signature it fixed, as the catalog groups it. */
    signature: string;
    kind: BlockerKindView;
    /** Problem, cause and fix (the EnvPilot format), all from the catalog's templates. */
    problem: string;
    cause: string;
    fix: LessonFix;
    /** Where it was proven: the setups before and after (ADR-018, every lesson keeps its origin). */
    origin: { sha: string; branch?: string; blockedSetupKey: string; fixedSetupKey: string; at: string };
    /** Times the same fix got the same blocker past again. */
    helped: number;
    state: 'active' | 'retired';
    firstAt: string;
    lastAt: string;
    promotedBy?: string;
    promotedAt?: string;
    retiredBy?: string;
    retiredAt?: string;
    /**
     * Only a lesson a repair of Kody's recipe left (deriveRepairLesson): what the failure said and what Kody
     * wrote about the fix, in Kody's words, never the repository's content. The recipe author reads it as data
     * for the organization's other repositories (recipe-author/repair-lessons.ts).
     */
    repair?: RepairLessonText;
}

/** The text of a repair lesson: bounded and redacted when it is written, and again when it is read. */
export interface RepairLessonText {
    /** One line of the failure the repair answered. */
    evidence: string;
    /** Kody's own notes on the recipe that booted. */
    notes: string;
    /** The paths Kody changed or added, the recipe's own among them. */
    changed: string[];
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const compose = (text?: string) => {
    if (!text) return undefined;
    try {
        const doc = yaml.load(text, { ...UNTRUSTED_YAML, schema: yaml.CORE_SCHEMA });
        const c = isMap(doc) && isMap(doc.services) ? doc.services.compose : undefined;
        return isMap(c) ? c : undefined;
    } catch {
        return undefined;
    }
};

/** The id of the repo-scope lesson; promotion keeps it. */
export const lessonIdFor = (organizationId: string, repositoryId: string, signature: string, fixId: string) =>
    nulJoinedHex([organizationId, repositoryId, signature, fixId], 32);

const CAUSE: Partial<Record<BlockerKindView, string>> = {
    missing_env: 'The app reads an environment variable the machine did not set.',
    external_service: 'The app reaches an outside host at boot.',
    not_ready: 'The app takes longer to answer than the ready check waited.',
};

/**
 * The lessons a successful setup proves, given the blocked setup before it.
 * Empty unless the new setup is active, booted the default branch and the
 * previous one was blocked.
 */
export function deriveLessons(input: {
    previous: EnvironmentSetupRecord | null;
    current: EnvironmentSetupRecord;
    approvedHosts: string[];
    at: string;
}): Lesson[] {
    const { previous, current } = input;
    if (!previous || previous.state !== 'blocked' || current.state !== 'active' || current.refSource !== 'default_branch' || !current.sha) return [];
    if (previous.environmentId !== current.environmentId || previous.organizationId !== current.organizationId) return [];

    const before = compose(previous.recipe?.state === 'found' ? previous.recipe.content : undefined);
    const after = compose(current.recipe?.state === 'found' ? current.recipe.content : undefined);
    const approved = new Set(input.approvedHosts.map((h) => h.toLowerCase()));
    const out = new Map<string, Lesson>();

    for (const b of previous.blockers) {
        const c = classifyBlocker({ kind: b.kind, signature: b.signature, message: b.message, bundle: previous.failureBundle });
        for (const f of c.fixes) {
            let summary: string | undefined;
            if (f.recipeChange && after) {
                const [field, name] = f.recipeChange.path;
                if (field === 'env' && name) {
                    const was = isMap(before?.env) ? before.env[name] : undefined;
                    const now = isMap(after.env) ? after.env[name] : undefined;
                    if (now !== undefined && now !== null && was === undefined) summary = `Set ${name} in services.compose.env of the recipe.`;
                } else if (field === 'health_timeout' && after.health_timeout !== undefined && after.health_timeout !== before?.health_timeout) {
                    summary = 'Raised services.compose.health_timeout in the recipe.';
                }
            } else if (f.action === 'approve_host' && f.host && approved.has(f.host)) {
                summary = `Allowed ${f.host} for the environment.`;
            }
            if (!summary) continue;
            const lessonId = lessonIdFor(current.organizationId, current.repositoryId, c.signature, f.id);
            out.set(lessonId, {
                lessonId,
                organizationId: current.organizationId,
                scope: 'repo',
                repositoryId: current.repositoryId,
                environmentId: current.environmentId,
                signature: c.signature,
                kind: c.kind,
                problem: c.title,
                cause: CAUSE[c.kind] ?? c.title,
                fix: { id: f.id, action: f.action, summary },
                origin: {
                    sha: current.sha,
                    ...(current.branch ? { branch: current.branch } : {}),
                    blockedSetupKey: previous.key,
                    fixedSetupKey: current.key,
                    at: input.at,
                },
                helped: 1,
                state: 'active',
                firstAt: input.at,
                lastAt: input.at,
            });
        }
    }
    return [...out.values()];
}

/** The lessons that apply to a blocker of this repo: its own, and the org's (ADR-018, never another org's). */
export const lessonsFor = (lessons: Lesson[], q: { organizationId: string; repositoryId: string; signature: string }) =>
    lessons.filter(
        (l) =>
            l.state === 'active' &&
            l.organizationId === q.organizationId &&
            l.signature === q.signature &&
            (l.scope === 'org' || l.repositoryId === q.repositoryId),
    );

export const REPAIR_LESSON_LIMITS = { evidence: 300, notes: 600, changedPaths: 10, changedPath: 120 } as const;
/** The fix id of a repair lesson: one per organization, repository and signature (the next repair of it counts as helped). */
export const REPAIR_FIX_ID = 'kody_repair';

/**
 * Text that came from a repository or a model, made safe to keep and to show
 * a model as data: control characters (an ANSI escape, a NUL) and line breaks
 * become a space, secrets and token patterns are redacted, and it is cut.
 */
export function lessonText(text: string, max: number): string {
    const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return redactPatterns(flat).text.slice(0, max).trim();
}

/** A repair lesson's text, cleaned again (it is read from a store a worker wrote). */
export function cleanRepairText(r: RepairLessonText): RepairLessonText {
    const L = REPAIR_LESSON_LIMITS;
    return {
        evidence: lessonText(r.evidence ?? '', L.evidence),
        notes: lessonText(r.notes ?? '', L.notes),
        changed: (Array.isArray(r.changed) ? r.changed : []).slice(0, L.changedPaths).map((p) => lessonText(String(p), L.changedPath)).filter(Boolean),
    };
}

/**
 * The lesson a repair that booted proves: Kody's rewrite of the recipe failed on
 * `blocker`, and the rewrite passed (the setup ended active). Born from the
 * setup's own record, never from text a person wrote: what failed, Kody's own
 * notes of the fix and the paths it changed. Undefined without notes or paths:
 * nothing to teach.
 */
export function deriveRepairLesson(input: {
    current: EnvironmentSetupRecord;
    blocker: { kind: string; signature: string; title: string; cause?: string };
    learned: { evidence: string; changed: string[] };
    notes: string | undefined;
    at: string;
}): Lesson | undefined {
    const { current, blocker } = input;
    if (current.state !== 'active' || !current.sha) return undefined;
    const text = cleanRepairText({ evidence: input.learned.evidence || blocker.cause || blocker.title, notes: input.notes ?? '', changed: input.learned.changed });
    if (!text.notes && !text.changed.length) return undefined;
    const lessonId = lessonIdFor(current.organizationId, current.repositoryId, blocker.signature, REPAIR_FIX_ID);
    return {
        lessonId,
        organizationId: current.organizationId,
        scope: 'repo',
        repositoryId: current.repositoryId,
        environmentId: current.environmentId,
        signature: blocker.signature,
        kind: blocker.kind as BlockerKindView,
        problem: lessonText(blocker.title, 200),
        cause: lessonText(blocker.cause ?? blocker.title, 300),
        fix: { id: REPAIR_FIX_ID, action: 'fix_recipe', summary: 'Kody rewrote the recipe and the rewrite booted.' },
        origin: { sha: current.sha, ...(current.branch ? { branch: current.branch } : {}), blockedSetupKey: current.key, fixedSetupKey: current.key, at: input.at },
        helped: 1,
        state: 'active',
        firstAt: input.at,
        lastAt: input.at,
        repair: text,
    };
}
