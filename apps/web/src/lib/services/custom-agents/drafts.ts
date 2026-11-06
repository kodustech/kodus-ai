import {
    KNOWLEDGE_MAIN_REVIEW_TARGET,
    type CliToolConfig,
    type CliToolSecret,
    type CustomAgent,
    type CustomAgentResolveReport,
    type CustomAgentStatus,
    type KnowledgeCandidate,
    type KnowledgeItem,
    type KnowledgeLinkTarget,
    type KnowledgeTargetBudget,
} from "./types";

/** Mirrors CUSTOM_AGENT_LIMITS on the backend. */
export const CUSTOM_AGENT_LIMITS = {
    maxCliTools: 3,
    maxSkills: 20,
    maxDocs: 10,
    maxDocTokens: 20000,
    maxInstructionsLength: 8000,
    maxWritingLength: 2000,
} as const;

/**
 * Mirrors `astGrepRulesPath` on the backend: a single line naming a
 * `.yml`/`.yaml` file is the path of a rule file in the repository; anything
 * else is the rule YAML itself.
 */
export const astGrepRulesPath = (value?: string): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed || /\s/.test(trimmed)) return undefined;
    return /^[^:#'"{}[\]]+\.ya?ml$/i.test(trimmed) ? trimmed : undefined;
};

/** The hint under the ast-grep rules field. */
export const astGrepHint = (
    value?: string,
    report?: Pick<CustomAgentResolveReport, "astGrep">,
): string => {
    const path = astGrepRulesPath(value);
    const count = report?.astGrep.ruleCount ?? 0;
    const ids = report?.astGrep.ruleIds.join(", ") ?? "";
    const proof = "A rule match is proof; it needs no model check.";
    if (path) {
        const where =
            "Read from the pull request's target branch, so a pull request cannot change the rules it is checked against.";
        return count
            ? `${count} ${count === 1 ? "rule" : "rules"} in ${path}: ${ids}. ${where} ${proof}`
            : `Rules in ${path}. ${where}`;
    }
    if (count) {
        return `${count} ${count === 1 ? "rule" : "rules"}: ${ids}. ${proof}`;
    }
    return "Rule YAML, or the path of a rule file in the repository (read from the pull request's target branch). A match counts as proof.";
};

/** A package spec pinned to an exact version or digest, matched whole. */
const PINNED_SPEC =
    /^(?:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._/-]*@(?:v?\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?|sha256:[a-f0-9]{64})|[a-z0-9][a-z0-9._-]*(?:\[[a-z0-9,._-]+\])?===?\d+\.\d+\.\d+[0-9a-z.]*)$/i;

/** Words before the package specs: the installer and its install verb(s). */
const INSTALL_VERBS = new Set(["install", "i", "add", "global", "tool", "pip"]);

/**
 * Mirrors `checkCliInstallCommand` on the backend closely enough to warn
 * while editing: every package the command names must be pinned. The server
 * stays the authority.
 */
export const isPinnedInstall = (install: string): boolean => {
    if (/[;&|<>`$\\(){}'"*?!~#^]/.test(install)) return false;
    const [, ...rest] = install.trim().split(/\s+/);
    const specs = rest
        .filter((token) => !token.startsWith("-"))
        .filter(
            (token, index, all) =>
                !all.slice(0, index + 1).every((t) => INSTALL_VERBS.has(t)),
        );
    return specs.length > 0 && specs.every((spec) => PINNED_SPEC.test(spec));
};

export const CLI_SECRET_ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** The mask a read returns in place of a stored secret. */
export const CLI_SECRET_MASK = "••••";

export const TAG_COLORS = [
    "#6366f1",
    "#0ea5e9",
    "#10b981",
    "#f59e0b",
    "#ef4444",
    "#a855f7",
] as const;

export type CustomAgentTemplateId =
    | "architecture"
    | "e2e-coverage"
    | "regression-hallucination"
    | "security"
    | "blank";

export type CustomAgentTemplate = {
    id: CustomAgentTemplateId;
    name: string;
    description: string;
    color: string;
    include?: string[];
    instructions: string;
};

export const CUSTOM_AGENT_TEMPLATES: CustomAgentTemplate[] = [
    {
        id: "architecture",
        name: "Architecture",
        description:
            "Layer boundaries, dependency direction and where new code belongs.",
        color: TAG_COLORS[0],
        instructions: [
            "Review the change against the architecture this repository already follows.",
            "Flag imports that cross a layer boundary the rest of the code respects, business logic placed in controllers or adapters, and new modules that duplicate one that already exists.",
            "Cite the file or doc that shows the existing pattern; do not flag style or naming.",
        ].join("\n"),
    },
    {
        id: "e2e-coverage",
        name: "E2E coverage",
        description:
            "User-facing changes that ship without an end-to-end test for the flow.",
        color: TAG_COLORS[1],
        instructions: [
            "For each user-facing behavior this pull request adds or changes, check whether an end-to-end test exercises it.",
            "Flag a changed flow with no test that reaches it, and a test that was edited so it no longer asserts the behavior it was named after.",
            "Name the flow and the test file you expected; do not ask for unit tests.",
        ].join("\n"),
    },
    {
        id: "regression-hallucination",
        name: "Regression & hallucination",
        description:
            "Behavior that silently changed, and calls to APIs that do not exist.",
        color: TAG_COLORS[3],
        instructions: [
            "Look for behavior the change alters without saying so: removed branches, changed defaults, swallowed errors, narrowed inputs.",
            "Check that every function, method, option and import the change calls exists in this repository or in the version of the dependency it pins; read the definition before flagging.",
            "Report only what you confirmed by reading the code.",
        ].join("\n"),
    },
    {
        id: "security",
        // Not "Security": Kody's own category has that name.
        name: "Security reviewer",
        description:
            "Injection, auth and tenant checks, secrets and unsafe input handling.",
        color: TAG_COLORS[4],
        instructions: [
            "Trace untrusted input from where it enters to where it is used: queries, shell, file paths, templates, redirects.",
            "Flag missing authorization or tenant checks on new endpoints, secrets in code or logs, and weakened validation.",
            "Show the path from source to sink for every finding.",
        ].join("\n"),
    },
    {
        id: "blank",
        name: "New agent",
        description: "Start from nothing and write your own instructions.",
        color: TAG_COLORS[5],
        instructions: "",
    },
];

const slugify = (value: string) =>
    value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "agent";

const uniqueId = (base: string, existing: Pick<CustomAgent, "id">[]) => {
    const taken = new Set(existing.map((agent) => agent.id));
    if (!taken.has(base)) return base;
    let index = 2;
    while (taken.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
};

/**
 * Mirrors `customAgentSlug` on the backend: the name as `@kody -v <slug>`
 * and run names spell it. Two agents with the same slug can't be told apart,
 * so the server refuses to save them.
 */
export const agentSlug = (name: string): string =>
    (name || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "agent";

/** `base`, or `base 2`, `base 3`… : the first whose slug no agent uses. */
const uniqueName = (base: string, existing: Pick<CustomAgent, "name">[]) => {
    const taken = new Set(existing.map((agent) => agentSlug(agent.name)));
    if (!taken.has(agentSlug(base))) return base;
    let index = 2;
    while (taken.has(agentSlug(`${base} ${index}`))) index += 1;
    return `${base} ${index}`;
};

/** Why `agent`'s name can't be saved next to `agents`; null when it can. */
export const agentNameError = (
    agent: Pick<CustomAgent, "id" | "name">,
    agents: Pick<CustomAgent, "id" | "name">[],
): string | null => {
    const slug = agentSlug(agent.name);
    const other = agents.find(
        (entry) => entry.id !== agent.id && agentSlug(entry.name) === slug,
    );
    if (!other) return null;
    return `Another agent, "${other.name}", already answers to @kody -v ${slug}. Choose a different name.`;
};

const blankAgent = (params: {
    id: string;
    name: string;
    color: string;
    instructions: string;
    include?: string[];
}): CustomAgent => ({
    id: params.id,
    name: params.name,
    // Starts off: the team sees what it would comment (Try it, `@kody -v`)
    // before it posts on every pull request (#2172).
    enabled: false,
    instructions: params.instructions,
    scope: params.include ? { include: params.include } : {},
    tools: {},
    presentation: {
        tag: { color: params.color },
        format: "inline",
        suggestedFix: "when-confident",
    },
});

/**
 * The first tag color no agent uses yet, so every agent's comments stay
 * distinguishable; once all are taken, colors repeat in order.
 */
export const nextTagColor = (
    existing: Array<Pick<CustomAgent, "presentation">>,
): string => {
    const used = new Set(
        existing.map((agent) => agent.presentation?.tag?.color),
    );
    return (
        TAG_COLORS.find((color) => !used.has(color)) ??
        TAG_COLORS[existing.length % TAG_COLORS.length]
    );
};

export const createAgentFromTemplate = (
    templateId: CustomAgentTemplateId,
    existing: CustomAgent[],
): CustomAgent => {
    const template =
        CUSTOM_AGENT_TEMPLATES.find((item) => item.id === templateId) ??
        CUSTOM_AGENT_TEMPLATES[CUSTOM_AGENT_TEMPLATES.length - 1];
    const taken = existing.some(
        (agent) => agent.presentation.tag.color === template.color,
    );
    const name = uniqueName(template.name, existing);
    return blankAgent({
        // A blank agent's id follows its name ("new-agent"), so its page URL
        // reads like the agent; a template's id names the template.
        id: uniqueId(
            template.id === "blank" ? slugify(name) : template.id,
            existing,
        ),
        name,
        color: taken ? nextTagColor(existing) : template.color,
        instructions: template.instructions,
        include: template.include,
    });
};

/** Skill names usually start with what the skill does, not what it is. */
const LEADING_VERBS = new Set([
    "create",
    "write",
    "add",
    "review",
    "check",
    "make",
    "build",
    "use",
]);

const ACRONYMS = new Set([
    "e2e",
    "api",
    "apis",
    "sql",
    "ui",
    "ux",
    "cli",
    "css",
    "html",
    "http",
    "json",
    "url",
    "sdk",
    "db",
    "ci",
    "pr",
    "jwt",
]);

/**
 * A skill's name as the reviewer that follows it: "create-e2e-tests"
 * becomes "E2E tests reviewer".
 */
export const reviewerName = (skillName: string): string => {
    let words = skillName
        .split(/[-_\s]+/)
        .map((word) => word.trim())
        .filter(Boolean);
    if (words.length > 1 && LEADING_VERBS.has(words[0].toLowerCase())) {
        words = words.slice(1);
    }
    if (words.at(-1)?.toLowerCase() === "reviewer") words = words.slice(0, -1);
    if (!words.length) return "Imported reviewer";
    const cased = words.map((word, index) => {
        const lower = word.toLowerCase();
        if (ACRONYMS.has(lower)) return lower.toUpperCase();
        return index === 0
            ? lower.charAt(0).toUpperCase() + lower.slice(1)
            : lower;
    });
    return `${cased.join(" ")} reviewer`;
};

/**
 * A skill found in the repository, turned into an agent that loads it.
 * The skill stays on the branch; the agent only links to it.
 */
export const agentFromSkill = (
    candidate: KnowledgeCandidate,
    existing: CustomAgent[],
): { agent: CustomAgent; link: KnowledgeItem } => {
    const skillName = candidate.name ?? skillFolderName(candidate.path);
    const agent = blankAgent({
        id: uniqueId(slugify(skillName), existing),
        name: uniqueName(reviewerName(skillName), existing),
        color: nextTagColor(existing),
        instructions: `Review the change against the team's "${skillName}" skill: load it, follow its rules and references, and report where the change departs from them. Cite the rule you apply.`,
    });
    return {
        agent,
        link: {
            path: candidate.path,
            kind: candidate.kind,
            linkedTo: [{ agentId: agent.id }],
        },
    };
};

/**
 * The agents a repository skill is already linked to, so the import list can
 * say it was imported instead of offering it as new.
 */
export const agentsUsingSkill = (
    candidate: Pick<KnowledgeCandidate, "path">,
    knowledge: KnowledgeItem[],
    agents: Pick<CustomAgent, "id" | "name">[],
): Pick<CustomAgent, "id" | "name">[] => {
    const key = (path: string) =>
        normalizeKnowledgePath(path)
            .replace(/\/SKILL\.md$/, "")
            .replace(/\/+$/, "");
    const ids = new Set(
        knowledge
            .filter(
                (item) =>
                    item.kind === "skill" &&
                    key(item.path) === key(candidate.path),
            )
            .flatMap((item) => item.linkedTo)
            .flatMap((target) =>
                typeof target === "object" ? [target.agentId] : [],
            ),
    );
    return agents.filter((agent) => ids.has(agent.id));
};

/** The native review categories a custom agent's name can be mistaken for. */
const NATIVE_CATEGORIES = ["Bug", "Performance", "Security", "Business Logic"];

/** A hint when the name repeats a native category; null when it doesn't. */
export const nameCollisionHint = (name: string): string | null => {
    const category = NATIVE_CATEGORIES.find(
        (entry) => entry.toLowerCase() === name.trim().toLowerCase(),
    );
    if (!category) return null;
    return `Kody already has a ${category} category; a distinct name (e.g. ${category} reviewer) tells their comments apart.`;
};

export const describeAgent = (agent: Pick<CustomAgent, "instructions">) => {
    const line = (agent.instructions ?? "")
        .split("\n")
        .map((text) => text.replace(/^#+\s*/, "").trim())
        .find(Boolean);
    if (!line) return "No instructions yet";
    return line.length > 140 ? `${line.slice(0, 137)}…` : line;
};

/** "9 PRs · 15 posted · 30 days": what the agent did lately, for its row. */
export const agentUsageLine = (
    status: CustomAgentStatus | undefined,
    windowDays: number,
) => {
    if (!status || status.pullRequests === 0) {
        return `No findings in ${windowDays} days`;
    }
    return [
        `${status.pullRequests} ${status.pullRequests === 1 ? "PR" : "PRs"}`,
        `${status.posted} posted`,
        `${windowDays} days`,
    ].join(" · ");
};

type KnowledgeIdentity = Pick<KnowledgeItem, "path" | "kind" | "repository">;

/** The repository an item names, in lower case; "" for the reviewed one.
 *  Stored config can carry a non-text value, which names no repository. */
export const repositoryKey = (item: { repository?: unknown }) =>
    typeof item.repository === "string" ? item.repository.toLowerCase() : "";

/** One skill or doc is the same entry when its repository, path and kind
 *  match: the same path in two repositories is two entries. */
export const sameKnowledge = (a: KnowledgeIdentity, b: KnowledgeIdentity) =>
    a.path === b.path &&
    a.kind === b.kind &&
    repositoryKey(a) === repositoryKey(b);

/** How a skill or doc is named once read: its path, or `owner/repo:path`. */
export const knowledgeSourcePath = (
    item: Pick<KnowledgeItem, "path" | "repository">,
) => (item.repository ? `${item.repository}:${item.path}` : item.path);

/** Stable key for lists: kind, repository and path. */
/** One key per skill or doc, as sameKnowledge compares: the repository in
 *  any case. */
export const knowledgeKey = (item: KnowledgeIdentity) =>
    `${item.kind}:${knowledgeSourcePath({
        ...item,
        repository: repositoryKey(item) || undefined,
    })}`;

const sameTarget = (a: KnowledgeLinkTarget, b: KnowledgeLinkTarget) =>
    typeof a === "string" || typeof b === "string"
        ? a === b
        : a.agentId === b.agentId;

export const isLinked = (
    item: Pick<KnowledgeItem, "linkedTo"> | undefined,
    target: KnowledgeLinkTarget,
) => !!item?.linkedTo.some((entry) => sameTarget(entry, target));

/**
 * Drops an agent and its links to skills and docs. The items themselves stay
 * registered, like `setKnowledgeLink` leaves them, for the main review or
 * another agent to keep following. At a directory, an agent that replaced an
 * inherited one (same id) gives way to it again, so its links stay: they now
 * apply to the inherited agent.
 */
export const withoutAgent = (
    agents: CustomAgent[],
    knowledge: KnowledgeItem[],
    agentId: string,
    inherited: CustomAgent[],
): { agents: CustomAgent[]; knowledge: KnowledgeItem[] } => ({
    agents: agents.filter((agent) => agent.id !== agentId),
    knowledge: inherited.some((agent) => agent.id === agentId)
        ? knowledge
        : knowledge.map((item) => ({
              ...item,
              linkedTo: item.linkedTo.filter(
                  (target) =>
                      typeof target === "string" || target.agentId !== agentId,
              ),
          })),
});

/** What deleting an agent leaves behind, for the confirm dialog. */
export const deleteAgentNote = (agentId: string, inherited: CustomAgent[]) => {
    const restored = inherited.find((agent) => agent.id === agentId);
    return restored
        ? `The repository's ${restored.name || "agent"} runs here again, with the skills and docs this directory links to it. Its findings stay on past pull requests.`
        : "Its findings stay on past pull requests.";
};

/** Mirrors `knowledgeTargetKey` on the backend: how a budget names its target. */
export const knowledgeTargetKey = (target: KnowledgeLinkTarget): string =>
    typeof target === "string" ? target : `agent:${target.agentId}`;

export const KNOWLEDGE_LIMIT_LABELS: Record<
    KnowledgeTargetBudget["over"][number],
    string
> = {
    skills: "skills",
    docs: "docs",
    docTokens: "doc tokens",
};

/**
 * What a target over its skills and docs limits is told, by the name the
 * page shows it with: the main review, or the agent's name.
 */
export const knowledgeBudgetNote = (
    budget: KnowledgeTargetBudget,
    agents: Pick<CustomAgent, "id" | "name">[],
): string => {
    const name =
        budget.target === KNOWLEDGE_MAIN_REVIEW_TARGET
            ? "Main review"
            : (agents.find(
                  (agent) =>
                      knowledgeTargetKey({ agentId: agent.id }) ===
                      budget.target,
              )?.name ?? "An agent");
    return `${name} is over its limit (${budget.over
        .map((limit) => KNOWLEDGE_LIMIT_LABELS[limit])
        .join(
            ", ",
        )}): up to ${CUSTOM_AGENT_LIMITS.maxSkills} skills, ${CUSTOM_AGENT_LIMITS.maxDocs} docs and ${CUSTOM_AGENT_LIMITS.maxDocTokens.toLocaleString()} doc tokens.`;
};

/**
 * Links or unlinks one skill or doc. An item stays registered with no links,
 * so the Skills & docs page keeps listing it.
 */
export const setKnowledgeLink = (
    knowledge: KnowledgeItem[],
    item: Pick<KnowledgeItem, "path" | "kind" | "repository" | "ref">,
    target: KnowledgeLinkTarget,
    linked: boolean,
): KnowledgeItem[] => {
    const index = knowledge.findIndex((entry) => sameKnowledge(entry, item));
    const current: KnowledgeItem =
        index >= 0
            ? knowledge[index]
            : {
                  path: item.path,
                  kind: item.kind,
                  ...(item.repository && { repository: item.repository }),
                  ...(item.repository && item.ref && { ref: item.ref }),
                  linkedTo: [],
              };
    const others = current.linkedTo.filter(
        (entry) => !sameTarget(entry, target),
    );
    const next: KnowledgeItem = {
        ...current,
        linkedTo: linked ? [...others, target] : others,
    };
    if (index < 0) return [...knowledge, next];
    return knowledge.map((entry, position) =>
        position === index ? next : entry,
    );
};

/** A path as the config stores it: trimmed, relative to the repository. */
export const normalizeKnowledgePath = (path: string) =>
    path.trim().replace(/^\/+/, "");

/** A skill's folder name, from its folder path or its SKILL.md path. */
export const skillFolderName = (path: string) =>
    path
        .split("/")
        .filter(Boolean)
        .filter((segment) => segment !== "SKILL.md")
        .pop() ?? path;

/**
 * A path typed by hand, as the item it names: a file with an extension is
 * a doc; a folder, or a SKILL.md inside one, is a skill (stored as its
 * folder).
 */
export const knowledgeItemFromPath = (
    input: string,
): Pick<KnowledgeItem, "path" | "kind"> | null => {
    const path = normalizeKnowledgePath(input).replace(/\/+$/, "");
    if (!path) return null;
    if (/(^|\/)SKILL\.md$/.test(path)) {
        const folder = path.replace(/\/?SKILL\.md$/, "");
        return folder ? { path: folder, kind: "skill" } : null;
    }
    const last = path.split("/").pop() ?? "";
    return /^[^.].*\.[a-z0-9]+$/i.test(last)
        ? { path, kind: "doc" }
        : { path, kind: "skill" };
};

type NamedKnowledge = KnowledgeIdentity & { name?: string };

/** What one agent follows, skills first, each with the name it shows. */
export const followedBy = (
    knowledge: KnowledgeItem[],
    agentId: string,
    named: NamedKnowledge[] = [],
) => {
    const linked = knowledge.filter((item) => isLinked(item, { agentId }));
    // Keyed as sameKnowledge compares: the repository in any case.
    const keyOf = (item: KnowledgeIdentity) =>
        `${item.kind}:${repositoryKey(item)}:${item.path}`;
    const names = new Map<string, string | undefined>();
    for (const entry of named) {
        if (!names.has(keyOf(entry))) names.set(keyOf(entry), entry.name);
    }
    const nameOf = (item: KnowledgeItem) =>
        names.get(keyOf(item)) ??
        (item.kind === "skill" ? skillFolderName(item.path) : item.path);
    return {
        skills: linked
            .filter((item) => item.kind === "skill")
            .map((item) => ({ ...item, name: nameOf(item) })),
        docs: linked
            .filter((item) => item.kind === "doc")
            .map((item) => ({ ...item, name: nameOf(item) })),
    };
};

const plural = (count: number, word: string) =>
    `${count} ${count === 1 ? word : `${word}s`}`;

/** The files an agent runs on, in a few words: "src/payments/** except **\/*.test.ts". */
export const scopeLabel = (agent: Pick<CustomAgent, "scope">): string => {
    const include = agent.scope.include?.filter(Boolean) ?? [];
    const exclude = agent.scope.exclude?.filter(Boolean) ?? [];
    return [
        include.length ? include.join(", ") : "all files",
        exclude.length ? ` except ${exclude.join(", ")}` : "",
    ].join("");
};

/**
 * The agent page's one status line: where it runs and what it did lately,
 * "Runs on src/payments/** · 9 PRs · 15 posted in 30 days".
 */
export const agentStatusLine = (
    agent: Pick<CustomAgent, "scope" | "enabled">,
    status: CustomAgentStatus | undefined,
    windowDays: number,
    isGlobal = false,
): string => {
    // An agent starts off: say reviews skip it, not where it runs.
    const where =
        agent.enabled === false
            ? `Off: reviews don't run it · would run on ${scopeLabel(agent)}`
            : `Runs on ${scopeLabel(agent)}`;
    // Usage is counted per repository.
    if (isGlobal) return where;
    const failed = status?.health?.failedPullRequests ?? 0;
    const failedNote = failed ? ` · failed on ${plural(failed, "PR")}` : "";
    if (!status || status.pullRequests === 0) {
        // Runs that all failed left no finding: say so instead of "nothing
        // to report", which reads the same as a healthy quiet agent.
        return status?.health?.runs
            ? `${where} · ${plural(status.health.runs, "run")}, nothing posted${failedNote} in ${windowDays} days`
            : `${where} · no findings in ${windowDays} days`;
    }
    return `${where} · ${plural(status.pullRequests, "PR")} · ${status.posted} posted${failedNote} in ${windowDays} days`;
};

/** What fixes a failing agent: its model, or the AI provider's account. */
export type RunProblemAction = "model" | "providers";

const RUN_PROBLEMS: Array<{
    match: RegExp;
    detail: string;
    action?: RunProblemAction;
}> = [
    {
        match: /^MODEL_NOT_FOUND\b/,
        detail: "The model it is set to no longer exists on your AI provider.",
        action: "model",
    },
    {
        match: /^MODEL_ACCESS_DENIED\b/,
        detail: "Your AI provider account can't use the model it is set to.",
        action: "model",
    },
    {
        match: /^CONTEXT_OVERFLOW\b/,
        detail: "The model's context window is too small for this agent.",
        action: "model",
    },
    {
        match: /^AUTH_INVALID\b/,
        detail: "Your AI provider rejected the key.",
        action: "providers",
    },
    {
        match: /^QUOTA_EXCEEDED\b/,
        detail: "Your AI provider account is out of credits or over its limit.",
        action: "providers",
    },
    {
        match: /^RATE_LIMIT\b/,
        detail: "Your AI provider rate-limited the runs.",
        action: "providers",
    },
    {
        match: /^TRANSIENT\b/,
        detail: "Your AI provider was unavailable. The next review tries again.",
    },
    {
        match: /^max-steps$/,
        detail: "It hit its step limit before finishing. Narrower files or instructions help.",
    },
    {
        match: /^truncated$/,
        detail: "The model's answer was cut off.",
        action: "model",
    },
    {
        match: /^no-result$/,
        detail: "It finished without reporting its findings.",
    },
];

/**
 * What the agent page says when the newest runs did not finish: how many in
 * a row, why, and what fixes it. Nothing once the newest run finished.
 */
export const runProblem = (
    health: CustomAgentStatus["health"],
): {
    tone: "danger" | "warning";
    title: string;
    detail: string;
    action?: RunProblemAction;
} | null => {
    if (!health || health.streak === 0 || health.last.status === "ran") {
        return null;
    }
    const failed = health.last.status === "failed";
    const runs =
        health.streak === 1 ? "The last run" : `The last ${health.streak} runs`;
    const known = RUN_PROBLEMS.find((p) =>
        p.match.test(health.last.reason ?? ""),
    );
    return {
        tone: failed ? "danger" : "warning",
        title: `${runs} ${failed ? "failed" : "stopped before finishing"}`,
        detail:
            known?.detail ??
            (failed
                ? "The run failed before posting anything."
                : "It stopped before finishing."),
        ...(known?.action && { action: known.action }),
    };
};

/** Guide files and skill folders a cited path can name. */
const citedKnowledge = (
    path: string,
    repository?: string,
): KnowledgeIdentity => {
    const skill = /^(.*)\/SKILL\.md$/i.exec(path);
    return {
        path: skill ? skill[1] : path,
        kind: skill ? "skill" : "doc",
        ...(repository && { repository }),
    };
};

/**
 * The skills and docs a file a finding cited can be, most likely first:
 * `owner/repo:path` names one; `repo/path` or `owner/repo/path` names a file
 * of that repository; a bare path is this repository's, else one of the
 * repositories its skills and docs come from. The check of each candidate
 * decides which one exists.
 */
export const citationCandidates = (
    file: string,
    repositories: string[],
): KnowledgeIdentity[] => {
    const cited = file.replace(/^\/+/, "");
    const qualified = /^([^:\s]+\/[^:\s]+):(.+)$/.exec(cited);
    if (qualified) return [citedKnowledge(qualified[2], qualified[1])];
    const prefixed = repositories.flatMap((repository) => {
        const full = `${repository.toLowerCase()}/`;
        const name = `${(repository.split("/").pop() ?? "").toLowerCase()}/`;
        const lower = cited.toLowerCase();
        if (lower.startsWith(full)) {
            return [citedKnowledge(cited.slice(full.length), repository)];
        }
        if (name !== "/" && lower.startsWith(name)) {
            return [citedKnowledge(cited.slice(name.length), repository)];
        }
        return [];
    });
    return [
        ...prefixed,
        citedKnowledge(cited),
        ...repositories.map((repository) => citedKnowledge(cited, repository)),
    ];
};

const PLUGIN_NAMES_BY_ID: Record<string, string> = {
    "kodus-issues-default": "Git Issues",
};

/**
 * A readable plugin name when its connection is not listed (unreachable, or
 * not loaded yet): the built-in ids read as words (`linear-default` →
 * "Linear"); an opaque id reads as "Plugin" rather than leaking into the row.
 */
const pluginNameFromId = (integrationId: string): string => {
    if (PLUGIN_NAMES_BY_ID[integrationId]) {
        return PLUGIN_NAMES_BY_ID[integrationId];
    }
    const match = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)-default$/.exec(
        integrationId,
    );
    if (!match) return "Plugin";
    return match[1]
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
};

/**
 * Short chips for an agent's row in the list: the files it runs on, what it
 * follows and the tools it has. Never the instructions, never a raw id.
 */
export const agentChips = (
    agent: Pick<CustomAgent, "id" | "scope" | "tools">,
    knowledge: KnowledgeItem[],
    names: { pluginName?: (integrationId: string) => string | undefined } = {},
): string[] => {
    const include = agent.scope.include?.filter(Boolean) ?? [];
    const { skills, docs } = followedBy(knowledge, agent.id);
    return [
        include.length
            ? `${include[0]}${include.length > 1 ? ` +${include.length - 1}` : ""}`
            : "All files",
        skills.length ? plural(skills.length, "skill") : "",
        docs.length ? plural(docs.length, "doc") : "",
        ...(agent.tools.mcp ?? []).map(
            (plugin) =>
                names.pluginName?.(plugin.integrationId) ??
                pluginNameFromId(plugin.integrationId),
        ),
        ...(agent.tools.cli ?? []).map((cli) => `${cli.name || "Unnamed"} CLI`),
        agent.tools.astGrepConfig?.trim() ? "ast-grep" : "",
    ].filter(Boolean);
};

/**
 * Turns one skill or doc on or off for an agent, from the agent itself:
 * turning it on registers the file when the config did not have it, and
 * turning it off drops the file once nothing follows it any more.
 */
export const setAgentKnowledge = (
    knowledge: KnowledgeItem[],
    item: Pick<KnowledgeItem, "path" | "kind" | "repository" | "ref">,
    agentId: string,
    on: boolean,
): KnowledgeItem[] => {
    const next = setKnowledgeLink(knowledge, item, { agentId }, on);
    if (on) return next;
    return next.filter(
        (entry) => entry.linkedTo.length > 0 || !sameKnowledge(entry, item),
    );
};

export type KnowledgeChoice = {
    path: string;
    kind: KnowledgeItem["kind"];
    repository?: string;
    ref?: string;
    name?: string;
    linked: boolean;
    kodyRuleSource: boolean;
};

/**
 * Every skill and doc an agent can follow: what the config already has, then
 * what was found on the branch and is not in the config yet.
 */
export const knowledgeChoices = (
    knowledge: KnowledgeItem[],
    candidates: KnowledgeCandidate[],
    agentId: string,
): KnowledgeChoice[] => {
    // Keyed as sameKnowledge compares: the repository in any case.
    const keyOf = (item: KnowledgeIdentity) =>
        `${item.kind}:${repositoryKey(item)}:${item.path}`;
    const byKey = new Map<string, KnowledgeCandidate>();
    for (const candidate of candidates) {
        if (!byKey.has(keyOf(candidate)))
            byKey.set(keyOf(candidate), candidate);
    }
    const found = (item: KnowledgeIdentity) => byKey.get(keyOf(item));
    const registered = knowledge.map((item) => ({
        path: item.path,
        kind: item.kind,
        ...(item.repository && { repository: item.repository }),
        ...(item.ref && { ref: item.ref }),
        name: found(item)?.name,
        linked: isLinked(item, { agentId }),
        kodyRuleSource: found(item)?.kodyRuleSource ?? false,
    }));
    const taken = new Set(knowledge.map(knowledgeKey));
    const discovered = candidates
        // The first candidate of each key, which byKey kept.
        .filter(
            (candidate) =>
                !taken.has(knowledgeKey(candidate)) &&
                byKey.get(keyOf(candidate)) === candidate,
        )
        .map((candidate) => ({
            path: candidate.path,
            kind: candidate.kind,
            ...(candidate.repository && { repository: candidate.repository }),
            ...(candidate.ref && { ref: candidate.ref }),
            name: candidate.name,
            linked: false,
            kodyRuleSource: candidate.kodyRuleSource,
        }));
    return [...registered, ...discovered];
};

/** Problems the server would reject, shown while the CLI is edited. */
export const cliIssues = (cli: CliToolConfig): string[] => {
    const issues: string[] = [];
    if (!cli.name.trim()) issues.push("Name the CLI");
    if (!cli.binary.trim()) issues.push("Set the binary the agent calls");
    if (!isPinnedInstall(cli.install)) {
        issues.push("Pin the install to a version, e.g. tool@1.2.3");
    }
    if (!cli.allowedPrefixes.filter((prefix) => prefix.trim()).length) {
        issues.push("Add at least one allowed command prefix");
    }
    const binaryOnly = cli.allowedPrefixes.some((prefix) => {
        const tokens = prefix.trim().split(/\s+/);
        return (
            tokens.length === 1 &&
            (tokens[0] === cli.binary || tokens[0] === cli.name)
        );
    });
    if (binaryOnly) {
        issues.push(
            `A prefix names a subcommand or flag after the binary, e.g. ${cli.binary || "tool"} check`,
        );
    }
    const secrets = cli.secrets ?? [];
    if (cli.runsProjectCode && secrets.length) {
        issues.push("A CLI that runs project code never receives secrets");
    }
    if (secrets.some((secret) => !CLI_SECRET_ENV_PATTERN.test(secret.env))) {
        issues.push("Secret names are env variables, e.g. LEDGER_TOKEN");
    }
    if (secrets.length && !cli.runsProjectCode) {
        if (ENV_EXPOSING_BINARIES.has(cli.binary.trim().toLowerCase())) {
            issues.push(
                "A CLI with secrets cannot be a shell or interpreter: name its own binary",
            );
        }
        if (cli.allowedPrefixes.some(prefixExposesEnv)) {
            issues.push(
                "A CLI with secrets cannot allow env listings or token-printing commands",
            );
        }
    }
    return issues;
};

// Mirrors the server's rule (libs/core/.../cli-env-guard.ts): with secrets,
// nothing configured may list the env or print a stored token.
const ENV_LISTING_WORDS = new Set([
    "printenv",
    "env",
    "set",
    "export",
    "declare",
    "typeset",
    "environ",
]);
const TOKEN_PRINTING_SEQUENCES = [
    ["auth", "token"],
    ["auth:token"],
    ["--show-token"],
    ["auth", "status", "-t"],
    ["config", "get"],
    ["configure", "get"],
    ["print-access-token"],
    ["print-identity-token"],
    ["get-access-token"],
];
const ENV_EXPOSING_BINARIES = new Set([
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "busybox",
    "env",
    "printenv",
    "node",
    "nodejs",
    "deno",
    "bun",
    "bunx",
    "npx",
    "pnpx",
    "python",
    "python2",
    "python3",
    "perl",
    "ruby",
    "php",
    "awk",
    "gawk",
    "mawk",
    "xargs",
]);

const prefixExposesEnv = (prefix: string): boolean => {
    const tokens = prefix.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (
        tokens.some(
            (token) =>
                ENV_LISTING_WORDS.has(token) ||
                token.includes("/proc/") ||
                token === "/proc",
        )
    ) {
        return true;
    }
    return TOKEN_PRINTING_SEQUENCES.some((sequence) =>
        tokens.some((_, i) =>
            sequence.every((part, j) => tokens[i + j] === part),
        ),
    );
};

/**
 * The agents as the save endpoint takes them. A secret is sent either as
 * the mask it was read with (keep the stored value) or as a typed value; a
 * secret left blank after "Replace" has neither and is dropped.
 */
export const prepareAgentsForSave = (agents: CustomAgent[]): CustomAgent[] =>
    agents.map((agent) => {
        if (!agent.tools.cli?.length) return agent;
        return {
            ...agent,
            tools: {
                ...agent.tools,
                cli: agent.tools.cli.map((tool) => ({
                    ...tool,
                    allowedPrefixes: tool.allowedPrefixes
                        .map((prefix) => prefix.trim())
                        .filter(Boolean),
                    secrets: (tool.secrets ?? []).flatMap(
                        (secret): CliToolSecret[] =>
                            secret.value
                                ? [{ env: secret.env, value: secret.value }]
                                : secret.ciphertext
                                  ? [
                                        {
                                            env: secret.env,
                                            ciphertext: secret.ciphertext,
                                        },
                                    ]
                                  : [],
                    ),
                })),
            },
        };
    });

/**
 * The agent for the draft check, which only needs to know a secret exists:
 * typed values become the mask and never leave the screen.
 */
/** A knowledge item as the config stores it: no display fields. */
export const prepareKnowledgeForSave = (
    knowledge: KnowledgeItem[],
): KnowledgeItem[] =>
    knowledge.map(({ path, kind, repository, ref, linkedTo }) => ({
        path,
        kind,
        ...(repository && { repository }),
        ...(repository && ref && { ref }),
        linkedTo,
    }));

/**
 * Repositories the agent's instructions name (as `owner/repo` or by the
 * repository's name alone) that it follows no skill or doc from. A team that
 * writes "read the rules in our rules repository" usually means those rules
 * to back its findings, and a finding can only cite what the agent follows.
 */
export const mentionedButNotFollowed = (
    instructions: string,
    repositories: string[],
    knowledge: KnowledgeItem[],
    agentId: string,
): string[] => {
    const text = instructions.toLowerCase();
    const followed = new Set(
        knowledge
            .filter((item) => item.repository && isLinked(item, { agentId }))
            .map((item) => item.repository!.toLowerCase()),
    );
    return repositories.filter((repository) => {
        const full = repository.toLowerCase();
        const name = full.split("/").pop() ?? full;
        const named =
            text.includes(full) ||
            new RegExp(
                `(^|[^a-z0-9_.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9_-])`,
            ).test(text);
        return named && !followed.has(full);
    });
};

/** A file the instructions name, as the item that would follow it. */
export type MentionedFile = Pick<KnowledgeItem, "path" | "kind" | "repository">;

/** A text file named in prose: `rules/x.mdc`, `CLAUDE.md`, never a URL or a
 *  code file (instructions name code to look at, not rules to follow). */
const MENTIONED_FILE =
    /(?:^|[\s`'"([<])((?:[\w.-]+\/)*[\w.-]+\.(?:mdc|mdx|md|markdown))(?=$|[\s`'".,;:!?)\]>])/gi;

/** A phrase that names where a file lives: a named repository after "in",
 *  "from"… ("in the pump-rules repository", "from our rules repo"), the
 *  Portuguese "no repositório X", "repository owner/name", or an
 *  `owner/name` (a URL too) after "in", "from"… ("in acme/rules"). */
const REPOSITORY_PLACE = new RegExp(
    [
        String.raw`\b(?:in|from|on|at|inside|under)\s+(?:(?:the|our|a|their|its|this)\s+)?(?:(?!(?:the|our|a|their|its|this)\b)[\x60'"]?[\w./-]+[\x60'"]?\s+){1,4}(?:repo|repository)\b`,
        String.raw`\b(?:no|na|do|da|em)\s+(?:nosso\s+|o\s+)?reposit[óo]rio\s+[\x60'"]?[\w./-]+`,
        String.raw`\b(?:repo|repository|reposit[óo]rio)\s+[\x60'"]?[\w.-]+\/[\w./-]+`,
        String.raw`\b(?:in|from|on|at|inside|under)\s+(?:the\s+)?[\x60'"]?(?:https?:\/\/[\w.-]+\/)?[\w.-]+\/[\w.-]+(?![\w/-])`,
    ].join("|"),
    "gi",
);

/** Files a repository has that are never a rule to follow. */
const NOT_A_RULE_FILE =
    /^(readme|changelog|changes|history|license|licence|notice|authors|contributors)\.(md|mdx|markdown)$/i;

/** Where each sentence ends: a mark before whitespace or the end of the
 *  text (the dot in "a.md" ends nothing), or a blank line (a wrapped line
 *  does not end one). A repository named in a file's sentence says where
 *  the file lives ("in the pump-rules repository"); one in another sentence
 *  is about something else ("use the repository pattern"). */
const SENTENCE_END = /[.;!?](?=\s|$)|\r?\n[ \t]*\r?\n/g;

/** The sentence a position falls in, as an index over `ends`. */
const sentenceIndex = (ends: number[], position: number) => {
    let low = 0;
    let high = ends.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (ends[mid] <= position) low = mid + 1;
        else high = mid;
    }
    return low;
};

const escapeRegExp = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Text files the agent's instructions name that it does not follow, as the
 * item each would be: "read stack/rails/rules/performance-queries.mdc in our
 * rules repository" left to the agent's judgment whether it reads the file,
 * and a finding cannot cite a rule from a file the agent does not follow. A
 * followed doc goes into the agent's prompt whole (#2384).
 *
 * A file is placed by the most explicit place the text gives it: a path that
 * starts with a linked repository's full name, then a place phrase in its own
 * sentence ("in the pump-rules repository", "in acme/rules"), then a linked
 * repository its sentence names, then the linked repository named last before
 * it, and the reviewed repository when the instructions name none. A file
 * whose own place is not a linked repository is left out rather than guessed:
 * "Follow it" must never add a source other than the one the text names.
 */
export const mentionedFilesNotFollowed = (
    instructions: string,
    repositories: string[],
    knowledge: KnowledgeItem[],
    agentId: string,
): MentionedFile[] => {
    const text = instructions.toLowerCase();
    const files = [...instructions.matchAll(MENTIONED_FILE)].map((match) => {
        const at = (match.index ?? 0) + match[0].indexOf(match[1]);
        return { cited: match[1], at, end: at + match[1].length };
    });
    // A repository's name inside a file's path names no repository for the
    // files after it ("rules/api.md" is not a mention of `acme/rules`).
    const insideAFile = (at: number) =>
        files.some((file) => at >= file.at && at < file.end);
    const names = repositories.map((repository) => {
        const full = repository.toLowerCase();
        return { repository, full, name: full.split("/").pop() ?? full };
    });
    // A full name may follow a `/` (a URL); a bare name may not: in
    // "other/irrigation-rules" it is another owner's repository, not an
    // alias of the linked `greenhouse/irrigation-rules`.
    const mentions = names
        .flatMap(({ repository, full, name }) =>
            [
                new RegExp(
                    `(^|[^a-z0-9_.-])${escapeRegExp(full)}(?=$|[^a-z0-9_-])`,
                    "g",
                ),
                new RegExp(
                    `(^|[^a-z0-9_./-])${escapeRegExp(name)}(?=$|[^a-z0-9_/-])`,
                    "g",
                ),
            ].flatMap((pattern) =>
                [...text.matchAll(pattern)].map((match) => ({
                    repository,
                    at: (match.index ?? 0) + match[1].length,
                })),
            ),
        )
        .filter((mention) => !insideAFile(mention.at))
        .sort((a, b) => a.at - b.at);
    const byFullName = new Map(
        names.map(({ repository, full }) => [full, repository]),
    );
    const bareNames = new Set(names.map(({ name }) => name));
    const followed = new Set(
        knowledge
            .filter((entry) => isLinked(entry, { agentId }))
            .map(knowledgeKey),
    );
    const ends = [...text.matchAll(SENTENCE_END)].map(
        (mark) => (mark.index ?? 0) + mark[0].length,
    );
    const sentenceOf = (position: number) => sentenceIndex(ends, position);
    // `mentions` is sorted: the first one at or after a position, by halving.
    const firstMentionFrom = (position: number) => {
        let low = 0;
        let high = mentions.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (mentions[mid].at < position) low = mid + 1;
            else high = mid;
        }
        return low;
    };
    // Every place phrase, with the linked repository it names if any. A
    // phrase over a file's own path is the file, not a place ("the rules in
    // docs/rules.md"). One that crosses a sentence end places nothing ("in
    // full. Pump repository notes follow."), unless its own sentence already
    // names an owner/name place ("in acme/rules. Repository notes follow.").
    const places = [...text.matchAll(REPOSITORY_PLACE)].flatMap((place) => {
        const start = place.index ?? 0;
        let end = start + place[0].length;
        if (files.some((file) => file.at < end && file.end > start)) return [];
        const sentence = sentenceOf(start);
        if (sentenceOf(end - 1) !== sentence) {
            if (!text.slice(start, ends[sentence]).includes("/")) return [];
            end = ends[sentence];
        }
        const named = mentions[firstMentionFrom(start)];
        const repository =
            named && named.at < end ? named.repository : undefined;
        return [{ at: start, repository }];
    });
    // Places and linked mentions by sentence, built once for every file.
    const bySentence = <T extends { at: number }>(items: T[]) => {
        const map = new Map<number, T[]>();
        for (const item of items) {
            const sentence = sentenceOf(item.at);
            const group = map.get(sentence);
            if (group) group.push(item);
            else map.set(sentence, [item]);
        }
        return map;
    };
    const placesBySentence = bySentence(places);
    const mentionsBySentence = bySentence(mentions);
    // What follows a file and still belongs to it: "docs/b.md in the
    // pump-rules repository" (a place starts with its preposition), "docs/b.md
    // from irrigation-rules" (a mention after one).
    const PLACE_RIGHT_AFTER = /^[\s\x60'"),]*$/;
    const MENTION_RIGHT_AFTER =
        /^[\s\x60'"),]*(?:in|from|on|at|inside|under)\s+(?:the\s+)?[\x60'"]?$/;
    const rightAfter = <T extends { at: number }>(
        candidates: T[],
        end: number,
        between: RegExp,
    ) =>
        candidates.find(
            (candidate) =>
                candidate.at >= end &&
                between.test(text.slice(end, candidate.at)),
        );
    // Otherwise the last one before the file in its sentence ("In the
    // pump-rules repository, read docs/a.md"), else the first after it.
    const nearest = <T extends { at: number }>(candidates: T[], at: number) =>
        candidates.filter((candidate) => candidate.at < at).pop() ??
        candidates[0];
    const offered = new Set<string>();
    const found: MentionedFile[] = [];
    for (const { cited, at, end } of files) {
        const lower = cited.toLowerCase();
        // A path that starts with a linked repository's full name names it.
        // One that starts with its bare name is ambiguous ("rules/api.md"
        // may be the reviewed repository's own folder): nothing is offered.
        // The longest known prefix: a GitLab subgroup or an Azure project
        // makes a full name of more than two segments.
        const segments = lower.split("/");
        let owner: string | undefined;
        let prefixLength = 0;
        for (let n = segments.length - 1; n >= 2 && !owner; n--) {
            owner = byFullName.get(segments.slice(0, n).join("/"));
            prefixLength = owner ? n : 0;
        }
        if (!owner && segments.length > 1 && bareNames.has(segments[0])) {
            continue;
        }
        const prefixed = owner
            ? {
                  repository: owner,
                  rest: cited.split("/").slice(prefixLength).join("/"),
              }
            : null;
        const sentence = sentenceOf(at);
        const placesHere = placesBySentence.get(sentence) ?? [];
        const mentionsHere = mentionsBySentence.get(sentence) ?? [];
        const own =
            rightAfter(placesHere, end, PLACE_RIGHT_AFTER) ??
            rightAfter(mentionsHere, end, MENTION_RIGHT_AFTER);
        let repository: string | undefined;
        if (prefixed) {
            repository = prefixed.repository;
        } else if (own) {
            // What right follows the file says where it lives: there, or
            // nowhere when it names no linked repository.
            repository = own.repository;
            if (!repository) continue;
        } else if (placesHere.length) {
            // The sentence says where its files live: there, or nowhere.
            repository = nearest(placesHere, at).repository;
            if (!repository) continue;
        } else if (mentionsHere.length) {
            // "read x.mdc, kept in irrigation-rules"
            repository = nearest(mentionsHere, at).repository;
        } else {
            repository = mentions[firstMentionFrom(at) - 1]?.repository;
        }
        if (NOT_A_RULE_FILE.test(cited.split("/").pop() ?? "")) continue;
        const item = knowledgeItemFromPath(prefixed ? prefixed.rest : cited);
        if (!item) continue;
        const file: MentionedFile = {
            ...item,
            ...(repository && { repository }),
        };
        const key = knowledgeKey(file);
        if (followed.has(key) || offered.has(key)) continue;
        offered.add(key);
        found.push(file);
    }
    return found;
};

export const withoutSecretValues = (agent: CustomAgent): CustomAgent => {
    const [prepared] = prepareAgentsForSave([agent]);
    if (!prepared.tools.cli?.length) return prepared;
    return {
        ...prepared,
        tools: {
            ...prepared.tools,
            cli: prepared.tools.cli.map((tool) => ({
                ...tool,
                secrets: tool.secrets?.map((secret) => ({
                    env: secret.env,
                    ciphertext: CLI_SECRET_MASK,
                })),
            })),
        },
    };
};

export const newCliTool = (): CliToolConfig => ({
    name: "",
    install: "",
    binary: "",
    allowedPrefixes: [],
    usage: "",
    runsProjectCode: false,
    secrets: [],
    allowedDomains: [],
});
