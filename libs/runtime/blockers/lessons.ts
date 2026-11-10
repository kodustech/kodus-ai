import { createHash } from 'crypto';

import * as yaml from 'js-yaml';

import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { type BlockerKindView, classifyBlocker, type FixAction } from './catalog';

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

export const RUNTIME_LESSONS_COLLECTION = 'runtime_lessons';

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
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const compose = (text?: string) => {
    if (!text) return undefined;
    try {
        const doc = yaml.load(text, { schema: yaml.CORE_SCHEMA });
        const c = isMap(doc) && isMap(doc.services) ? doc.services.compose : undefined;
        return isMap(c) ? c : undefined;
    } catch {
        return undefined;
    }
};

/** The id of the repo-scope lesson; promotion keeps it. */
export const lessonIdFor = (organizationId: string, repositoryId: string, signature: string, fixId: string) =>
    createHash('sha256').update(`${organizationId}\0${repositoryId}\0${signature}\0${fixId}`).digest('hex').slice(0, 32);

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
