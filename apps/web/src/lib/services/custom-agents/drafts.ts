import type {
    CliToolConfig,
    CliToolSecret,
    CustomAgent,
    CustomAgentStatus,
    KnowledgeCandidate,
    KnowledgeItem,
    KnowledgeLinkTarget,
} from "./types";

/** Mirrors CUSTOM_AGENT_LIMITS on the backend. */
export const CUSTOM_AGENT_LIMITS = {
    maxAgents: 5,
    maxCliTools: 3,
    maxSkills: 20,
    maxDocs: 10,
    maxDocTokens: 20000,
    maxInstructionsLength: 8000,
    maxWritingLength: 2000,
} as const;

/** Mirrors PINNED_INSTALL_PATTERN on the backend. */
export const PINNED_INSTALL_PATTERN =
    /@v?\d+\.\d+\.\d+|==\d+\.\d+\.\d+|sha256[:=]?[a-f0-9]{64}|\b[a-f0-9]{64}\b/i;

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
        name: "Security",
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

const blankAgent = (params: {
    id: string;
    name: string;
    color: string;
    instructions: string;
    include?: string[];
}): CustomAgent => ({
    id: params.id,
    name: params.name,
    enabled: true,
    instructions: params.instructions,
    scope: params.include ? { include: params.include } : {},
    tools: {},
    presentation: {
        tag: { color: params.color },
        format: "inline",
        suggestedFix: "when-confident",
        // New agents start in shadow: findings are kept, not posted.
        mode: "shadow",
    },
});

export const createAgentFromTemplate = (
    templateId: CustomAgentTemplateId,
    existing: CustomAgent[],
): CustomAgent => {
    const template =
        CUSTOM_AGENT_TEMPLATES.find((item) => item.id === templateId) ??
        CUSTOM_AGENT_TEMPLATES[CUSTOM_AGENT_TEMPLATES.length - 1];
    return blankAgent({
        id: uniqueId(template.id === "blank" ? "agent" : template.id, existing),
        name: template.name,
        color: template.color,
        instructions: template.instructions,
        include: template.include,
    });
};

const humanize = (value: string) => {
    const words = value.replace(/[-_]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * A skill found in the repository, turned into an agent that loads it.
 * The skill stays on the branch; the agent only links to it.
 */
export const agentFromSkill = (
    candidate: KnowledgeCandidate,
    existing: CustomAgent[],
): { agent: CustomAgent; link: KnowledgeItem } => {
    const folder = candidate.path.split("/").filter(Boolean).pop() ?? "";
    const skillName = candidate.name ?? folder;
    const agent = blankAgent({
        id: uniqueId(slugify(skillName), existing),
        name: humanize(skillName) || "Imported agent",
        color: TAG_COLORS[existing.length % TAG_COLORS.length],
        instructions: [
            candidate.description ?? "",
            `Load the "${skillName}" skill and review the change against it.`,
        ]
            .filter(Boolean)
            .join("\n"),
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

export const canAddAgent = (agents: Pick<CustomAgent, "id">[]) =>
    agents.length < CUSTOM_AGENT_LIMITS.maxAgents;

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
        `${status.shadowKept} in shadow`,
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

/** Problems the server would reject, shown while the CLI is edited. */
export const cliIssues = (cli: CliToolConfig): string[] => {
    const issues: string[] = [];
    if (!cli.name.trim()) issues.push("Name the CLI");
    if (!cli.binary.trim()) issues.push("Set the binary the agent calls");
    if (!PINNED_INSTALL_PATTERN.test(cli.install)) {
        issues.push("Pin the install to a version, e.g. tool@1.2.3");
    }
    if (!cli.allowedPrefixes.filter((prefix) => prefix.trim()).length) {
        issues.push("Add at least one allowed command prefix");
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
