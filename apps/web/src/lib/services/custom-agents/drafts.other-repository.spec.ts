/**
 * Skills and docs of another repository on the settings screens (#2329).
 * Fixture domain: an invented greenhouse-irrigation team and its rules repo.
 */
import {
    knowledgeChoices,
    mentionedButNotFollowed,
    prepareKnowledgeForSave,
    sameKnowledge,
    setAgentKnowledge,
} from "./drafts";
import type { KnowledgeItem } from "./types";

const RULES = "greenhouse/irrigation-rules";
const local: KnowledgeItem = {
    path: "docs/valves.md",
    kind: "doc",
    linkedTo: [{ agentId: "valves" }],
};
const remote: KnowledgeItem = {
    path: "docs/valves.md",
    kind: "doc",
    repository: RULES,
    linkedTo: [{ agentId: "valves" }],
};

describe("knowledge of another repository", () => {
    it("treats the same path in two repositories as two items", () => {
        expect(sameKnowledge(local, remote)).toBe(false);
        expect(
            sameKnowledge(remote, {
                ...remote,
                repository: RULES.toUpperCase(),
            }),
        ).toBe(true);
    });

    it("follows and unfollows a doc of the rules repository without touching the local one", () => {
        const followed = setAgentKnowledge(
            [local],
            {
                path: "docs/valves.md",
                kind: "doc",
                repository: RULES,
                ref: "v3",
            },
            "valves",
            true,
        );
        expect(followed).toEqual([local, { ...remote, ref: "v3" }]);

        expect(setAgentKnowledge(followed, remote, "valves", false)).toEqual([
            local,
        ]);
    });

    it("keeps the repository and ref when saving, and drops a ref without a repository", () => {
        expect(
            prepareKnowledgeForSave([
                { ...remote, ref: "v3" },
                { ...local, ref: "v3" },
            ]),
        ).toEqual([
            {
                path: "docs/valves.md",
                kind: "doc",
                repository: RULES,
                ref: "v3",
                linkedTo: [{ agentId: "valves" }],
            },
            {
                path: "docs/valves.md",
                kind: "doc",
                linkedTo: [{ agentId: "valves" }],
            },
        ]);
    });

    it("offers what another repository has, with its source, and not what is already followed", () => {
        expect(
            knowledgeChoices(
                [remote],
                [
                    {
                        path: "docs/valves.md",
                        kind: "doc",
                        repository: RULES,
                        kodyRuleSource: false,
                    },
                    {
                        path: "docs/pumps.md",
                        kind: "doc",
                        repository: RULES,
                        ref: "v3",
                        kodyRuleSource: false,
                    },
                ],
                "valves",
            ),
        ).toEqual([
            {
                path: "docs/valves.md",
                kind: "doc",
                repository: RULES,
                name: undefined,
                linked: true,
                kodyRuleSource: false,
            },
            {
                path: "docs/pumps.md",
                kind: "doc",
                repository: RULES,
                ref: "v3",
                name: undefined,
                linked: false,
                kodyRuleSource: false,
            },
        ]);
    });
});

describe("mentionedButNotFollowed", () => {
    const instructions =
        "Olhe as regras no linked repository irrigation-rules. Comece por global/rules/boas-praticas.mdc.";

    it("names a linked repository the instructions mention and the agent follows nothing from", () => {
        expect(
            mentionedButNotFollowed(
                instructions,
                [RULES, "greenhouse/dashboard"],
                [],
                "valves",
            ),
        ).toEqual([RULES]);
        expect(
            mentionedButNotFollowed(
                `Read ${RULES} first.`,
                [RULES],
                [],
                "valves",
            ),
        ).toEqual([RULES]);
    });

    it("stops once the agent follows something from it", () => {
        expect(
            mentionedButNotFollowed(instructions, [RULES], [remote], "valves"),
        ).toEqual([]);
    });

    it("does not count a link that is another agent's, nor a name inside a longer word", () => {
        expect(
            mentionedButNotFollowed(
                instructions,
                [RULES],
                [{ ...remote, linkedTo: [{ agentId: "pumps" }] }],
                "valves",
            ),
        ).toEqual([RULES]);
        expect(
            mentionedButNotFollowed(
                "Follow irrigation-rules-v2 conventions.",
                [RULES],
                [],
                "valves",
            ),
        ).toEqual([]);
    });
});
