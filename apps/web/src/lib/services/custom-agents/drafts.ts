import type {
    CliToolConfig,
    CliToolSecret,
    CustomAgent,
    CustomAgentResolveReport,
    CustomAgentStatus,
    KnowledgeCandidate,
    KnowledgeItem,
    KnowledgeLinkTarget,
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
        .filter((token, index, all) =>
            all.slice(0, index + 1).every((t) => INSTALL_VERBS.has(t))
                ? false
                : true,
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
    return blankAgent({
        id: uniqueId(template.id === "blank" ? "agent" : template.id, existing),
        name: uniqueName(template.name, existing),
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

export const agentUsageLine = (
    status: CustomAgentStatus | undefined,
    windowDays: number,
) => {
    if (!status || status.pullRequests === 0) {
        return `No findings in the last ${windowDays} days`;
    }
    return [
        `${status.pullRequests} ${status.pullRequests === 1 ? "PR" : "PRs"}`,
        `${status.posted} posted`,
        `${status.dropped} dropped`,
        `last ${windowDays} days`,
    ].join(" · ");
};

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
 * another agent to keep following.
 */
export const withoutAgent = (
    agents: CustomAgent[],
    knowledge: KnowledgeItem[],
    agentId: string,
): { agents: CustomAgent[]; knowledge: KnowledgeItem[] } => ({
    agents: agents.filter((agent) => agent.id !== agentId),
    knowledge: knowledge.map((item) => ({
        ...item,
        linkedTo: item.linkedTo.filter(
            (target) =>
                typeof target === "string" || target.agentId !== agentId,
        ),
    })),
});

/**
 * Links or unlinks one skill or doc. An item stays registered with no links,
 * so the Skills & docs page keeps listing it.
 */
export const setKnowledgeLink = (
    knowledge: KnowledgeItem[],
    item: Pick<KnowledgeItem, "path" | "kind">,
    target: KnowledgeLinkTarget,
    linked: boolean,
): KnowledgeItem[] => {
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

type NamedKnowledge = Pick<KnowledgeItem, "path" | "kind"> & { name?: string };

/** What one agent follows, skills first, each with the name it shows. */
export const followedBy = (
    knowledge: KnowledgeItem[],
    agentId: string,
    named: NamedKnowledge[] = [],
) => {
    const linked = knowledge.filter((item) => isLinked(item, { agentId }));
    const nameOf = (item: KnowledgeItem) =>
        named.find(
            (entry) => entry.path === item.path && entry.kind === item.kind,
        )?.name ??
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

/** "Follows: create-e2e-tests · 1 doc", or null when nothing is linked. */
export const followsLine = (
    knowledge: KnowledgeItem[],
    agentId: string,
    named: NamedKnowledge[] = [],
): string | null => {
    const { skills, docs } = followedBy(knowledge, agentId, named);
    const parts = [
        skills.map((skill) => skill.name).join(", "),
        docs.length ? plural(docs.length, "doc") : "",
    ].filter(Boolean);
    return parts.length ? `Follows: ${parts.join(" · ")}` : null;
};

/** One sentence on what the agent does on a pull request, from its config. */
export const pullRequestPlan = (
    agent: Pick<CustomAgent, "id" | "name" | "scope" | "presentation">,
    knowledge: KnowledgeItem[],
    named: NamedKnowledge[] = [],
): string => {
    const include = agent.scope.include?.filter(Boolean) ?? [];
    const exclude = agent.scope.exclude?.filter(Boolean) ?? [];
    const when = [
        include.length
            ? `On a pull request that changes ${include.join(", ")}`
            : "On every pull request",
        exclude.length ? ` except ${exclude.join(", ")}` : "",
    ].join("");
    const { skills, docs } = followedBy(knowledge, agent.id, named);
    const steps = [
        skills.length
            ? `loads ${skills.map((skill) => skill.name).join(", ")}`
            : "",
        docs.length ? `reads ${plural(docs.length, "doc")}` : "",
    ].filter(Boolean);
    if (!steps.length) steps.push("follows its instructions");
    steps.push("checks each finding");
    steps.push(`posts as ${agent.name || "this agent"}`);
    return `${when} — ${steps.join(", ")}.`;
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
 * The settings edited on the agent's own page, as short chips for its row:
 * plugins, CLIs and models.
 */
export const settingsSummary = (
    agent: Pick<CustomAgent, "tools" | "models">,
    names: {
        pluginName?: (integrationId: string) => string | undefined;
        modelName?: (modelId: string) => string | undefined;
    } = {},
): string[] => {
    const model = (id: string) => names.modelName?.(id) ?? id;
    const chips = [
        ...(agent.tools.mcp ?? []).map(
            (plugin) =>
                names.pluginName?.(plugin.integrationId) ??
                pluginNameFromId(plugin.integrationId),
        ),
        ...(agent.tools.cli ?? []).map((cli) => `${cli.name || "Unnamed"} CLI`),
    ];
    const { run, check } = agent.models ?? {};
    if (!run && !check) chips.push("Model: routing default");
    if (run) chips.push(`Model: ${model(run)}`);
    if (check) chips.push(`Check: ${model(check)}`);
    return chips;
};

/**
 * Turns one skill or doc on or off for an agent, from the agent itself:
 * turning it on registers the file when the config did not have it, and
 * turning it off drops the file once nothing follows it any more.
 */
export const setAgentKnowledge = (
    knowledge: KnowledgeItem[],
    item: Pick<KnowledgeItem, "path" | "kind">,
    agentId: string,
    on: boolean,
): KnowledgeItem[] => {
    const next = setKnowledgeLink(knowledge, item, { agentId }, on);
    if (on) return next;
    return next.filter(
        (entry) =>
            entry.linkedTo.length > 0 ||
            entry.path !== item.path ||
            entry.kind !== item.kind,
    );
};

export type KnowledgeChoice = {
    path: string;
    kind: KnowledgeItem["kind"];
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
    const found = (item: Pick<KnowledgeItem, "path" | "kind">) =>
        candidates.find(
            (candidate) =>
                candidate.path === item.path && candidate.kind === item.kind,
        );
    const registered = knowledge.map((item) => ({
        path: item.path,
        kind: item.kind,
        name: found(item)?.name,
        linked: isLinked(item, { agentId }),
        kodyRuleSource: found(item)?.kodyRuleSource ?? false,
    }));
    const taken = new Set(knowledge.map((item) => `${item.kind}:${item.path}`));
    const discovered = candidates
        .filter(
            (candidate, index, all) =>
                !taken.has(`${candidate.kind}:${candidate.path}`) &&
                all.findIndex(
                    (other) =>
                        other.path === candidate.path &&
                        other.kind === candidate.kind,
                ) === index,
        )
        .map((candidate) => ({
            path: candidate.path,
            kind: candidate.kind,
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
    return issues;
};

/**
 * The agents as the save endpoint takes them. A secret is sent either as
 * the mask it was read with (keep the stored value) or as a typed value; a
 * secret left blank after "Replace" has neither and is dropped.
 */
export const prepareAgentsForSave = (agents: CustomAgent[]): CustomAgent[] =>
    agents.map((loaded) => {
        // A preview config saved before shadow mode was retired still holds
        // `presentation.mode`, which the save endpoint no longer takes.
        const { mode: _retired, ...presentation } =
            loaded.presentation as CustomAgent["presentation"] & {
                mode?: unknown;
            };
        const agent = { ...loaded, presentation };
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
    knowledge.map(({ path, kind, linkedTo }) => ({ path, kind, linkedTo }));

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
