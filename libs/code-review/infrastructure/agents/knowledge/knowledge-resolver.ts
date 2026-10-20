import {
    estimateTokens,
    tokensToChars,
} from '@libs/code-review/infrastructure/adapters/services/utils/token-estimator';
import type {
    ReviewWarning,
    ReviewWarningKind,
} from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import {
    CUSTOM_AGENT_LIMITS,
    KNOWLEDGE_MAIN_REVIEW_TARGET,
    type KnowledgeItem,
    type KnowledgeLinkTarget,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

import type {
    BaseBranchReader,
    BaseBranchReadResult,
} from './base-branch-reader';
import { normalizeRepoPath } from './knowledge-path';
import { parseSkillMarkdown } from './skill-validator';

/**
 * Resolves the skills and docs linked to one review target (the main review
 * or one custom agent) from the PR's target branch.
 *
 * Nothing here fails a review: a missing or invalid skill, a doc over budget
 * or a knowledge file the PR edits becomes a warning, and the review runs with
 * what could be read.
 */

export type KnowledgeWarningCode =
    /** A linked skill has no SKILL.md on the target branch. */
    | 'SKILL_NOT_FOUND'
    /** SKILL.md exists but breaks the skill format (name, description, ...). */
    | 'SKILL_INVALID'
    /** The PR edits a linked skill or doc; the target-branch version was used. */
    | 'SKILL_CHANGED_IN_PR'
    /** A linked doc (or every file of a doc glob) is absent on the target branch. */
    | 'DOC_NOT_FOUND'
    /** A skill body or the docs were cut to fit their budget. */
    | 'KNOWLEDGE_TRUNCATED'
    /** A skill declares environment requirements the reviewer may not meet. */
    | 'SKILL_COMPATIBILITY';

export interface KnowledgeWarning {
    code: KnowledgeWarningCode;
    /** Repository path of the skill folder, skill file or doc. */
    path: string;
    detail: string;
}

export interface ResolvedSkill {
    name: string;
    description: string;
    /** Path of SKILL.md (or of the single-file skill). */
    path: string;
    /** Skill folder, or null for a single-file skill (`.claude/agents/x.md`). */
    folder: string | null;
    body: string;
    bodyTruncated: boolean;
    /** Body line `readSkillFile` (SKILL.md) continues from when the body was cut. */
    bodyNextOffset?: number;
    /** Files under the folder other than SKILL.md, relative to the folder. */
    files: string[];
    compatibility?: string;
}

export interface ResolvedDoc {
    path: string;
    content: string;
    truncated: boolean;
}

export interface ResolvedKnowledge {
    /** Branch the knowledge was read from. */
    ref: string;
    skills: ResolvedSkill[];
    docs: ResolvedDoc[];
    warnings: KnowledgeWarning[];
}

export type KnowledgeTargetKey = typeof KNOWLEDGE_MAIN_REVIEW_TARGET | string;

export const DOCS_TRUNCATED_MARKER = (budget: number) =>
    `[... truncated: the ${budget}-token budget for linked docs was reached ...]`;

const GLOB_CHARS = /[*?[\]{}]/;

export function isLinkedTo(
    item: KnowledgeItem,
    target: KnowledgeLinkTarget,
): boolean {
    return (item.linkedTo ?? []).some((link) =>
        typeof target === 'string'
            ? link === target
            : typeof link === 'object' && link.agentId === target.agentId,
    );
}

interface SkillLocation {
    skillFile: string;
    folder: string | null;
    expectedName: string;
}

/** `path` may name the skill folder, its SKILL.md, or a single-file skill. */
export function locateSkill(path: string): SkillLocation | null {
    const normalized = normalizeRepoPath(path);
    if (!normalized) return null;

    const segments = normalized.split('/');
    const last = segments[segments.length - 1];

    if (last === 'SKILL.md') {
        if (segments.length < 2) return null;
        return {
            skillFile: normalized,
            folder: segments.slice(0, -1).join('/'),
            expectedName: segments[segments.length - 2],
        };
    }
    if (/\.md$/i.test(last)) {
        return {
            skillFile: normalized,
            folder: null,
            expectedName: last.replace(/\.md$/i, ''),
        };
    }
    return {
        skillFile: `${normalized}/SKILL.md`,
        folder: normalized,
        expectedName: last,
    };
}

export class KnowledgeResolver {
    private readonly reads = new Map<string, Promise<BaseBranchReadResult>>();
    private readonly listings = new Map<string, Promise<string[]>>();

    constructor(
        private readonly reader: BaseBranchReader,
        private readonly options: { docTokenBudget?: number } = {},
    ) {}

    /** Knowledge for every target that has links, keyed by target. */
    async resolveAll(params: {
        items: KnowledgeItem[] | undefined;
        agentIds: string[];
        changedFiles?: string[];
    }): Promise<Map<KnowledgeTargetKey, ResolvedKnowledge>> {
        const targets: KnowledgeLinkTarget[] = [
            KNOWLEDGE_MAIN_REVIEW_TARGET,
            ...params.agentIds.map((agentId) => ({ agentId })),
        ];
        const result = new Map<KnowledgeTargetKey, ResolvedKnowledge>();
        for (const target of targets) {
            const resolved = await this.resolve({
                items: params.items,
                target,
                changedFiles: params.changedFiles,
            });
            if (
                resolved.skills.length ||
                resolved.docs.length ||
                resolved.warnings.length
            ) {
                result.set(
                    typeof target === 'string' ? target : target.agentId,
                    resolved,
                );
            }
        }
        return result;
    }

    async resolve(params: {
        items: KnowledgeItem[] | undefined;
        target: KnowledgeLinkTarget;
        changedFiles?: string[];
    }): Promise<ResolvedKnowledge> {
        const linked = (params.items ?? []).filter((item) =>
            isLinkedTo(item, params.target),
        );
        const changed = new Set(
            (params.changedFiles ?? [])
                .map((f) => normalizeRepoPath(f))
                .filter((f): f is string => !!f),
        );
        const warnings: KnowledgeWarning[] = [];

        const skills = await this.resolveSkills(
            linked
                .filter((i) => i.kind === 'skill')
                .slice(0, CUSTOM_AGENT_LIMITS.maxSkills),
            changed,
            warnings,
        );
        const docs = await this.resolveDocs(
            linked.filter((i) => i.kind === 'doc'),
            changed,
            warnings,
        );

        return { ref: this.reader.ref, skills, docs, warnings };
    }

    private async resolveSkills(
        items: KnowledgeItem[],
        changed: Set<string>,
        warnings: KnowledgeWarning[],
    ): Promise<ResolvedSkill[]> {
        const skills: ResolvedSkill[] = [];
        const names = new Set<string>();

        for (const item of items) {
            const location = locateSkill(item.path);
            if (!location) {
                warnings.push({
                    code: 'SKILL_INVALID',
                    path: item.path,
                    detail: 'the skill path is not a valid repository path',
                });
                continue;
            }
            const displayPath = location.folder ?? location.skillFile;

            const read = await this.read(location.skillFile);
            if (read.status !== 'ok') {
                warnings.push(
                    read.status === 'missing'
                        ? {
                              code: 'SKILL_NOT_FOUND',
                              path: displayPath,
                              detail: `no ${location.folder ? 'SKILL.md' : 'skill file'} on ${this.reader.ref}`,
                          }
                        : {
                              code: 'SKILL_INVALID',
                              path: displayPath,
                              detail: read.reason,
                          },
                );
                continue;
            }

            const parsed = parseSkillMarkdown(read.content, {
                expectedName: location.expectedName,
            });
            if (!parsed.ok) {
                warnings.push({
                    code: 'SKILL_INVALID',
                    path: displayPath,
                    detail: parsed.errors.join('; '),
                });
                continue;
            }
            if (names.has(parsed.skill.name)) {
                warnings.push({
                    code: 'SKILL_INVALID',
                    path: displayPath,
                    detail: `another linked skill is already named "${parsed.skill.name}"`,
                });
                continue;
            }
            names.add(parsed.skill.name);

            const files = location.folder
                ? (await this.list(location.folder))
                      .filter((f) => f !== location.skillFile)
                      .map((f) => f.slice(location.folder!.length + 1))
                      // References are one level deep; deeper files are not served.
                      .filter((f) => f.split('/').length <= 2)
                      .sort()
                : [];

            const touched = location.folder
                ? [...changed].some((f) => f.startsWith(`${location.folder}/`))
                : changed.has(location.skillFile);
            if (touched) {
                warnings.push({
                    code: 'SKILL_CHANGED_IN_PR',
                    path: displayPath,
                    detail: `this pull request edits the skill; it was reviewed with the ${this.reader.ref} version`,
                });
            }
            if (parsed.skill.bodyTruncated) {
                warnings.push({
                    code: 'KNOWLEDGE_TRUNCATED',
                    path: displayPath,
                    detail: parsed.notes.find((n) => /truncated/.test(n)) ?? '',
                });
            }
            if (parsed.skill.compatibility) {
                warnings.push({
                    code: 'SKILL_COMPATIBILITY',
                    path: displayPath,
                    detail: parsed.skill.compatibility,
                });
            }

            skills.push({
                ...parsed.skill,
                path: location.skillFile,
                folder: location.folder,
                files,
            });
        }
        return skills;
    }

    private async resolveDocs(
        items: KnowledgeItem[],
        changed: Set<string>,
        warnings: KnowledgeWarning[],
    ): Promise<ResolvedDoc[]> {
        const budget =
            this.options.docTokenBudget ?? CUSTOM_AGENT_LIMITS.maxDocTokens;
        const paths: string[] = [];

        for (const item of items) {
            const expanded = await this.expandDoc(item.path);
            if (!expanded.length) {
                warnings.push({
                    code: 'DOC_NOT_FOUND',
                    path: item.path,
                    detail: GLOB_CHARS.test(item.path)
                        ? `no file matches on ${this.reader.ref}`
                        : `not found on ${this.reader.ref}`,
                });
            }
            for (const p of expanded) if (!paths.includes(p)) paths.push(p);
        }

        if (paths.length > CUSTOM_AGENT_LIMITS.maxDocs) {
            const dropped = paths.splice(CUSTOM_AGENT_LIMITS.maxDocs);
            warnings.push({
                code: 'KNOWLEDGE_TRUNCATED',
                path: dropped[0],
                detail: `only ${CUSTOM_AGENT_LIMITS.maxDocs} docs are loaded per review target; skipped ${dropped.join(', ')}`,
            });
        }

        const docs: ResolvedDoc[] = [];
        let remaining = budget;
        for (const path of paths) {
            const read = await this.read(path);
            if (read.status !== 'ok') {
                warnings.push({
                    code: 'DOC_NOT_FOUND',
                    path,
                    detail:
                        read.status === 'missing'
                            ? `not found on ${this.reader.ref}`
                            : read.reason,
                });
                continue;
            }
            if (changed.has(path)) {
                warnings.push({
                    code: 'SKILL_CHANGED_IN_PR',
                    path,
                    detail: `this pull request edits the doc; it was reviewed with the ${this.reader.ref} version`,
                });
            }

            if (remaining <= 0) {
                warnings.push({
                    code: 'KNOWLEDGE_TRUNCATED',
                    path,
                    detail: `skipped: the ${budget}-token budget for linked docs was already used`,
                });
                continue;
            }

            const tokens = estimateTokens(read.content);
            if (tokens <= remaining) {
                docs.push({ path, content: read.content, truncated: false });
                remaining -= tokens;
                continue;
            }

            docs.push({
                path,
                content: `${read.content.slice(0, tokensToChars(remaining))}\n\n${DOCS_TRUNCATED_MARKER(budget)}`,
                truncated: true,
            });
            warnings.push({
                code: 'KNOWLEDGE_TRUNCATED',
                path,
                detail: `cut to fit the ${budget}-token budget for linked docs`,
            });
            remaining = 0;
        }
        return docs;
    }

    private async expandDoc(path: string): Promise<string[]> {
        if (GLOB_CHARS.test(path)) {
            if (path.split('/').some((s) => s === '..' || s === '.git')) {
                return [];
            }
            return (await this.reader.matchFiles(path)).sort();
        }
        const normalized = normalizeRepoPath(path);
        return normalized ? [normalized] : [];
    }

    private read(path: string): Promise<BaseBranchReadResult> {
        let pending = this.reads.get(path);
        if (!pending) {
            pending = this.reader.readFile(path);
            this.reads.set(path, pending);
        }
        return pending;
    }

    private list(folder: string): Promise<string[]> {
        let pending = this.listings.get(folder);
        if (!pending) {
            pending = this.reader.listFiles(folder);
            this.listings.set(folder, pending);
        }
        return pending;
    }
}

/**
 * Knowledge warnings as review warnings (dashboard, doctor). `agentName` is
 * the custom agent's name, or unset for the main review.
 */
export function toReviewWarnings(
    warnings: KnowledgeWarning[],
    agentName?: string,
): ReviewWarning[] {
    return warnings.map((w) => ({
        kind: w.code satisfies ReviewWarningKind,
        reason: 'knowledge',
        contextWindowTokens: 0,
        modelName: '',
        detail: `${w.path}: ${w.detail}`,
        ...(agentName ? { agentName } : {}),
    }));
}
