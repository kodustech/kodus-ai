/**
 * Files a Kody Rule points at, loaded once per review and printed once per
 * shard prompt.
 *
 * A long rule is judged as several atoms that all carry the parent's uuid,
 * `sourcePath` and `contextReferenceId`. Appending the referenced files to each
 * unit's text put one copy per atom into every shard (issue #2508). Here the
 * files are keyed by rule uuid, and each shard prints them in one
 * `<References>` block that its rules link to by id.
 *
 * An entry is identified by where its text came from: the source (the rule's
 * own `sourcePath`, read at the PR head, or a Context OS reference, read at the
 * base branch), the repository, the path and the line range. Two rules share
 * an entry only when their texts are the same cut of the same file (one is a
 * prefix of the other); anything else stays a separate entry.
 *
 * This module imports nothing from the judge, so the judge can import it.
 */
import type { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

export type RuleReferenceSource = 'rule-source' | 'context-os';

export interface RuleReference {
    source: RuleReferenceSource;
    filePath: string;
    /** Set only when the file lives outside the pull request's repository. */
    repository?: string;
    lineRange?: { start: number; end: number };
    /** The `sourceAnchor` of a rule source file. */
    anchor?: string;
    /** Already cut to the rule's budget. */
    content: string;
}

/** Rule uuid → the files that rule points at. */
export type RuleReferenceIndex = Map<string, RuleReference[]>;

/** One file as `ExternalReferenceLoaderService` resolves it. */
export interface LoadedRuleReference {
    filePath?: string;
    content?: string;
    description?: string;
    repositoryId?: string;
    repositoryName?: string;
    lineRange?: { start: number; end: number };
}

interface ReferenceLogger {
    warn: (entry: any) => void;
    log?: (entry: any) => void;
}

/** What identifies the review in every log line: organization, team, PR. */
type LogMetadata = Record<string, unknown>;

const LOG_CONTEXT = 'kody-rules-sharded';
const DEFAULT_MAX_REF_CHARS = 6000;

/**
 * The rule's own `sourcePath` (IDE sync, centralized config), read through the
 * sandbox. Each path is read once, however many units or rules name it. A
 * missing sandbox, a failed read or an empty file leaves the rule without the
 * reference, never worse than not having it.
 */
export async function loadRuleSourceReferences(
    rules: Array<Partial<IKodyRule>>,
    read:
        | ((path: string, start: number, end: number) => Promise<string>)
        | undefined,
    options: {
        logger?: ReferenceLogger;
        logMetadata?: LogMetadata;
        maxRefChars?: number;
    } = {},
): Promise<RuleReferenceIndex> {
    const { logger, logMetadata } = options;
    const maxRefChars = options.maxRefChars ?? DEFAULT_MAX_REF_CHARS;
    const index: RuleReferenceIndex = new Map();
    if (!read) return index;

    const rulesByPath = new Map<string, Map<string, Partial<IKodyRule>>>();
    for (const rule of rules) {
        const sourcePath = rule.sourcePath?.trim();
        if (!sourcePath || !rule.uuid) continue;
        let byUuid = rulesByPath.get(sourcePath);
        if (!byUuid) rulesByPath.set(sourcePath, (byUuid = new Map()));
        if (!byUuid.has(rule.uuid)) byUuid.set(rule.uuid, rule);
    }

    await Promise.all(
        [...rulesByPath].map(async ([sourcePath, byUuid]) => {
            let content: string | undefined;
            try {
                content = await read(sourcePath, 1, 100000);
            } catch (err) {
                logger?.warn({
                    message: `kody-rules reference load failed for ${sourcePath}; judging ${byUuid.size} rule(s) without it`,
                    context: LOG_CONTEXT,
                    metadata: {
                        ...logMetadata,
                        sourcePath,
                        ruleUuids: [...byUuid.keys()],
                        err,
                    },
                });
                return;
            }
            if (!content || content.trim().length === 0) return;
            for (const [uuid, rule] of byUuid) {
                index.set(uuid, [
                    {
                        source: 'rule-source',
                        filePath: sourcePath,
                        ...(rule.sourceAnchor
                            ? { anchor: rule.sourceAnchor }
                            : {}),
                        content: content.slice(0, maxRefChars),
                    },
                ]);
            }
        }),
    );
    return index;
}

/**
 * Context OS references (`contextReferenceId`), already resolved by
 * `ExternalReferenceLoaderService.loadReferencesForRules`. `maxRefChars` bounds
 * the total per rule, across its files, and counts each file's header the way
 * the text appended to the rule always did, so the cut points do not move.
 */
export function collectLoadedReferences(
    referencesMap: Map<string, LoadedRuleReference[]> | undefined,
    options: {
        prRepository?: { id?: string; name?: string; fullName?: string };
        logger?: ReferenceLogger;
        logMetadata?: LogMetadata;
        maxRefChars?: number;
    } = {},
): RuleReferenceIndex {
    const index: RuleReferenceIndex = new Map();
    if (!referencesMap || referencesMap.size === 0) return index;
    const maxRefChars = options.maxRefChars ?? DEFAULT_MAX_REF_CHARS;

    for (const [uuid, loaded] of referencesMap) {
        const refs: RuleReference[] = [];
        let used = 0;
        for (const ref of loaded ?? []) {
            const content = ref?.content;
            if (!content || content.trim().length === 0) continue;
            const remaining = maxRefChars - used;
            if (remaining <= 0) break;
            const filePath = ref.filePath?.trim() || 'referenced file';
            const cut = content.slice(0, remaining);
            used += legacyHeaderLength(filePath) + cut.length;
            const repository = otherRepository(ref, options.prRepository);
            refs.push({
                source: 'context-os',
                filePath,
                ...(repository ? { repository } : {}),
                ...(ref.lineRange ? { lineRange: ref.lineRange } : {}),
                content: cut,
            });
        }
        if (refs.length === 0) continue;
        index.set(uuid, refs);
        options.logger?.log?.({
            message: `[kody-rules-shard] loaded ${refs.length} reference file(s) for rule ${uuid}: ${refs.map((r) => r.filePath).join(', ')}`,
            context: LOG_CONTEXT,
            metadata: {
                ...options.logMetadata,
                ruleUuid: uuid,
                inlinedRefs: refs.map((r) => r.filePath),
                crossRepository: refs
                    .filter((r) => r.repository)
                    .map((r) => r.repository),
                addedChars: refs.reduce((n, r) => n + r.content.length, 0),
            },
        });
    }
    return index;
}

/** The rule source file first, then the Context OS files, per rule. */
export function mergeRuleReferences(
    ...indexes: RuleReferenceIndex[]
): RuleReferenceIndex {
    const merged: RuleReferenceIndex = new Map();
    for (const index of indexes) {
        for (const [uuid, refs] of index) {
            merged.set(uuid, [...(merged.get(uuid) ?? []), ...refs]);
        }
    }
    return merged;
}

export interface ReferenceSection {
    /** The `<References>` block, or `[]` when no rule in the shard has one. */
    lines: string[];
    /** Index-aligned with the shard's rules: the ids each rule links to. */
    idsByRule: string[][];
    /** Entries printed, and the copies that one-per-unit inlining would have printed. */
    stats: { entries: number; chars: number; perUnitCopies: number };
}

/** The `<References>` block for one shard's rules, one entry per distinct text. */
export function buildReferenceSection(
    rules: Array<Partial<IKodyRule>>,
    references: RuleReferenceIndex | undefined,
): ReferenceSection {
    const entries: RuleReference[] = [];
    // Identity → the entries printed under it: more than one only when their
    // texts conflict.
    const byIdentity = new Map<string, number[]>();
    let perUnitCopies = 0;

    const idsByRule = rules.map((rule) => {
        const refs = (rule.uuid && references?.get(rule.uuid)) || [];
        perUnitCopies += refs.length;
        const ids: string[] = [];
        for (const ref of refs) {
            const key = identityOf(ref);
            const candidates = byIdentity.get(key) ?? [];
            let at = candidates.find((i) =>
                compatible(entries[i].content, ref.content),
            );
            if (at === undefined) {
                at = entries.push(ref) - 1;
                byIdentity.set(key, [...candidates, at]);
            } else if (ref.content.length > entries[at].content.length) {
                entries[at] = ref;
            }
            // The section a rule points at is the rule's, not the file's:
            // rules on different sections of one file share its entry.
            const id = ref.anchor
                ? `R${at + 1} (section: ${ref.anchor})`
                : `R${at + 1}`;
            if (!ids.includes(id)) ids.push(id);
        }
        return ids;
    });

    if (entries.length === 0) {
        return {
            lines: [],
            idsByRule,
            stats: { entries: 0, chars: 0, perUnitCopies: 0 },
        };
    }

    const lines = ['<References>'];
    entries.forEach((ref, i) => {
        lines.push(`[R${i + 1}] ${headerOf(ref)}`, ref.content, '');
    });
    lines.push('</References>', '');
    return {
        lines,
        idsByRule,
        stats: {
            entries: entries.length,
            chars: entries.reduce((n, ref) => n + ref.content.length, 0),
            perUnitCopies,
        },
    };
}

function identityOf(ref: RuleReference): string {
    const range = ref.lineRange
        ? `${ref.lineRange.start}-${ref.lineRange.end}`
        : 'all';
    return [ref.source, ref.repository ?? '', ref.filePath, range].join(
        '\u0000',
    );
}

function compatible(a: string, b: string): boolean {
    return a.startsWith(b) || b.startsWith(a);
}

function headerOf(ref: RuleReference): string {
    const parts = [`\`${ref.filePath}\``];
    if (ref.lineRange) {
        parts.push(`lines ${ref.lineRange.start}-${ref.lineRange.end}`);
    }
    const origin =
        ref.source === 'rule-source'
            ? "the rule's source file, read at this pull request's head"
            : ref.repository
              ? `referenced by the rule, from repository ${ref.repository}`
              : 'referenced by the rule, read at the base branch';
    return `${parts.join(' ')} (${origin})`;
}

function legacyHeaderLength(filePath: string): number {
    return `\n\n[Authoritative convention referenced by this rule — from \`${filePath}\`]:\n`
        .length;
}

function otherRepository(
    ref: LoadedRuleReference,
    pr: { id?: string; name?: string; fullName?: string } | undefined,
): string | undefined {
    const name = ref.repositoryName?.trim();
    const id = ref.repositoryId?.trim();
    if (!name && !id) return undefined;
    if (pr) {
        if (id && pr.id && id === pr.id) return undefined;
        if (name && (name === pr.name || name === pr.fullName)) {
            return undefined;
        }
    }
    return name || id;
}
