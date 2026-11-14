import { ApiError } from '../types/errors.js';
import type {
    CentralizedPrResult,
    CliToolConfig,
    CliToolSecret,
    CustomAgent,
    CustomAgentSeverity,
    CustomAgentStatus,
    CustomAgentTryTrace,
    FormattedCodeReviewParameter,
    FormattedConfigs,
    FormattedDirectory,
    FormattedNode,
    FormattedRepository,
    KnowledgeCandidate,
    KnowledgeItem,
    KnowledgeItemReport,
    KnowledgeLinkTarget,
    KnowledgeTargetBudget,
    TryRunView,
} from '../types/custom-agents.js';
import { KNOWLEDGE_MAIN_REVIEW_TARGET } from '../types/custom-agents.js';
import { CommandError } from '../utils/command-errors.js';
import { customAgentsApi } from './api/custom-agents.api.js';
import {
    userContextService,
    type UserContext,
} from './user-context.service.js';
import { resolveTeamRepository } from './team-repository.js';

const FEATURE = 'Custom agents';

/** Mirrors CUSTOM_AGENT_LIMITS (libs/core/.../codeReview.type.ts). */
export const CUSTOM_AGENT_LIMITS = {
    maxCliTools: 3,
    maxInstructionsLength: 8000,
    maxWritingLength: 2000,
} as const;

export const TAG_COLORS = [
    '#6366f1',
    '#0ea5e9',
    '#10b981',
    '#f59e0b',
    '#ef4444',
    '#a855f7',
] as const;

export const SEVERITIES: CustomAgentSeverity[] = [
    'low',
    'medium',
    'high',
    'critical',
];

/** Same templates the web app's "New agent" dialog offers. */
export const CUSTOM_AGENT_TEMPLATES = [
    {
        id: 'architecture',
        name: 'Architecture',
        color: TAG_COLORS[0],
        instructions: [
            'Review the change against the architecture this repository already follows.',
            'Flag imports that cross a layer boundary the rest of the code respects, business logic placed in controllers or adapters, and new modules that duplicate one that already exists.',
            'Dependencies point inward: domain or model code that imports from a controller, route handler, adapter, job, page or web framework, even only a type such as the request object, reverses that direction. A component built on the UI primitives follows it.',
            'Cite the file or doc that shows the existing pattern; do not flag style or naming.',
        ].join('\n'),
    },
    {
        id: 'e2e-coverage',
        name: 'E2E coverage',
        color: TAG_COLORS[1],
        instructions: [
            'For each user-facing behavior this pull request adds or changes, check whether an end-to-end test exercises it.',
            'Flag a changed flow with no test that reaches it, and a test that was edited so it no longer asserts the behavior it was named after.',
            'Name the flow and the test file you expected; do not ask for unit tests.',
        ].join('\n'),
    },
    {
        id: 'regression-hallucination',
        name: 'Regression & hallucination',
        color: TAG_COLORS[3],
        instructions: [
            'Look for behavior the change alters without saying so: removed branches, changed defaults, swallowed errors, narrowed inputs.',
            'Check that every function, method, option and import the change calls exists in this repository or in the version of the dependency it pins; read the definition before flagging.',
            'Report only what you confirmed by reading the code.',
        ].join('\n'),
    },
    {
        id: 'security',
        name: 'Security reviewer',
        color: TAG_COLORS[4],
        instructions: [
            'Trace untrusted input from where it enters to where it is used: queries, shell, file paths, templates, redirects.',
            'Flag missing authorization or tenant checks on new endpoints, secrets in code or logs, and weakened validation.',
            'Show the path from source to sink for every finding.',
        ].join('\n'),
    },
    {
        id: 'blank',
        name: 'New agent',
        color: TAG_COLORS[5],
        instructions: '',
    },
] as const;

export type CustomAgentTemplateId =
    (typeof CUSTOM_AGENT_TEMPLATES)[number]['id'];

export const TRY_POLL_INTERVAL_MS = 4000;
// A run on a large pull request takes minutes; past this the run is lost (its
// worker died) rather than slow, and the CLI must not poll forever.
/** JSON with object keys sorted, as the API fingerprints agent lists. */
function stableStringify(value: unknown): string {
    return JSON.stringify(value, (_key, entry) =>
        entry && typeof entry === 'object' && !Array.isArray(entry)
            ? Object.fromEntries(
                  Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
              )
            : entry,
    );
}

export const PLAN_NOT_ALLOWED_MESSAGE =
    "Custom agents and skills & docs run on the Teams and Enterprise plans and during the trial. This organization's plan left the change out, so nothing was saved.";

export const MAX_TRY_WAIT_MS = 30 * 60 * 1000;

export const STALE_AGENTS_MESSAGE =
    'Someone else changed these agents since this command read them. Nothing was saved. Run the command again to apply your change on top of theirs.';

export const STALE_KNOWLEDGE_MESSAGE =
    'Someone else changed these skills and docs since this command read them. Nothing was saved. Run the command again to apply your change on top of theirs.';

export type LevelTarget = {
    team?: string;
    repo?: string;
    directory?: string;
};

export type ConfigLevelName = 'global' | 'repository' | 'directory';

export type LevelView = {
    level: ConfigLevelName;
    repositoryId?: string;
    repositoryName?: string;
    directoryId?: string;
    directoryLabel?: string;
    /** The list this level saves. */
    agents: CustomAgent[];
    /** At a directory, the repository's agents it adds its own to. */
    inheritedAgents: CustomAgent[];
    /** What a review at this level runs, in order. */
    effectiveAgents: CustomAgent[];
    knowledge: KnowledgeItem[];
    reviewKnowledge: KnowledgeItem[];
    revisions: { customAgents?: string; knowledge?: string };
    /** Set at a repository that still reads the global agents list. */
    readsGlobalList: boolean;
};

export type AgentSummary = CustomAgent & {
    origin: 'own' | 'inherited';
    skills: string[];
    docs: string[];
    status?: CustomAgentStatus;
};

export type ListAgentsResult = {
    team: string;
    level: ConfigLevelName;
    repository?: { id: string; name: string };
    directory?: { id: string; label: string };
    windowDays?: number;
    // The usage read failed: the per-agent counts are unknown, not zero.
    usageUnavailable?: boolean;
    agents: AgentSummary[];
};

export type SaveResult = {
    level: ConfigLevelName;
    repository?: { id: string; name: string };
    directory?: { id: string; label: string };
    agent?: CustomAgent;
    deletedAgentId?: string;
    centralized?: CentralizedPrResult;
    note?: string;
};

export type AgentInput = {
    name?: string;
    instructions?: string;
    include?: string[];
    exclude?: string[];
    color?: string;
    format?: string;
    minSeverity?: string;
    maxComments?: number | string;
    suggestedFix?: string;
    writing?: string;
    model?: string;
    astGrep?: string;
    enabled?: boolean;
    /** Partial agent fields read from a JSON file, applied before the flags. */
    fromJson?: Partial<CustomAgent>;
    linkSkills?: string[];
    linkDocs?: string[];
    unlink?: string[];
};

// ── level resolution ───────────────────────────────────────────────────────

const normalizePath = (path: string) =>
    path
        .trim()
        .replace(/^\.?\/+/, '')
        .replace(/\/+$/, '');

function findRepository(
    repositories: FormattedRepository[],
    ref: string,
): FormattedRepository {
    // By id (what load() resolves a reference to) or exact name; never by a
    // last path segment, which can name another owner's repository.
    const wanted = ref.trim().toLowerCase();
    const matches = repositories.filter(
        (repo) =>
            repo.id.toLowerCase() === wanted ||
            (repo.name ?? '').toLowerCase() === wanted,
    );
    const exact = matches.find(
        (repo) =>
            repo.id.toLowerCase() === wanted ||
            (repo.name ?? '').toLowerCase() === wanted,
    );
    if (exact) {
        return exact;
    }
    if (matches.length === 1) {
        return matches[0];
    }
    if (matches.length > 1) {
        throw new CommandError(
            'INVALID_INPUT',
            `Repository '${ref}' matches more than one repository: ${matches.map((repo) => `${repo.name} (${repo.id})`).join(', ')}. Pass the id.`,
        );
    }
    throw new CommandError(
        'INVALID_INPUT',
        `Repository '${ref}' is not configured in Kodus for this team. Configured: ${repositories.map((repo) => repo.name).join(', ') || 'none'}.`,
    );
}

function directoryLabel(directory: FormattedDirectory): string {
    const paths = (directory.folders ?? [])
        .map((folder) => folder.path)
        .filter(Boolean);
    return paths.length
        ? paths.join(', ')
        : (directory.path ?? directory.name ?? directory.id);
}

function findDirectory(
    repository: FormattedRepository,
    ref: string,
): FormattedDirectory {
    const wanted = normalizePath(ref);
    const directories = repository.directories ?? [];
    const match = directories.find((directory) => {
        if (directory.id === ref.trim()) {
            return true;
        }
        const paths = [
            directory.path,
            ...(directory.folders ?? []).map((folder) => folder.path),
        ]
            .filter((path): path is string => !!path)
            .map(normalizePath);
        return paths.includes(wanted) || directory.name === ref.trim();
    });
    if (!match) {
        throw new CommandError(
            'INVALID_INPUT',
            `Directory '${ref}' has no settings in ${repository.name}. Directories with settings: ${directories.map(directoryLabel).join('; ') || 'none'}. Add the directory in the web app first.`,
        );
    }
    return match;
}

/**
 * The list a level owns. A directory runs the repository's agents plus its
 * own, so at a directory an inherited list is not the directory's to save
 * (use-custom-agents-form.ts `ownList`).
 */
function ownList<T>(
    node: FormattedNode<T[]> | undefined,
    level: ConfigLevelName,
): T[] {
    return level === 'directory' && node?.level !== 'directory'
        ? []
        : (node?.value ?? []);
}

function inheritedList<T>(
    node: FormattedNode<T[]> | undefined,
    level: ConfigLevelName,
): T[] {
    if (level !== 'directory') {
        return [];
    }
    return (
        (node?.level === 'directory' ? node.overriddenValue : node?.value) ?? []
    );
}

/** `inherited` with each entry `own` shares a key with in its place, then the rest of `own`. */
function addOrReplace<T>(
    inherited: T[],
    own: T[],
    keyOf: (entry: T) => string,
): T[] {
    return [
        ...inherited.map(
            (entry) =>
                own.find((mine) => keyOf(mine) === keyOf(entry)) ?? entry,
        ),
        ...own.filter(
            (mine) => !inherited.some((entry) => keyOf(entry) === keyOf(mine)),
        ),
    ];
}

export function resolveLevel(
    parameter: FormattedCodeReviewParameter,
    target: LevelTarget,
): LevelView {
    const configValue = parameter?.configValue ?? {};
    const repoRef = target.repo?.trim();
    const isGlobal = !repoRef || repoRef.toLowerCase() === 'global';

    if (isGlobal && target.directory) {
        throw new CommandError(
            'INVALID_INPUT',
            '--directory needs --repo: directories belong to a repository.',
        );
    }

    let level: ConfigLevelName = 'global';
    let configs: FormattedConfigs | undefined = configValue.configs;
    let revisions = {
        customAgents: configValue.customAgentsRevision,
        knowledge: configValue.knowledgeRevision,
    };
    let repository: FormattedRepository | undefined;
    let directory: FormattedDirectory | undefined;

    if (!isGlobal) {
        repository = findRepository(configValue.repositories ?? [], repoRef);
        level = 'repository';
        configs = repository.configs;
        revisions = {
            customAgents: repository.customAgentsRevision,
            knowledge: repository.knowledgeRevision,
        };
        if (target.directory) {
            directory = findDirectory(repository, target.directory);
            level = 'directory';
            configs = directory.configs;
            revisions = {
                customAgents: directory.customAgentsRevision,
                knowledge: directory.knowledgeRevision,
            };
        }
    }

    const agentsNode = configs?.customAgents;
    const knowledgeNode = configs?.knowledge;
    const agents = ownList(agentsNode, level);
    const inheritedAgents = inheritedList(agentsNode, level);
    const knowledge = ownList(knowledgeNode, level);

    return {
        level,
        repositoryId: repository?.id,
        repositoryName: repository?.name,
        directoryId: directory?.id,
        directoryLabel: directory ? directoryLabel(directory) : undefined,
        agents,
        inheritedAgents,
        effectiveAgents: addOrReplace(inheritedAgents, agents, (a) => a.id),
        knowledge,
        reviewKnowledge: addOrReplace(
            inheritedList(knowledgeNode, level),
            knowledge,
            (item) => item.path,
        ),
        revisions,
        readsGlobalList:
            level === 'repository' && agentsNode?.level === 'global',
    };
}

// ── agent helpers (mirror apps/web/src/lib/services/custom-agents/drafts.ts) ─

/** The agent's name as `@kody -v <slug>` and run names spell it. */
export function agentSlug(name: string): string {
    return (
        (name || '')
            .normalize('NFKD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'agent'
    );
}

function uniqueId(base: string, existing: Pick<CustomAgent, 'id'>[]): string {
    const taken = new Set(existing.map((agent) => agent.id));
    if (!taken.has(base)) {
        return base;
    }
    let index = 2;
    while (taken.has(`${base}-${index}`)) {
        index += 1;
    }
    return `${base}-${index}`;
}

function uniqueName(
    base: string,
    existing: Pick<CustomAgent, 'name'>[],
): string {
    const taken = new Set(existing.map((agent) => agentSlug(agent.name)));
    if (!taken.has(agentSlug(base))) {
        return base;
    }
    let index = 2;
    while (taken.has(agentSlug(`${base} ${index}`))) {
        index += 1;
    }
    return `${base} ${index}`;
}

function nextTagColor(existing: CustomAgent[]): string {
    const used = new Set(
        existing.map((agent) => agent.presentation?.tag?.color),
    );
    return (
        TAG_COLORS.find((color) => !used.has(color)) ??
        TAG_COLORS[existing.length % TAG_COLORS.length]
    );
}

export function findAgent(
    agents: CustomAgent[],
    ref: string,
): CustomAgent | undefined {
    const wanted = ref.trim();
    return (
        agents.find((agent) => agent.id === wanted) ??
        agents.find(
            (agent) => agent.name.toLowerCase() === wanted.toLowerCase(),
        ) ??
        agents.find((agent) => agentSlug(agent.name) === agentSlug(wanted))
    );
}

/** A knowledge path as the config stores it: a folder (or its SKILL.md) is a skill. */
export function knowledgeItemFromPath(
    input: string,
    kind?: KnowledgeItem['kind'],
): Pick<KnowledgeItem, 'path' | 'kind'> | null {
    const path = input.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!path) {
        return null;
    }
    if (/(^|\/)SKILL\.md$/.test(path)) {
        const folder = path.replace(/\/?SKILL\.md$/, '');
        return folder ? { path: folder, kind: 'skill' } : null;
    }
    if (kind) {
        return { path, kind };
    }
    const last = path.split('/').pop() ?? '';
    return /^[^.].*\.[a-z0-9]+$/i.test(last)
        ? { path, kind: 'doc' }
        : { path, kind: 'skill' };
}

const sameTarget = (a: KnowledgeLinkTarget, b: KnowledgeLinkTarget) =>
    typeof a === 'string' || typeof b === 'string'
        ? a === b
        : a.agentId === b.agentId;

/** Links or unlinks one item for one agent; an item nothing follows any more is dropped. */
export function setAgentKnowledge(
    knowledge: KnowledgeItem[],
    item: Pick<KnowledgeItem, 'path' | 'kind'>,
    agentId: string,
    on: boolean,
): KnowledgeItem[] {
    const target = { agentId };
    const index = knowledge.findIndex(
        (entry) => entry.path === item.path && entry.kind === item.kind,
    );
    const current: KnowledgeItem =
        index >= 0 ? knowledge[index] : { ...item, linkedTo: [] };
    const others = current.linkedTo.filter(
        (entry) => !sameTarget(entry, target),
    );
    const next: KnowledgeItem = {
        ...current,
        linkedTo: on ? [...others, target] : others,
    };
    const updated =
        index < 0
            ? [...knowledge, next]
            : knowledge.map((entry, position) =>
                  position === index ? next : entry,
              );
    if (on) {
        return updated;
    }
    return updated.filter(
        (entry) =>
            entry.linkedTo.length > 0 ||
            entry.path !== item.path ||
            entry.kind !== item.kind,
    );
}

function followedBy(knowledge: KnowledgeItem[], agentId: string) {
    const linked = knowledge.filter((item) =>
        item.linkedTo.some(
            (target) =>
                typeof target !== 'string' && target.agentId === agentId,
        ),
    );
    return {
        skills: linked
            .filter((item) => item.kind === 'skill')
            .map((item) => item.path),
        docs: linked
            .filter((item) => item.kind === 'doc')
            .map((item) => item.path),
    };
}

/** Drops an agent and its links; at a directory an override gives way to the inherited agent, whose links stay. */
export function withoutAgent(
    agents: CustomAgent[],
    knowledge: KnowledgeItem[],
    agentId: string,
    inherited: CustomAgent[],
): { agents: CustomAgent[]; knowledge: KnowledgeItem[] } {
    return {
        agents: agents.filter((agent) => agent.id !== agentId),
        knowledge: inherited.some((agent) => agent.id === agentId)
            ? knowledge
            : knowledge.map((item) => ({
                  ...item,
                  linkedTo: item.linkedTo.filter(
                      (target) =>
                          typeof target === 'string' ||
                          target.agentId !== agentId,
                  ),
              })),
    };
}

function pickSecret(secret: CliToolSecret): CliToolSecret[] {
    if (secret.value) {
        return [{ env: secret.env, value: secret.value }];
    }
    if (secret.ciphertext) {
        return [{ env: secret.env, ciphertext: secret.ciphertext }];
    }
    return [];
}

function sanitizeCliTool(tool: CliToolConfig): CliToolConfig {
    return {
        name: tool.name,
        install: tool.install,
        binary: tool.binary,
        allowedPrefixes: (tool.allowedPrefixes ?? [])
            .map((prefix) => prefix.trim())
            .filter(Boolean),
        usage: tool.usage ?? '',
        runsProjectCode: tool.runsProjectCode === true,
        secrets: (tool.secrets ?? []).flatMap(pickSecret),
        allowedDomains: tool.allowedDomains ?? [],
        ...(tool.timeoutSec !== undefined && { timeoutSec: tool.timeoutSec }),
    };
}

/**
 * The agent as the save endpoint takes it: only the schema's fields (the API
 * rejects unknown ones), a secret as the mask it was read with or a typed
 * value (prepareAgentsForSave in drafts.ts).
 */
export function prepareAgentForSave(agent: CustomAgent): CustomAgent {
    const presentation =
        agent.presentation ?? ({} as CustomAgent['presentation']);
    const include = agent.scope?.include?.filter(Boolean);
    const exclude = agent.scope?.exclude?.filter(Boolean);
    return {
        id: agent.id,
        name: agent.name,
        enabled: agent.enabled === true,
        instructions: agent.instructions ?? '',
        scope: {
            ...(include?.length && { include }),
            ...(exclude?.length && { exclude }),
        },
        tools: {
            ...(agent.tools?.astGrepConfig !== undefined && {
                astGrepConfig: agent.tools.astGrepConfig,
            }),
            ...(agent.tools?.mcp && {
                mcp: agent.tools.mcp.map((entry) => ({
                    integrationId: entry.integrationId,
                    tools: entry.tools ?? [],
                })),
            }),
            ...(agent.tools?.cli && {
                cli: agent.tools.cli.map(sanitizeCliTool),
            }),
        },
        ...(agent.models?.run && { models: { run: agent.models.run } }),
        presentation: {
            tag: { color: presentation.tag?.color ?? TAG_COLORS[0] },
            format: presentation.format ?? 'inline',
            ...(presentation.minSeverity && {
                minSeverity: presentation.minSeverity,
            }),
            ...(presentation.maxComments !== undefined && {
                maxComments: presentation.maxComments,
            }),
            suggestedFix: presentation.suggestedFix ?? 'when-confident',
            ...(presentation.writing !== undefined && {
                writing: presentation.writing,
            }),
        },
    };
}

const prepareKnowledgeForSave = (knowledge: KnowledgeItem[]): KnowledgeItem[] =>
    knowledge.map(({ path, kind, linkedTo }) => ({ path, kind, linkedTo }));

function oneOf<T extends string>(
    value: string | undefined,
    allowed: readonly T[],
    flag: string,
): T | undefined {
    if (value === undefined) {
        return undefined;
    }
    const normalized = value.trim().toLowerCase() as T;
    if (!allowed.includes(normalized)) {
        throw new CommandError(
            'INVALID_INPUT',
            `Invalid ${flag} '${value}'. Use one of: ${allowed.join(', ')}.`,
        );
    }
    return normalized;
}

function parseMaxComments(
    value: number | string | undefined,
): number | undefined {
    if (value === undefined || value === '') {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CommandError(
            'INVALID_INPUT',
            `Invalid --max-comments '${value}'. Use a positive integer.`,
        );
    }
    return parsed;
}

/** Applies the JSON file, then the flags, on top of `base`. */
export function applyAgentInput(
    base: CustomAgent,
    input: AgentInput,
): CustomAgent {
    const fromJson = input.fromJson ?? {};
    let agent: CustomAgent = {
        ...base,
        ...fromJson,
        id: base.id,
        scope: { ...base.scope, ...(fromJson.scope ?? {}) },
        tools: { ...base.tools, ...(fromJson.tools ?? {}) },
        presentation: {
            ...base.presentation,
            ...(fromJson.presentation ?? {}),
            tag: {
                ...base.presentation.tag,
                ...(fromJson.presentation?.tag ?? {}),
            },
        },
        ...(fromJson.models || base.models
            ? { models: { ...base.models, ...(fromJson.models ?? {}) } }
            : {}),
    };

    if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) {
            throw new CommandError('INVALID_INPUT', '--name cannot be empty.');
        }
        agent.name = name;
    }
    if (input.instructions !== undefined) {
        agent.instructions = input.instructions;
    }
    if (input.include !== undefined) {
        agent.scope = { ...agent.scope, include: input.include };
    }
    if (input.exclude !== undefined) {
        agent.scope = { ...agent.scope, exclude: input.exclude };
    }
    if (input.astGrep !== undefined) {
        agent.tools = {
            ...agent.tools,
            astGrepConfig: input.astGrep.trim() ? input.astGrep : undefined,
        };
    }
    if (input.model !== undefined) {
        agent.models = input.model.trim()
            ? { run: input.model.trim() }
            : undefined;
    }
    if (input.enabled !== undefined) {
        agent.enabled = input.enabled;
    }

    const presentation = { ...agent.presentation };
    if (input.color !== undefined) {
        presentation.tag = { color: input.color.trim() };
    }
    const format = oneOf(
        input.format,
        ['inline', 'single-comment'] as const,
        '--comment-format',
    );
    if (format) {
        presentation.format = format;
    }
    if (input.minSeverity !== undefined) {
        presentation.minSeverity =
            input.minSeverity.trim().toLowerCase() === 'none'
                ? undefined
                : oneOf(input.minSeverity, SEVERITIES, '--min-severity');
    }
    const maxComments = parseMaxComments(input.maxComments);
    if (maxComments !== undefined) {
        presentation.maxComments = maxComments;
    }
    const suggestedFix = oneOf(
        input.suggestedFix,
        ['when-confident', 'never'] as const,
        '--suggested-fix',
    );
    if (suggestedFix) {
        presentation.suggestedFix = suggestedFix;
    }
    if (input.writing !== undefined) {
        presentation.writing = input.writing;
    }
    agent = { ...agent, presentation };

    return agent;
}

function validateAgent(agent: CustomAgent, siblings: CustomAgent[]): void {
    if (
        (agent.instructions ?? '').length >
        CUSTOM_AGENT_LIMITS.maxInstructionsLength
    ) {
        throw new CommandError(
            'INVALID_INPUT',
            `Instructions allow at most ${CUSTOM_AGENT_LIMITS.maxInstructionsLength} characters (got ${agent.instructions.length}).`,
        );
    }
    if (
        (agent.presentation.writing ?? '').length >
        CUSTOM_AGENT_LIMITS.maxWritingLength
    ) {
        throw new CommandError(
            'INVALID_INPUT',
            `Writing guidance allows at most ${CUSTOM_AGENT_LIMITS.maxWritingLength} characters.`,
        );
    }
    if ((agent.tools.cli?.length ?? 0) > CUSTOM_AGENT_LIMITS.maxCliTools) {
        throw new CommandError(
            'INVALID_INPUT',
            `An agent allows at most ${CUSTOM_AGENT_LIMITS.maxCliTools} CLI tools.`,
        );
    }
    const slug = agentSlug(agent.name);
    const clash = siblings.find(
        (other) => other.id !== agent.id && agentSlug(other.name) === slug,
    );
    if (clash) {
        throw new CommandError(
            'INVALID_INPUT',
            `Another agent, "${clash.name}", already answers to @kody -v ${slug}. Choose a different name.`,
        );
    }
}

function applyKnowledgeLinks(
    knowledge: KnowledgeItem[],
    agentId: string,
    input: AgentInput,
): KnowledgeItem[] {
    let next = knowledge;
    const link = (paths: string[] | undefined, kind: KnowledgeItem['kind']) => {
        for (const path of paths ?? []) {
            const item = knowledgeItemFromPath(path, kind);
            if (!item) {
                throw new CommandError(
                    'INVALID_INPUT',
                    `Invalid path '${path}'.`,
                );
            }
            next = setAgentKnowledge(next, item, agentId, true);
        }
    };
    link(input.linkSkills, 'skill');
    link(input.linkDocs, 'doc');
    for (const path of input.unlink ?? []) {
        const item = knowledgeItemFromPath(path);
        const existing = next.find((entry) => entry.path === item?.path);
        if (existing) {
            next = setAgentKnowledge(next, existing, agentId, false);
        }
    }
    return next;
}

export function isCentralizedPrResult(
    value: unknown,
): value is CentralizedPrResult {
    return (
        !!value &&
        typeof value === 'object' &&
        (value as { mode?: unknown }).mode === 'centralized-pr'
    );
}

// ── skills & docs (mirror the Skills & docs page and drafts.ts setKnowledgeLink) ─

export type KnowledgeEntry = KnowledgeItem & {
    /** Who follows it, by name: 'Main review' or an agent's name. */
    followedBy: string[];
    report?: KnowledgeItemReport;
};

export type KnowledgeListResult = {
    team: string;
    level: ConfigLevelName;
    repository?: { id: string; name: string };
    directory?: { id: string; label: string };
    /** The list this level saves. */
    items: KnowledgeEntry[];
    /** At a directory, the repository's items its reviews also read. */
    inherited: KnowledgeEntry[];
    /** What an item can be linked to here. */
    targets: Array<{ target: string; label: string }>;
    /** Set when the default branch could not be read (or at global, where nothing is read). */
    unavailable?: string;
    branch?: string;
    overBudget?: KnowledgeTargetBudget[];
};

export type KnowledgeSaveResult = {
    level: ConfigLevelName;
    repository?: { id: string; name: string };
    directory?: { id: string; label: string };
    items: KnowledgeItem[];
    changed: boolean;
    centralized?: CentralizedPrResult;
    note?: string;
};

export type KnowledgeDiscoverResult = {
    level: ConfigLevelName;
    repository: { id: string; name: string };
    branch?: string;
    candidates: KnowledgeCandidate[];
    unavailable?: string;
};

const MAIN_REVIEW_LABEL = 'Main review';

/** Links or unlinks one item; an item left with no links stays registered, as on the page. */
export function setKnowledgeLink(
    knowledge: KnowledgeItem[],
    item: Pick<KnowledgeItem, 'path' | 'kind'>,
    target: KnowledgeLinkTarget,
    linked: boolean,
): KnowledgeItem[] {
    const index = knowledge.findIndex(
        (entry) => entry.path === item.path && entry.kind === item.kind,
    );
    const current: KnowledgeItem =
        index >= 0 ? knowledge[index] : { ...item, linkedTo: [] };
    const others = current.linkedTo.filter(
        (entry) => !sameTarget(entry, target),
    );
    const next: KnowledgeItem = {
        ...current,
        linkedTo: linked ? [...others, target] : others,
    };
    if (index < 0) {
        return [...knowledge, next];
    }
    return knowledge.map((entry, position) =>
        position === index ? next : entry,
    );
}

/** 'main-review' (or 'main') is the main review; anything else names an agent a review here runs. */
export function resolveKnowledgeTarget(
    ref: string,
    agents: CustomAgent[],
): KnowledgeLinkTarget {
    const wanted = ref.trim().toLowerCase();
    if (wanted === KNOWLEDGE_MAIN_REVIEW_TARGET || wanted === 'main') {
        return KNOWLEDGE_MAIN_REVIEW_TARGET;
    }
    const agent = findAgent(agents, ref);
    if (!agent) {
        throw new CommandError(
            'INVALID_INPUT',
            `'${ref}' is neither 'main-review' nor an agent here. Agents here: ${agents.map((entry) => entry.name).join(', ') || 'none'}.`,
        );
    }
    return { agentId: agent.id };
}

function targetLabel(target: KnowledgeLinkTarget, agents: CustomAgent[]) {
    return typeof target === 'string'
        ? MAIN_REVIEW_LABEL
        : (agents.find((agent) => agent.id === target.agentId)?.name ??
              target.agentId);
}

function requireKnowledgeItem(
    path: string,
    kind?: string,
): Pick<KnowledgeItem, 'path' | 'kind'> {
    if (kind !== undefined && kind !== 'skill' && kind !== 'doc') {
        throw new CommandError(
            'INVALID_INPUT',
            `--kind takes skill or doc, got '${kind}'.`,
        );
    }
    const item = knowledgeItemFromPath(path, kind as KnowledgeItem['kind']);
    if (!item) {
        throw new CommandError(
            'INVALID_INPUT',
            `'${path}' is not a path of a doc or skill (e.g. docs/payments.md or .claude/skills/ledger).`,
        );
    }
    return item;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── service ────────────────────────────────────────────────────────────────

class CustomAgentsService {
    private async load(target: LevelTarget): Promise<{
        ctx: UserContext;
        view: LevelView;
    }> {
        const ctx = await userContextService.resolve(FEATURE, {
            team: target.team,
        });
        const parameter = await customAgentsApi.getCodeReviewConfig(
            ctx.accessToken,
            ctx.teamId,
        );
        // The config names repositories by short name only; resolve the
        // reference against the team's repositories (owner/repo) first, so
        // `acme/api` never lands on another owner's `api`.
        const repo = target.repo?.trim();
        const resolved =
            repo &&
            repo.toLowerCase() !== 'global' &&
            !(parameter?.configValue?.repositories ?? []).some(
                (candidate) => candidate.id === repo,
            )
                ? {
                      ...target,
                      repo: (await resolveTeamRepository(ctx, repo)).id,
                  }
                : target;
        return { ctx, view: resolveLevel(parameter, resolved) };
    }

    private where(view: LevelView) {
        return {
            level: view.level,
            ...(view.repositoryId && {
                repository: {
                    id: view.repositoryId,
                    name: view.repositoryName ?? '',
                },
            }),
            ...(view.directoryId && {
                directory: {
                    id: view.directoryId,
                    label: view.directoryLabel ?? '',
                },
            }),
        };
    }

    private ownAgent(view: LevelView, ref: string): CustomAgent {
        const own = findAgent(view.agents, ref);
        if (own) {
            return own;
        }
        const inherited = findAgent(view.inheritedAgents, ref);
        if (inherited) {
            throw new CommandError(
                'INVALID_INPUT',
                `Agent '${inherited.name}' belongs to the repository, not to directory ${view.directoryLabel}. Change it without --directory.`,
            );
        }
        throw new CommandError(
            'INVALID_INPUT',
            `Agent '${ref}' not found at this level. Agents here: ${view.effectiveAgents.map((agent) => agent.name).join(', ') || 'none'}.`,
        );
    }

    /** Saves the lists that changed, naming the revision each was read at. */
    private async save(
        ctx: UserContext,
        view: LevelView,
        next: { agents?: CustomAgent[]; knowledge?: KnowledgeItem[] },
        staleMessage: string = STALE_AGENTS_MESSAGE,
    ): Promise<CentralizedPrResult | undefined> {
        const configValue: {
            customAgents?: CustomAgent[];
            knowledge?: KnowledgeItem[];
        } = {};
        const expectedRevisions: { customAgents?: string; knowledge?: string } =
            {};
        if (next.agents) {
            configValue.customAgents = next.agents.map(prepareAgentForSave);
            expectedRevisions.customAgents = view.revisions.customAgents;
        }
        if (
            next.knowledge &&
            JSON.stringify(next.knowledge) !== JSON.stringify(view.knowledge)
        ) {
            configValue.knowledge = prepareKnowledgeForSave(next.knowledge);
            expectedRevisions.knowledge = view.revisions.knowledge;
        }

        let centralized: CentralizedPrResult | undefined;
        try {
            const result = await customAgentsApi.save(ctx.accessToken, {
                configValue,
                organizationAndTeamData: { teamId: ctx.teamId },
                repositoryId:
                    view.level === 'global' ? undefined : view.repositoryId,
                directoryId: view.directoryId,
                expectedRevisions,
            });
            centralized = isCentralizedPrResult(result) ? result : undefined;
        } catch (error) {
            if (error instanceof ApiError && error.statusCode === 409) {
                throw new CommandError('API_REQUEST_FAILED', staleMessage, 1, {
                    status: 409,
                });
            }
            throw error;
        }

        if (!centralized) {
            await this.ensureSaved(ctx, view, next);
        }
        return centralized;
    }

    /**
     * On a plan without custom agents the API answers the save with success
     * but leaves both lists out of it (keepCustomAgentsIfPlanNotAllowed in
     * update-or-create-code-review-parameter-use-case.ts); the web never gets
     * there because its plan gate hides the screens. A list whose content
     * changed but whose fingerprint did not was not written.
     */
    private async ensureSaved(
        ctx: UserContext,
        view: LevelView,
        next: { agents?: CustomAgent[]; knowledge?: KnowledgeItem[] },
    ): Promise<void> {
        // Compared the way the API fingerprints a list (stableStringify in
        // libs/code-review/domain/custom-agents/revision.ts): a save that
        // only reorders keys or adds nothing is a no-op there too, and its
        // unchanged revision must not read as the plan dropping it.
        const changed = (
            [
                [
                    'customAgents',
                    next.agents?.map(prepareAgentForSave),
                    view.agents.map(prepareAgentForSave),
                ],
                [
                    'knowledge',
                    next.knowledge && prepareKnowledgeForSave(next.knowledge),
                    prepareKnowledgeForSave(view.knowledge),
                ],
            ] as const
        )
            .filter(
                ([, sent, before]) =>
                    sent !== undefined &&
                    stableStringify(sent) !== stableStringify(before),
            )
            .map(([field]) => field);
        if (changed.length === 0) {
            return;
        }

        const after = resolveLevel(
            await customAgentsApi.getCodeReviewConfig(
                ctx.accessToken,
                ctx.teamId,
            ),
            {
                repo: view.level === 'global' ? undefined : view.repositoryId,
                directory: view.directoryId,
            },
        );
        const dropped = changed.filter(
            (field) => after.revisions[field] === view.revisions[field],
        );
        if (dropped.length > 0) {
            throw new CommandError(
                'API_REQUEST_FAILED',
                PLAN_NOT_ALLOWED_MESSAGE,
                1,
                { dropped },
            );
        }
    }

    private saveNote(view: LevelView): string | undefined {
        return view.readsGlobalList
            ? `${view.repositoryName} now has its own agents list. Changes to the global agents don't reach it.`
            : undefined;
    }

    async list(target: LevelTarget): Promise<ListAgentsResult> {
        const { ctx, view } = await this.load(target);
        let windowDays: number | undefined;
        let statuses: CustomAgentStatus[] = [];
        let usageUnavailable = false;
        // Usage is counted per repository, as the web app shows it.
        if (view.repositoryId && view.effectiveAgents.length > 0) {
            const status = await customAgentsApi
                .getStatus(ctx.accessToken, {
                    teamId: ctx.teamId,
                    repositoryId: view.repositoryId,
                })
                .catch(() => {
                    usageUnavailable = true;
                    return null;
                });
            windowDays = status?.windowDays;
            statuses = status?.agents ?? [];
        }
        const ownIds = new Set(view.agents.map((agent) => agent.id));
        return {
            team: ctx.teamName,
            ...this.where(view),
            ...(windowDays !== undefined && { windowDays }),
            ...(usageUnavailable ? { usageUnavailable: true } : {}),
            agents: view.effectiveAgents.map((agent) => ({
                ...agent,
                origin: ownIds.has(agent.id) ? 'own' : 'inherited',
                ...followedBy(view.reviewKnowledge, agent.id),
                status: statuses.find((entry) => entry.agentId === agent.id),
            })),
        };
    }

    async show(
        ref: string,
        target: LevelTarget,
    ): Promise<
        ListAgentsResult['agents'][number] & {
            level: ConfigLevelName;
            windowDays?: number;
            usageUnavailable?: boolean;
        }
    > {
        const listed = await this.list(target);
        const agent = findAgent(listed.agents, ref) as AgentSummary | undefined;
        if (!agent) {
            throw new CommandError(
                'INVALID_INPUT',
                `Agent '${ref}' not found. Agents here: ${listed.agents.map((entry) => entry.name).join(', ') || 'none'}.`,
            );
        }
        return {
            ...agent,
            level: listed.level,
            windowDays: listed.windowDays,
            ...(listed.usageUnavailable && { usageUnavailable: true }),
        };
    }

    async create(
        input: AgentInput & { template?: string },
        target: LevelTarget,
    ): Promise<SaveResult> {
        const { ctx, view } = await this.load(target);
        const templateId = oneOf(
            input.template ?? 'blank',
            CUSTOM_AGENT_TEMPLATES.map((template) => template.id),
            '--template',
        ) as CustomAgentTemplateId;
        const template =
            CUSTOM_AGENT_TEMPLATES.find((entry) => entry.id === templateId) ??
            CUSTOM_AGENT_TEMPLATES[CUSTOM_AGENT_TEMPLATES.length - 1];
        const siblings = view.effectiveAgents;
        const requestedName = (input.name ?? input.fromJson?.name)?.trim();
        const name = requestedName || uniqueName(template.name, siblings);
        const colorTaken = siblings.some(
            (agent) => agent.presentation?.tag?.color === template.color,
        );
        const base: CustomAgent = {
            id: uniqueId(
                templateId === 'blank' || requestedName
                    ? agentSlug(name)
                    : template.id,
                siblings,
            ),
            name,
            // Starts off, like the web app: the team sees what it would
            // comment (`kodus agents try`, `@kody -v`) before it posts on
            // every pull request (#2172).
            enabled: false,
            instructions: template.instructions,
            scope: {},
            tools: {},
            presentation: {
                tag: {
                    color: colorTaken ? nextTagColor(siblings) : template.color,
                },
                format: 'inline',
                suggestedFix: 'when-confident',
            },
        };
        const agent = applyAgentInput(base, { ...input, name });
        validateAgent(agent, siblings);

        const agents = [...view.agents, agent];
        const knowledge = applyKnowledgeLinks(view.knowledge, agent.id, input);
        const centralized = await this.save(ctx, view, { agents, knowledge });
        return {
            ...this.where(view),
            agent: prepareAgentForSave(agent),
            ...(centralized && { centralized }),
            note: this.saveNote(view),
        };
    }

    async update(
        ref: string,
        input: AgentInput,
        target: LevelTarget,
    ): Promise<SaveResult> {
        const { ctx, view } = await this.load(target);
        const current = this.ownAgent(view, ref);
        const agent = applyAgentInput(current, input);
        validateAgent(agent, view.effectiveAgents);

        const agents = view.agents.map((entry) =>
            entry.id === current.id ? agent : entry,
        );
        const knowledge = applyKnowledgeLinks(view.knowledge, agent.id, input);
        const centralized = await this.save(ctx, view, { agents, knowledge });
        return {
            ...this.where(view),
            agent: prepareAgentForSave(agent),
            ...(centralized && { centralized }),
            note: this.saveNote(view),
        };
    }

    async setEnabled(
        ref: string,
        enabled: boolean,
        target: LevelTarget,
    ): Promise<SaveResult> {
        return this.update(ref, { enabled }, target);
    }

    async delete(ref: string, target: LevelTarget): Promise<SaveResult> {
        const { ctx, view } = await this.load(target);
        const current = this.ownAgent(view, ref);
        const next = withoutAgent(
            view.agents,
            view.knowledge,
            current.id,
            view.inheritedAgents,
        );
        const centralized = await this.save(ctx, view, next);
        const restored = view.inheritedAgents.find(
            (agent) => agent.id === current.id,
        );
        return {
            ...this.where(view),
            deletedAgentId: current.id,
            ...(centralized && { centralized }),
            note: restored
                ? `The repository's ${restored.name} runs here again.`
                : this.saveNote(view),
        };
    }

    /**
     * Runs one agent on a pull request without posting, as the web app's
     * "Try it" does: start the run, then read it back until it is done.
     */
    async tryAgent(
        ref: string,
        prUrl: string,
        target: LevelTarget,
        options: {
            input?: AgentInput;
            pollIntervalMs?: number;
            maxWaitMs?: number;
            wait?: (ms: number) => Promise<void>;
            onProgress?: () => void;
        } = {},
    ): Promise<{ agent: CustomAgent; trace: CustomAgentTryTrace }> {
        const url = prUrl?.trim();
        if (!url) {
            throw new CommandError('INVALID_INPUT', '--pr <url> is required.');
        }
        const { ctx, view } = await this.load(target);
        if (view.level === 'global' || !view.repositoryId) {
            throw new CommandError(
                'INVALID_INPUT',
                'Try runs on a pull request of one repository. Pass --repo <repository>.',
            );
        }
        const saved = findAgent(view.effectiveAgents, ref);
        if (!saved) {
            throw new CommandError(
                'INVALID_INPUT',
                `Agent '${ref}' not found. Agents here: ${view.effectiveAgents.map((agent) => agent.name).join(', ') || 'none'}.`,
            );
        }
        const agent = prepareAgentForSave(
            options.input ? applyAgentInput(saved, options.input) : saved,
        );
        const scope = { teamId: ctx.teamId, repositoryId: view.repositoryId };
        const started: TryRunView = await customAgentsApi.startTry(
            ctx.accessToken,
            {
                ...scope,
                directoryId: view.directoryId,
                prUrl: url,
                agent,
                knowledge: prepareKnowledgeForSave(view.reviewKnowledge),
            },
        );

        const wait = options.wait ?? sleep;
        const interval = options.pollIntervalMs ?? TRY_POLL_INTERVAL_MS;
        const maxWait = options.maxWaitMs ?? MAX_TRY_WAIT_MS;
        let run = started;
        let waited = 0;
        while (run.status !== 'done') {
            if (waited >= maxWait) {
                throw new CommandError(
                    'API_REQUEST_FAILED',
                    `Try run ${started.runId} did not finish in ${Math.round(maxWait / 60000)} minutes. Nothing was posted; run the command again.`,
                );
            }
            options.onProgress?.();
            await wait(interval);
            waited += interval;
            run = await customAgentsApi.readTry(
                ctx.accessToken,
                started.runId,
                scope,
            );
        }
        if (!run.result) {
            throw new CommandError(
                'API_REQUEST_FAILED',
                `Try run ${started.runId} finished without a result. Run the command again.`,
            );
        }
        return { agent, trace: run.result };
    }

    // ── skills & docs ──────────────────────────────────────────────────────

    private knowledgeEntry(
        item: KnowledgeItem,
        agents: CustomAgent[],
        reports: KnowledgeItemReport[] = [],
    ): KnowledgeEntry {
        const report = reports.find((entry) => entry.path === item.path);
        return {
            ...item,
            followedBy: item.linkedTo.map((target) =>
                targetLabel(target, agents),
            ),
            ...(report && { report }),
        };
    }

    async listKnowledge(
        target: LevelTarget & { check?: boolean },
    ): Promise<KnowledgeListResult> {
        const { ctx, view } = await this.load(target);
        const agents = view.effectiveAgents;
        let reports: KnowledgeItemReport[] = [];
        let unavailable: string | undefined;
        let branch: string | undefined;
        let overBudget: KnowledgeTargetBudget[] | undefined;

        // The page reads each item on the repository's default branch; at
        // global there is no repository to read.
        if (view.level === 'global' || !view.repositoryId) {
            unavailable =
                'Skills and docs are files of each repository. Pass a repository to check that each one exists there.';
        } else if (target.check !== false) {
            let failure = '';
            const report = await customAgentsApi
                .resolve(ctx.accessToken, {
                    teamId: ctx.teamId,
                    repositoryId: view.repositoryId,
                    knowledge: prepareKnowledgeForSave(view.knowledge),
                })
                .catch((error: unknown) => {
                    // Keep the API's reason: a 403, a rate limit and a 5xx
                    // call for different things.
                    failure = error instanceof Error ? error.message : '';
                    return null;
                });
            if (!report) {
                unavailable = `Couldn't read the repository right now${failure ? `: ${failure}` : '.'}`;
            } else if (report.knowledge.status === 'ok') {
                reports = report.knowledge.items;
                branch = report.repository?.branch;
                overBudget = report.knowledge.budgets.filter(
                    (budget) => budget.over.length > 0,
                );
            } else {
                unavailable = report.knowledge.reason;
            }
        }

        const own = new Set(view.knowledge.map((item) => item.path));
        return {
            team: ctx.teamName,
            ...this.where(view),
            items: view.knowledge.map((item) =>
                this.knowledgeEntry(item, agents, reports),
            ),
            inherited: view.reviewKnowledge
                .filter((item) => !own.has(item.path))
                .map((item) => this.knowledgeEntry(item, agents)),
            targets: [
                {
                    target: KNOWLEDGE_MAIN_REVIEW_TARGET,
                    label: MAIN_REVIEW_LABEL,
                },
                ...agents.map((agent) => ({
                    target: agent.id,
                    label: agent.name,
                })),
            ],
            ...(unavailable && { unavailable }),
            ...(branch && { branch }),
            ...(overBudget?.length && { overBudget }),
        };
    }

    /** Skills and docs found on the default branch that are not added yet. */
    async discoverKnowledge(
        target: LevelTarget,
    ): Promise<KnowledgeDiscoverResult> {
        const { ctx, view } = await this.load(target);
        if (view.level === 'global' || !view.repositoryId) {
            throw new CommandError(
                'INVALID_INPUT',
                'Discovery reads one repository. Pass a repository, not global.',
            );
        }
        const report = await customAgentsApi.resolve(ctx.accessToken, {
            teamId: ctx.teamId,
            repositoryId: view.repositoryId,
            knowledge: prepareKnowledgeForSave(view.knowledge),
            discover: true,
        });
        const repository = {
            id: view.repositoryId,
            name: view.repositoryName ?? '',
        };
        if (report.knowledge.status !== 'ok') {
            return {
                level: view.level,
                repository,
                candidates: [],
                unavailable: report.knowledge.reason,
            };
        }
        const registered = new Set(view.knowledge.map((item) => item.path));
        return {
            level: view.level,
            repository,
            branch: report.repository?.branch,
            candidates: (report.knowledge.candidates ?? []).filter(
                (candidate) => !registered.has(candidate.path),
            ),
        };
    }

    private async saveKnowledge(
        ctx: UserContext,
        view: LevelView,
        next: KnowledgeItem[],
    ): Promise<KnowledgeSaveResult> {
        const changed = JSON.stringify(next) !== JSON.stringify(view.knowledge);
        const centralized = changed
            ? await this.save(
                  ctx,
                  view,
                  { knowledge: next },
                  STALE_KNOWLEDGE_MESSAGE,
              )
            : undefined;
        return {
            ...this.where(view),
            items: next,
            changed,
            ...(centralized && { centralized }),
        };
    }

    async addKnowledge(
        paths: string[],
        target: LevelTarget,
        options: { kind?: string; link?: string[] } = {},
    ): Promise<KnowledgeSaveResult> {
        if (paths.length === 0) {
            throw new CommandError(
                'INVALID_INPUT',
                'Pass at least one path of a doc or skill.',
            );
        }
        const { ctx, view } = await this.load(target);
        const links = (options.link ?? []).map((ref) =>
            resolveKnowledgeTarget(ref, view.effectiveAgents),
        );
        let next = view.knowledge;
        for (const path of paths) {
            const requested = requireKnowledgeItem(path, options.kind);
            // A path is one item: an existing entry keeps its kind, so the
            // links land on it instead of on a second entry of another kind.
            const existing = next.find(
                (entry) => entry.path === requested.path,
            );
            const item = existing ?? { ...requested, linkedTo: [] };
            if (!existing) {
                next = [...next, item];
            }
            for (const link of links) {
                next = setKnowledgeLink(next, item, link, true);
            }
        }
        const result = await this.saveKnowledge(ctx, view, next);
        return {
            ...result,
            ...(links.length === 0 && {
                note: "Nothing follows the new items yet. Link them with 'skills link <path> main-review' or an agent.",
            }),
        };
    }

    async removeKnowledge(
        paths: string[],
        target: LevelTarget,
    ): Promise<KnowledgeSaveResult> {
        const { ctx, view } = await this.load(target);
        let next = view.knowledge;
        for (const path of paths) {
            const item = requireKnowledgeItem(path);
            if (!next.some((entry) => entry.path === item.path)) {
                const inherited = view.reviewKnowledge.some(
                    (entry) => entry.path === item.path,
                );
                throw new CommandError(
                    'INVALID_INPUT',
                    inherited
                        ? `'${item.path}' belongs to the repository, not to directory ${view.directoryLabel}. Remove it without --directory.`
                        : `'${item.path}' is not added here. Added: ${view.knowledge.map((entry) => entry.path).join(', ') || 'none'}.`,
                );
            }
            next = next.filter((entry) => entry.path !== item.path);
        }
        return this.saveKnowledge(ctx, view, next);
    }

    async linkKnowledge(
        path: string,
        targets: string[],
        linked: boolean,
        target: LevelTarget,
    ): Promise<KnowledgeSaveResult> {
        if (targets.length === 0) {
            throw new CommandError(
                'INVALID_INPUT',
                "Name who follows it: 'main-review' or an agent.",
            );
        }
        const { ctx, view } = await this.load(target);
        const item = requireKnowledgeItem(path);
        const existing = view.knowledge.find(
            (entry) => entry.path === item.path,
        );
        if (!existing && !linked) {
            throw new CommandError(
                'INVALID_INPUT',
                `'${item.path}' is not added here. Added: ${view.knowledge.map((entry) => entry.path).join(', ') || 'none'}.`,
            );
        }
        const key = existing ?? item;
        let next = view.knowledge;
        for (const ref of targets) {
            next = setKnowledgeLink(
                next,
                key,
                resolveKnowledgeTarget(ref, view.effectiveAgents),
                linked,
            );
        }
        return this.saveKnowledge(ctx, view, next);
    }
}

export const customAgentsService = new CustomAgentsService();

/** The line a Try result opens with (try-run.ts `tryResultHeadline`). */
export function tryResultHeadline(trace: CustomAgentTryTrace): string {
    const kept = trace.findings.filter((finding) => finding.verdict === 'kept');
    const wouldPost = kept.filter((finding) => finding.wouldPost).length;
    const counts = `${trace.findings.length} findings · ${kept.length} kept · ${wouldPost} would post`;
    switch (trace.status) {
        case 'completed':
            return counts;
        case 'incomplete':
            return `Stopped early${trace.reason ? ` · ${trace.reason}` : ''} · ${counts}`;
        case 'skipped':
            return `Skipped${trace.reason ? ` · ${trace.reason}` : ''}`;
        default:
            return `Failed${trace.reason ? ` · ${trace.reason}` : ''}`;
    }
}

/** "Runs on src/** · 3 PRs · 5 posted in 30 days" (drafts.ts `agentStatusLine`). */
export function agentStatusLine(
    agent: Pick<CustomAgent, 'scope' | 'enabled'>,
    status: CustomAgentStatus | undefined,
    windowDays: number | undefined,
    perRepository: boolean,
    usageUnavailable = false,
): string {
    const include = agent.scope?.include?.filter(Boolean) ?? [];
    const exclude = agent.scope?.exclude?.filter(Boolean) ?? [];
    const scope = `${include.length ? include.join(', ') : 'all files'}${exclude.length ? ` except ${exclude.join(', ')}` : ''}`;
    const where =
        agent.enabled === false
            ? `Off: reviews don't run it · would run on ${scope}`
            : `Runs on ${scope}`;
    if (!perRepository) {
        return where;
    }
    if (usageUnavailable) {
        return `${where} · usage unavailable right now`;
    }
    const days = windowDays ?? 30;
    if (!status || status.pullRequests === 0) {
        return `${where} · no findings in ${days} days`;
    }
    return `${where} · ${status.pullRequests} PR${status.pullRequests === 1 ? '' : 's'} · ${status.posted} posted in ${days} days`;
}
