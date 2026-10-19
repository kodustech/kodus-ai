import {
    agentFromSkill,
    agentNameError,
    agentSlug,
    agentChips,
    agentStatusLine,
    agentUsageLine,
    cliIssues,
    createAgentFromTemplate,
    CUSTOM_AGENT_LIMITS,
    CUSTOM_AGENT_TEMPLATES,
    deleteAgentNote,
    describeAgent,
    isLinked,
    knowledgeChoices,
    knowledgeItemFromPath,
    nameCollisionHint,
    nextTagColor,
    normalizeKnowledgePath,
    prepareAgentsForSave,
    prepareKnowledgeForSave,
    reviewerName,
    setAgentKnowledge,
    setKnowledgeLink,
    scopeLabel,
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

    it("creates a template agent that starts off, with a unique id", () => {
        const first = createAgentFromTemplate("architecture", []);
        const second = createAgentFromTemplate("architecture", [first]);

        expect(first).toMatchObject({
            id: "architecture",
            name: "Architecture",
            enabled: false,
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

    it("names a blank agent's id after its name, not a generic word", () => {
        const first = createAgentFromTemplate("blank", []);
        const second = createAgentFromTemplate("blank", [first]);

        expect(first.id).toBe("new-agent");
        expect(second).toMatchObject({ id: "new-agent-2", name: "New agent 2" });
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
            "No findings in 30 days",
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
        ).toBe("3 PRs · 4 posted · 30 days");
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

        it("names a new agent so its command name is unique", () => {
            const first = createAgentFromTemplate("blank", []);
            const second = createAgentFromTemplate("blank", [first]);
            const third = createAgentFromTemplate("blank", [first, second]);
            expect([first.name, second.name, third.name]).toEqual([
                "New agent",
                "New agent 2",
                "New agent 3",
            ]);
            // A rename can take the slug a suffix would give.
            const renamed = { ...second, name: "new-agent" };
            expect(createAgentFromTemplate("blank", [renamed]).name).toBe(
                "New agent 2",
            );
        });

        it("names an imported agent so its command name is unique", () => {
            const skill = {
                path: ".claude/skills/e2e",
                kind: "skill" as const,
                name: "create-e2e-tests",
                kodyRuleSource: false,
            };
            const { agent: first } = agentFromSkill(skill, []);
            const { agent: second } = agentFromSkill(skill, [first]);
            expect(second.name).toBe("E2E tests reviewer 2");
        });

        it("derives the command name the backend uses", () => {
            expect(agentSlug("Data Contracts")).toBe("data-contracts");
            expect(agentSlug("  Café — Rules!! ")).toBe("cafe-rules");
            expect(agentSlug("!!!")).toBe("agent");
        });

        it("refuses a name whose command name another agent uses", () => {
            const first = createAgentFromTemplate("architecture", []);
            const second = {
                ...createAgentFromTemplate("blank", [first]),
                name: "architecture!",
            };
            expect(agentNameError(second, [first, second])).toBe(
                'Another agent, "Architecture", already answers to @kody -v architecture. Choose a different name.',
            );
            expect(agentNameError(first, [first])).toBeNull();
            expect(
                agentNameError({ ...second, name: "Arch 2" }, [first, second]),
            ).toBeNull();
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

        it("counts the skills and docs an agent follows on its row", () => {
            const row = (id: string) =>
                agentChips(
                    { id, scope: {}, tools: {} } as CustomAgent,
                    knowledge,
                );
            expect(row("a1")).toEqual(["All files", "2 skills", "1 doc"]);
            expect(row("a2")).toEqual(["All files", "1 doc"]);
            expect(row("a3")).toEqual(["All files"]);
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

        const next = withoutAgent(agents, knowledge, "a", []);

        expect(next.agents.map((agent) => agent.id)).toEqual(["b"]);
        expect(next.knowledge).toEqual([
            {
                path: ".claude/skills/money",
                kind: "skill",
                linkedTo: ["main", { agentId: "b" }],
            },
            { path: "docs/a.md", kind: "doc", linkedTo: [] },
        ]);
        expect(deleteAgentNote("a", [])).toBe(
            "Its findings stay on past pull requests.",
        );
    });

    it("keeps a directory's links when the deleted agent replaced an inherited one", () => {
        // The repository's agent with that id runs at the directory again,
        // and the directory's links now apply to it.
        const agents = [
            { id: "a", name: "Zone ledger" } as CustomAgent,
            { id: "b" } as CustomAgent,
        ];
        const inherited = [{ id: "a", name: "Ledger" } as CustomAgent];
        const knowledge: KnowledgeItem[] = [
            {
                path: ".claude/skills/money",
                kind: "skill",
                linkedTo: [{ agentId: "a" }, { agentId: "b" }],
            },
        ];

        const next = withoutAgent(agents, knowledge, "a", inherited);

        expect(next.agents.map((agent) => agent.id)).toEqual(["b"]);
        expect(next.knowledge).toEqual(knowledge);
        expect(deleteAgentNote("a", inherited)).toBe(
            "The repository's Ledger runs here again, with the skills and docs this directory links to it. Its findings stay on past pull requests.",
        );
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

        it("says where the agent runs and what it did, in one line", () => {
            const agent = {
                ...base(),
                scope: {
                    include: ["apps/billing/**"],
                    exclude: ["**/*.test.ts"],
                },
            };
            expect(scopeLabel(agent)).toBe(
                "apps/billing/** except **/*.test.ts",
            );
            expect(scopeLabel(base())).toBe("all files");
            expect(
                agentStatusLine(
                    agent,
                    { agentId: "a", pullRequests: 9, posted: 15, dropped: 2 },
                    30,
                ),
            ).toBe(
                "Runs on apps/billing/** except **/*.test.ts · 9 PRs · 15 posted in 30 days",
            );
            expect(agentStatusLine(base(), undefined, 30)).toBe(
                "Runs on all files · no findings in 30 days",
            );
            expect(agentStatusLine(base(), undefined, 30, true)).toBe(
                "Runs on all files",
            );
        });

        it("lists files, skills, docs, plugins and CLIs as row chips", () => {
            const agent: CustomAgent = {
                ...base(),
                id: "agent",
                scope: { include: ["src/payments/**", "src/ledger/**"] },
                tools: {
                    mcp: [{ integrationId: "lin", tools: [] }],
                    cli: [{ name: "semver" } as CliToolConfig],
                    astGrepConfig: "id: x",
                },
            };
            expect(
                agentChips(agent, knowledge, {
                    pluginName: (id) => (id === "lin" ? "Linear" : undefined),
                }),
            ).toEqual([
                "src/payments/** +1",
                "1 skill",
                "1 doc",
                "Linear",
                "semver CLI",
                "ast-grep",
            ]);
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
            expect(agentChips(agent, []).slice(1, 4)).toEqual([
                "Linear",
                "Git Issues",
                "Plugin",
            ]);
        });
    });
});

describe("ast-grep rules field", () => {
    // Imported here so the list above stays as it was.
    const { astGrepHint, astGrepRulesPath } =
        jest.requireActual<typeof import("./drafts")>("./drafts");

    const report = (astGrep: {
        ruleCount: number;
        ruleIds: string[];
        errors: string[];
        rulesPath?: string;
    }) => ({ astGrep }) as any;

    it("reads a single .yml line as a rule file path, anything else as inline rules", () => {
        expect(astGrepRulesPath("rules/no-console.yml")).toBe(
            "rules/no-console.yml",
        );
        expect(astGrepRulesPath("id: no-console\nrule: {}")).toBeUndefined();
        expect(astGrepRulesPath("id: rules.yml")).toBeUndefined();
    });

    it("says a rule file is read from the target branch, and what it holds", () => {
        expect(astGrepHint("rules/no-console.yml")).toContain(
            "rules/no-console.yml",
        );
        expect(astGrepHint("rules/no-console.yml")).toContain("target branch");
        const hint = astGrepHint(
            "rules/no-console.yml",
            report({
                ruleCount: 2,
                ruleIds: ["no-console", "py-print"],
                errors: [],
                rulesPath: "rules/no-console.yml",
            }),
        );
        expect(hint).toContain("2 rules in rules/no-console.yml");
        expect(hint).toContain("no-console, py-print");
    });

    it("explains both forms when the field is empty", () => {
        const hint = astGrepHint(undefined);
        expect(hint).toContain("Rule YAML");
        expect(hint).toContain("path");
    });
});
