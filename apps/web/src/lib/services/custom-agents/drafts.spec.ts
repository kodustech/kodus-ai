import {
    agentFromSkill,
    agentUsageLine,
    cliIssues,
    createAgentFromTemplate,
    CUSTOM_AGENT_LIMITS,
    CUSTOM_AGENT_TEMPLATES,
    describeAgent,
    followsLine,
    isLinked,
    knowledgeChoices,
    knowledgeItemFromPath,
    nameCollisionHint,
    nextTagColor,
    normalizeKnowledgePath,
    prepareAgentsForSave,
    prepareKnowledgeForSave,
    pullRequestPlan,
    reviewerName,
    setAgentKnowledge,
    setKnowledgeLink,
    settingsSummary,
    TAG_COLORS,
    withoutAgent,
    withoutSecretValues,
} from "./drafts";
import type { CliToolConfig, CustomAgent, KnowledgeItem } from "./types";

const cli = (overrides: Partial<CliToolConfig> = {}): CliToolConfig => ({
    name: "ledgerctl",
    install: "npm i -g ledgerctl@1.4.2",
    binary: "ledgerctl",
    allowedPrefixes: ["ledgerctl check"],
    usage: "Run `ledgerctl check <file>`.",
    runsProjectCode: false,
    allowedDomains: ["api.ledger.example"],
    ...overrides,
});

describe("custom agent drafts", () => {
    it("offers the four templates and a blank agent", () => {
        expect(CUSTOM_AGENT_TEMPLATES.map((template) => template.id)).toEqual([
            "architecture",
            "e2e-coverage",
            "regression-hallucination",
            "security",
            "blank",
        ]);
    });

    it("creates a template agent that posts, with a unique id", () => {
        const first = createAgentFromTemplate("architecture", []);
        const second = createAgentFromTemplate("architecture", [first]);

        expect(first).toMatchObject({
            id: "architecture",
            name: "Architecture",
            enabled: true,
            presentation: {
                format: "inline",
                suggestedFix: "when-confident",
            },
        });
        expect(first.presentation).not.toHaveProperty("mode");
        expect(first.instructions.length).toBeGreaterThan(40);
        expect(second.id).toBe("architecture-2");
    });

    it("creates a blank agent with no instructions", () => {
        const agent = createAgentFromTemplate("blank", []);
        expect(agent.instructions).toBe("");
        expect(agent.name).toBe("New agent");
        expect(agent.presentation).not.toHaveProperty("mode");
    });

    it("imports a repository skill as an agent linked to it", () => {
        const { agent, link } = agentFromSkill(
            {
                path: ".claude/skills/ledger-errors",
                kind: "skill",
                name: "ledger-errors",
                description: "How ledger services report errors.",
                kodyRuleSource: false,
            },
            [],
        );

        expect(agent.name).toBe("Ledger errors reviewer");
        expect(agent.instructions).toBe(
            'Review the change against the team\'s "ledger-errors" skill: load it, follow its rules and references, and report where the change departs from them. Cite the rule you apply.',
        );
        expect(link).toEqual({
            path: ".claude/skills/ledger-errors",
            kind: "skill",
            linkedTo: [{ agentId: agent.id }],
        });
        expect(agent.presentation).not.toHaveProperty("mode");
    });

    it("describes an agent by the first line of its instructions", () => {
        const agent = createAgentFromTemplate("blank", []);
        expect(describeAgent({ ...agent, instructions: "" })).toBe(
            "No instructions yet",
        );
        expect(
            describeAgent({
                ...agent,
                instructions: "\n# Ledger rules\nFlag rounding.",
            }),
        ).toBe("Ledger rules");
    });

    it("summarizes the last window of findings", () => {
        expect(agentUsageLine(undefined, 30)).toBe(
            "No findings in the last 30 days",
        );
        expect(
            agentUsageLine(
                {
                    agentId: "a",
                    pullRequests: 3,
                    posted: 4,
                    dropped: 1,
                },
                30,
            ),
        ).toBe("3 PRs · 4 posted · 1 dropped · last 30 days");
    });

    it("links and unlinks knowledge without losing the registration", () => {
        const knowledge: KnowledgeItem[] = [];
        const linked = setKnowledgeLink(
            knowledge,
            { path: "docs/ledger.md", kind: "doc" },
            { agentId: "ledger" },
            true,
        );
        expect(isLinked(linked[0], { agentId: "ledger" })).toBe(true);

        const both = setKnowledgeLink(
            linked,
            { path: "docs/ledger.md", kind: "doc" },
            "main-review",
            true,
        );
        expect(both[0].linkedTo).toHaveLength(2);

        const unlinked = setKnowledgeLink(
            both,
            { path: "docs/ledger.md", kind: "doc" },
            { agentId: "ledger" },
            false,
        );
        expect(unlinked).toEqual([
            {
                path: "docs/ledger.md",
                kind: "doc",
                linkedTo: ["main-review"],
            },
        ]);
    });

    it("links a file the config did not have yet to one agent", () => {
        const next = setAgentKnowledge(
            [],
            { path: "docs/ledger.md", kind: "doc" },
            "ledger",
            true,
        );
        expect(next).toEqual([
            {
                path: "docs/ledger.md",
                kind: "doc",
                linkedTo: [{ agentId: "ledger" }],
            },
        ]);
    });

    it("unlinking keeps an item something else still follows", () => {
        const knowledge: KnowledgeItem[] = [
            {
                path: "docs/ledger.md",
                kind: "doc",
                linkedTo: ["main-review", { agentId: "ledger" }],
            },
        ];
        expect(
            setAgentKnowledge(
                knowledge,
                { path: "docs/ledger.md", kind: "doc" },
                "ledger",
                false,
            ),
        ).toEqual([
            { path: "docs/ledger.md", kind: "doc", linkedTo: ["main-review"] },
        ]);
    });

    it("unlinking the last follower removes the item", () => {
        const knowledge: KnowledgeItem[] = [
            {
                path: ".claude/skills/ledger",
                kind: "skill",
                linkedTo: [{ agentId: "ledger" }],
            },
            { path: "docs/other.md", kind: "doc", linkedTo: [] },
        ];
        expect(
            setAgentKnowledge(
                knowledge,
                { path: ".claude/skills/ledger", kind: "skill" },
                "ledger",
                false,
            ),
        ).toEqual([{ path: "docs/other.md", kind: "doc", linkedTo: [] }]);
    });

    it("linking twice does not duplicate the agent", () => {
        const once = setAgentKnowledge(
            [],
            { path: "docs/ledger.md", kind: "doc" },
            "ledger",
            true,
        );
        const twice = setAgentKnowledge(
            once,
            { path: "docs/ledger.md", kind: "doc" },
            "ledger",
            true,
        );
        expect(twice).toEqual(once);
    });

    it("lists the config's items and what was found, each once", () => {
        const knowledge: KnowledgeItem[] = [
            {
                path: "docs/ledger.md",
                kind: "doc",
                linkedTo: [{ agentId: "ledger" }],
            },
            { path: "docs/style.md", kind: "doc", linkedTo: ["main-review"] },
        ];
        const choices = knowledgeChoices(
            knowledge,
            [
                {
                    path: "docs/ledger.md",
                    kind: "doc",
                    name: "Ledger",
                    kodyRuleSource: false,
                },
                {
                    path: ".claude/skills/payments",
                    kind: "skill",
                    name: "payments",
                    kodyRuleSource: true,
                },
            ],
            "ledger",
        );
        expect(choices).toEqual([
            {
                path: "docs/ledger.md",
                kind: "doc",
                name: "Ledger",
                linked: true,
                kodyRuleSource: false,
            },
            {
                path: "docs/style.md",
                kind: "doc",
                name: undefined,
                linked: false,
                kodyRuleSource: false,
            },
            {
                path: ".claude/skills/payments",
                kind: "skill",
                name: "payments",
                linked: false,
                kodyRuleSource: true,
            },
        ]);
    });

    it("normalizes a typed path", () => {
        expect(normalizeKnowledgePath("  /docs/ledger.md ")).toBe(
            "docs/ledger.md",
        );
        expect(normalizeKnowledgePath("   ")).toBe("");
    });

    it("flags an unpinned install, missing prefixes and secrets on project code", () => {
        expect(cliIssues(cli())).toEqual([]);
        expect(cliIssues(cli({ install: "npm i -g ledgerctl" }))).toContain(
            "Pin the install to a version, e.g. tool@1.2.3",
        );
        for (const install of [
            "npm i -g a@latest b@1.2.3",
            "npm i -g ledgerctl@1.2.3x",
            "npm i -g ledgerctl@^1.2.3",
            "pip install ledgerctl==1.2.3 ledgerfmt",
        ]) {
            expect(cliIssues(cli({ install }))).toContain(
                "Pin the install to a version, e.g. tool@1.2.3",
            );
        }
        expect(cliIssues(cli({ allowedPrefixes: [] }))).toContain(
            "Add at least one allowed command prefix",
        );
        expect(
            cliIssues(
                cli({
                    runsProjectCode: true,
                    secrets: [{ env: "LEDGER_TOKEN", value: "typed" }],
                }),
            ),
        ).toContain("A CLI that runs project code never receives secrets");
        expect(
            cliIssues(cli({ secrets: [{ env: "ledger-token", value: "x" }] })),
        ).toContain("Secret names are env variables, e.g. LEDGER_TOKEN");
    });

    it("sends typed or kept secrets and drops a blank one before saving", () => {
        const agent = createAgentFromTemplate("blank", []);
        const [prepared] = prepareAgentsForSave([
            {
                ...agent,
                tools: {
                    cli: [
                        cli({
                            secrets: [
                                { env: "LEDGER_TOKEN", ciphertext: "••••" },
                                { env: "LEDGER_URL", value: "typed" },
                                { env: "LEDGER_KEY", value: "" },
                            ],
                        }),
                    ],
                },
            },
        ]);
        expect(prepared.tools.cli?.[0].secrets).toEqual([
            { env: "LEDGER_TOKEN", ciphertext: "••••" },
            { env: "LEDGER_URL", value: "typed" },
        ]);
    });

    it("never sends a typed secret to the draft check", () => {
        const agent = createAgentFromTemplate("blank", []);
        const redacted = withoutSecretValues({
            ...agent,
            tools: {
                cli: [
                    cli({
                        secrets: [
                            { env: "LEDGER_URL", value: "typed-secret" },
                            { env: "LEDGER_KEY", value: "" },
                        ],
                    }),
                ],
            },
        });
        expect(JSON.stringify(redacted)).not.toContain("typed-secret");
        expect(redacted.tools.cli?.[0].secrets).toEqual([
            { env: "LEDGER_URL", ciphertext: "••••" },
        ]);
    });

    it("saves only the fields of a knowledge item, never what the screen shows about it", () => {
        const found = {
            path: ".claude/skills/tenant-scope",
            kind: "skill" as const,
            linkedTo: [{ agentId: "security" }],
            name: "tenant-scope",
            description: "How to check tenant scope",
            kodyRuleSource: false,
        };

        expect(prepareKnowledgeForSave([found])).toEqual([
            {
                path: ".claude/skills/tenant-scope",
                kind: "skill",
                linkedTo: [{ agentId: "security" }],
            },
        ]);
    });

    it("warns about a prefix that only names the binary", () => {
        expect(cliIssues(cli({ allowedPrefixes: ["ledgerctl"] }))).toContain(
            "A prefix names a subcommand or flag after the binary, e.g. ledgerctl check",
        );
    });

    describe("agent naming and colors", () => {
        it.each([
            ["create-e2e-tests", "E2E tests reviewer"],
            ["ledger-errors", "Ledger errors reviewer"],
            ["review-api-contracts", "API contracts reviewer"],
            ["write_sql_migrations", "SQL migrations reviewer"],
            ["check-ui", "UI reviewer"],
            ["use-feature-flags", "Feature flags reviewer"],
            ["create", "Create reviewer"],
            ["security-reviewer", "Security reviewer"],
        ])("names the skill %s as %s", (skill: string, name: string) => {
            expect(reviewerName(skill)).toBe(name);
        });

        it("names an imported skill by its frontmatter name as a reviewer", () => {
            const { agent } = agentFromSkill(
                {
                    path: ".claude/skills/e2e",
                    kind: "skill",
                    name: "create-e2e-tests",
                    kodyRuleSource: false,
                },
                [],
            );
            expect(agent.name).toBe("E2E tests reviewer");
            expect(agent.instructions).toContain('"create-e2e-tests" skill');
        });

        it("picks the first tag color no agent uses, then rotates", () => {
            const withColor = (color: string, index: number) =>
                ({
                    id: `a${index}`,
                    presentation: { tag: { color } },
                }) as CustomAgent;
            expect(nextTagColor([])).toBe(TAG_COLORS[0]);
            expect(
                nextTagColor([
                    withColor(TAG_COLORS[0], 0),
                    withColor(TAG_COLORS[2], 1),
                ]),
            ).toBe(TAG_COLORS[1]);
            const all = TAG_COLORS.map(withColor);
            expect(nextTagColor(all)).toBe(
                TAG_COLORS[all.length % TAG_COLORS.length],
            );
        });

        it("gives an imported agent a color no other agent has", () => {
            const first = createAgentFromTemplate("architecture", []);
            const { agent } = agentFromSkill(
                {
                    path: ".claude/skills/x",
                    kind: "skill",
                    kodyRuleSource: false,
                },
                [first],
            );
            expect(agent.presentation.tag.color).not.toBe(
                first.presentation.tag.color,
            );
        });

        it("keeps a template's color when free and moves off it when taken", () => {
            const first = createAgentFromTemplate("security", []);
            const second = createAgentFromTemplate("security", [first]);
            expect(first.presentation.tag.color).toBe(
                CUSTOM_AGENT_TEMPLATES.find((t) => t.id === "security")?.color,
            );
            expect(second.presentation.tag.color).not.toBe(
                first.presentation.tag.color,
            );
        });

        it("hints when a name repeats a native category, ignoring case", () => {
            expect(nameCollisionHint("security")).toBe(
                "Kody already has a Security category; a distinct name (e.g. Security reviewer) tells their comments apart.",
            );
            expect(nameCollisionHint(" Business logic ")).toContain(
                "Business Logic category",
            );
            expect(nameCollisionHint("Security reviewer")).toBeNull();
            const security = createAgentFromTemplate("security", []);
            expect(nameCollisionHint(security.name)).toBeNull();
        });
    });

    describe("what an agent follows", () => {
        const knowledge: KnowledgeItem[] = [
            {
                path: ".claude/skills/e2e",
                kind: "skill",
                linkedTo: [{ agentId: "a1" }],
            },
            {
                path: ".claude/skills/ledger",
                kind: "skill",
                linkedTo: [{ agentId: "a1" }, "main-review"],
            },
            {
                path: "docs/billing.md",
                kind: "doc",
                linkedTo: [{ agentId: "a1" }],
            },
            {
                path: "docs/other.md",
                kind: "doc",
                linkedTo: [{ agentId: "a2" }],
            },
        ];
        const names = [
            {
                path: ".claude/skills/e2e",
                kind: "skill" as const,
                name: "create-e2e-tests",
            },
        ];

        it("names skills by frontmatter, else folder, and counts docs", () => {
            expect(followsLine(knowledge, "a1", names)).toBe(
                "Follows: create-e2e-tests, ledger · 1 doc",
            );
            expect(followsLine(knowledge, "a2", names)).toBe("Follows: 1 doc");
            expect(followsLine(knowledge, "a3", names)).toBeNull();
        });

        it.each([
            ["docs/payments.md", { path: "docs/payments.md", kind: "doc" }],
            ["/ARCHITECTURE.txt", { path: "ARCHITECTURE.txt", kind: "doc" }],
            [
                ".claude/skills/ledger",
                { path: ".claude/skills/ledger", kind: "skill" },
            ],
            [
                ".claude/skills/ledger/",
                { path: ".claude/skills/ledger", kind: "skill" },
            ],
            [
                " .claude/skills/ledger/SKILL.md ",
                { path: ".claude/skills/ledger", kind: "skill" },
            ],
            ["", null],
        ])("infers %s", (input: string, expected: unknown) => {
            expect(knowledgeItemFromPath(input)).toEqual(expected);
        });
    });

    it("removes an agent and only its links to skills and docs", () => {
        const agents = [
            { id: "a" } as CustomAgent,
            { id: "b" } as CustomAgent,
        ];
        const knowledge: KnowledgeItem[] = [
            {
                path: ".claude/skills/money",
                kind: "skill",
                linkedTo: ["main", { agentId: "a" }, { agentId: "b" }],
            },
            { path: "docs/a.md", kind: "doc", linkedTo: [{ agentId: "a" }] },
        ];

        const next = withoutAgent(agents, knowledge, "a");

        expect(next.agents.map((agent) => agent.id)).toEqual(["b"]);
        expect(next.knowledge).toEqual([
            {
                path: ".claude/skills/money",
                kind: "skill",
                linkedTo: ["main", { agentId: "b" }],
            },
            { path: "docs/a.md", kind: "doc", linkedTo: [] },
        ]);
    });

    describe("summaries", () => {
        const base = (): CustomAgent => ({
            ...createAgentFromTemplate("blank", []),
            name: "E2E tests reviewer",
        });
        const knowledge: KnowledgeItem[] = [
            {
                path: ".claude/skills/e2e",
                kind: "skill",
                linkedTo: [{ agentId: "agent" }],
            },
            {
                path: "docs/billing.md",
                kind: "doc",
                linkedTo: [{ agentId: "agent" }],
            },
        ];
        const names = [
            {
                path: ".claude/skills/e2e",
                kind: "skill" as const,
                name: "create-e2e-tests",
            },
        ];

        it("describes a pull request from the config", () => {
            const agent = {
                ...base(),
                scope: { include: ["apps/billing/**"] },
            };
            expect(pullRequestPlan(agent, knowledge, names)).toBe(
                "On a pull request that changes apps/billing/** — loads create-e2e-tests, reads 1 doc, checks each finding, posts as E2E tests reviewer.",
            );
        });

        it("runs on every pull request and posts, even for an agent saved in the retired shadow mode", () => {
            const agent = {
                ...base(),
                scope: { exclude: ["**/*.test.ts"] },
                presentation: { ...base().presentation, mode: "shadow" },
            } as CustomAgent;
            expect(pullRequestPlan(agent, [], [])).toBe(
                "On every pull request except **/*.test.ts — follows its instructions, checks each finding, posts as E2E tests reviewer.",
            );
        });

        it("lists plugins, CLIs and the model in one line", () => {
            const agent: CustomAgent = {
                ...base(),
                tools: {
                    mcp: [{ integrationId: "lin", tools: [] }],
                    cli: [{ name: "semver" } as CliToolConfig],
                },
            };
            expect(
                settingsSummary(agent, {
                    pluginName: (id) => (id === "lin" ? "Linear" : undefined),
                }),
            ).toEqual(["Linear", "semver CLI", "Model: routing default"]);
            expect(
                settingsSummary(
                    { ...base(), models: { run: "m1", check: "m2" } },
                    {
                        modelName: (id) =>
                            id === "m1" ? "Model One" : undefined,
                    },
                ),
            ).toEqual(["Model: Model One", "Check: m2"]);
        });

        it("names a plugin from its id when its connection is not listed", () => {
            const agent: CustomAgent = {
                ...base(),
                tools: {
                    mcp: [
                        { integrationId: "linear-default", tools: ["*"] },
                        { integrationId: "kodus-issues-default", tools: ["*"] },
                        {
                            integrationId:
                                "3f2b6c1e-8a4d-4c2b-9e1f-0a1b2c3d4e5f",
                            tools: ["*"],
                        },
                    ],
                    cli: [],
                },
            };
            expect(settingsSummary(agent).slice(0, 3)).toEqual([
                "Linear",
                "Git Issues",
                "Plugin",
            ]);
        });
    });
});
