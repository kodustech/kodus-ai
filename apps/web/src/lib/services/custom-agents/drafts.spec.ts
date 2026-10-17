import {
    agentFromSkill,
    agentUsageLine,
    canAddAgent,
    cliIssues,
    createAgentFromTemplate,
    CUSTOM_AGENT_LIMITS,
    CUSTOM_AGENT_TEMPLATES,
    describeAgent,
    isLinked,
    prepareAgentsForSave,
    prepareKnowledgeForSave,
    setKnowledgeLink,
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

    it("creates a template agent in shadow mode with a unique id", () => {
        const first = createAgentFromTemplate("architecture", []);
        const second = createAgentFromTemplate("architecture", [first]);

        expect(first).toMatchObject({
            id: "architecture",
            name: "Architecture",
            enabled: true,
            presentation: {
                mode: "shadow",
                format: "inline",
                suggestedFix: "when-confident",
            },
        });
        expect(first.instructions.length).toBeGreaterThan(40);
        expect(second.id).toBe("architecture-2");
    });

    it("creates a blank agent with no instructions", () => {
        const agent = createAgentFromTemplate("blank", []);
        expect(agent.instructions).toBe("");
        expect(agent.name).toBe("New agent");
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

        expect(agent.name).toBe("Ledger errors");
        expect(agent.instructions).toContain(
            "How ledger services report errors.",
        );
        expect(link).toEqual({
            path: ".claude/skills/ledger-errors",
            kind: "skill",
            linkedTo: [{ agentId: agent.id }],
        });
    });

    it("stops adding agents at the limit", () => {
        const agents = Array.from(
            { length: CUSTOM_AGENT_LIMITS.maxAgents },
            (_, index) => ({ id: `a${index}` }) as CustomAgent,
        );
        expect(canAddAgent(agents.slice(1))).toBe(true);
        expect(canAddAgent(agents)).toBe(false);
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
                    shadowKept: 2,
                    dropped: 1,
                },
                30,
            ),
        ).toBe("3 PRs · 4 posted · 2 in shadow · 1 dropped · last 30 days");
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
});
