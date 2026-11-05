/**
 * Skills and docs of another repository on the settings screens (#2329).
 * Fixture domain: an invented greenhouse-irrigation team and its rules repo.
 */
import {
    knowledgeChoices,
    knowledgeKey,
    mentionedButNotFollowed,
    mentionedFilesNotFollowed,
    prepareKnowledgeForSave,
    sameKnowledge,
    setAgentKnowledge,
} from "./drafts";
import type { KnowledgeItem } from "./types";

const RULES = "greenhouse/irrigation-rules";
const OTHER_RULES = "greenhouse/pump-rules";
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
            sameKnowledge(remote, { ...remote, repository: OTHER_RULES }),
        ).toBe(false);
        expect(
            sameKnowledge(remote, {
                ...remote,
                repository: RULES.toUpperCase(),
            }),
        ).toBe(true);
    });

    it("reads a stored repository that is not text as naming none, instead of failing the page", () => {
        const odd = { ...local, repository: 42 as unknown as string };

        expect(() => sameKnowledge(odd, local)).not.toThrow();
        expect(sameKnowledge(odd, local)).toBe(true);
        expect(knowledgeKey(odd)).toBe(knowledgeKey(local));
    });

    it("keys a repository in any case as one item, so it is not added twice", () => {
        expect(knowledgeKey(remote)).toBe(
            knowledgeKey({ ...remote, repository: RULES.toUpperCase() }),
        );
        expect(knowledgeKey(remote)).not.toBe(knowledgeKey(local));
        expect(knowledgeKey(remote)).not.toBe(
            knowledgeKey({ ...remote, repository: OTHER_RULES }),
        );
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

describe("mentionedFilesNotFollowed", () => {
    // The shape production agents use (#2384): the rule file is named in the
    // instructions and never linked, so the agent reads it only if it decides
    // to, and a finding cannot cite it.
    const readThisFile =
        "A regra completa está no repositório greenhouse/irrigation-rules, branch main, arquivo stack/rails/rules/watering-queries.mdc. Leia esse arquivo antes de comentar.";

    it("offers the file the instructions name, in the linked repository named before it", () => {
        expect(
            mentionedFilesNotFollowed(readThisFile, [RULES], [], "valves"),
        ).toEqual([
            {
                path: "stack/rails/rules/watering-queries.mdc",
                kind: "doc",
                repository: RULES,
            },
        ]);
        expect(
            mentionedFilesNotFollowed(
                "Olhe as regras no linked repository irrigation-rules. Comece por global/rules/boas-praticas.mdc.",
                [RULES, OTHER_RULES],
                [],
                "valves",
            ),
        ).toEqual([
            {
                path: "global/rules/boas-praticas.mdc",
                kind: "doc",
                repository: RULES,
            },
        ]);
    });

    it("stops once this agent follows that file, and not for another file of the repository", () => {
        const followed: KnowledgeItem = {
            path: "stack/rails/rules/watering-queries.mdc",
            kind: "doc",
            repository: RULES,
            linkedTo: [{ agentId: "valves" }],
        };
        expect(
            mentionedFilesNotFollowed(
                readThisFile,
                [RULES],
                [followed],
                "valves",
            ),
        ).toEqual([]);
        expect(
            mentionedFilesNotFollowed(
                readThisFile,
                [RULES],
                [{ ...followed, linkedTo: [{ agentId: "pumps" }] }],
                "valves",
            ),
        ).toHaveLength(1);
        expect(
            mentionedFilesNotFollowed(
                readThisFile,
                [RULES],
                [remote],
                "valves",
            ),
        ).toHaveLength(1);
    });

    it("places a file in the reviewed repository when the instructions name no repository", () => {
        expect(
            mentionedFilesNotFollowed(
                "Follow docs/conventions.md and skills/billing/SKILL.md; see docs/conventions.md again.",
                [RULES],
                [],
                "valves",
            ),
        ).toEqual([
            { path: "docs/conventions.md", kind: "doc" },
            { path: "skills/billing", kind: "skill" },
        ]);
    });

    // "irrigation-rules/valves.md" may be the reviewed repository's own
    // folder: only the full owner/repo prefix places a file elsewhere.
    it("takes no repository name inside a path as a mention, and places a file by its full owner/repo prefix only", () => {
        expect(
            mentionedFilesNotFollowed(
                "Follow irrigation-rules/valves.md and docs/conventions.md.",
                [RULES],
                [],
                "valves",
            ),
        ).toEqual([{ path: "docs/conventions.md", kind: "doc" }]);
        expect(
            mentionedFilesNotFollowed(
                `Read ${RULES}/stack/node/valves.mdc first.`,
                [RULES],
                [],
                "valves",
            ),
        ).toEqual([
            { path: "stack/node/valves.mdc", kind: "doc", repository: RULES },
        ]);
    });

    it("places a file under a full name of more than two segments (GitLab subgroup, Azure project)", () => {
        const nested = "greenhouse/irrigation/rules";
        expect(
            mentionedFilesNotFollowed(
                `Read ${nested}/stack/node/valves.mdc first.`,
                [nested, RULES],
                [],
                "valves",
            ),
        ).toEqual([
            { path: "stack/node/valves.mdc", kind: "doc", repository: nested },
        ]);
    });

    // Review: instructions name files that are not rules, and use "repository"
    // for code ("the repository pattern"), not for where a file lives.
    it("offers no file that is not a rule: README, CHANGELOG, requirements.txt", () => {
        expect(
            mentionedFilesNotFollowed(
                "Flag new deps not pinned in requirements.txt. Make sure CHANGELOG.md is updated, see README.md.",
                [],
                [],
                "valves",
            ),
        ).toEqual([]);
    });

    it('reads "repository" as a location only in the sentence that names the file', () => {
        expect(
            mentionedFilesNotFollowed(
                "Use the repository pattern. Read docs/conventions.md before reviewing.",
                [],
                [],
                "valves",
            ),
        ).toEqual([{ path: "docs/conventions.md", kind: "doc" }]);
    });

    it("places a file by a linked repository named after it in the same sentence", () => {
        expect(
            mentionedFilesNotFollowed(
                "Read stack/node/valves.mdc in irrigation-rules before commenting.",
                [RULES],
                [],
                "valves",
            ),
        ).toEqual([
            { path: "stack/node/valves.mdc", kind: "doc", repository: RULES },
        ]);
    });

    it("does not end a sentence at a wrapped line", () => {
        expect(
            mentionedFilesNotFollowed(
                "Read stack/node/valves.mdc\nin irrigation-rules before commenting.",
                [RULES],
                [],
                "valves",
            ),
        ).toEqual([
            { path: "stack/node/valves.mdc", kind: "doc", repository: RULES },
        ]);
    });

    it("reads the word repository only on the file's own line", () => {
        expect(
            mentionedFilesNotFollowed(
                "Read docs/conventions.md before reviewing,\nand keep the repository tidy.",
                [],
                [],
                "valves",
            ),
        ).toEqual([{ path: "docs/conventions.md", kind: "doc" }]);
    });

    it("offers nothing when the place wraps onto the next line of the file's sentence", () => {
        expect(
            mentionedFilesNotFollowed(
                "Read stack/node/valves.mdc\nin the pump-rules repository before commenting.",
                [RULES],
                [],
                "valves",
            ),
        ).toEqual([]);
    });

    it("reads a code-quoted or longer place phrase", () => {
        for (const place of [
            "in the `pump-rules` repository",
            "in our shared pump rules repository",
            "no repositório `acme/pump-rules`",
        ]) {
            expect(
                mentionedFilesNotFollowed(
                    `Read stack/node/valves.mdc ${place} before commenting.`,
                    [RULES],
                    [],
                    "valves",
                ),
            ).toEqual([]);
        }
    });

    it('does not take "in the repository" (this one) as another repository', () => {
        expect(
            mentionedFilesNotFollowed(
                "Read docs/conventions.md in the repository before commenting.",
                [],
                [],
                "valves",
            ),
        ).toEqual([{ path: "docs/conventions.md", kind: "doc" }]);
    });

    it("ends a sentence at a CRLF blank line", () => {
        expect(
            mentionedFilesNotFollowed(
                "Read docs/conventions.md\r\n\r\nirrigation-rules holds the pump rules",
                [RULES],
                [],
                "valves",
            ),
        ).toEqual([{ path: "docs/conventions.md", kind: "doc" }]);
    });

    it("does not end a sentence at the dot inside a file name", () => {
        expect(
            mentionedFilesNotFollowed(
                "In the pump-rules repository, see docs/a.md and rules.md.",
                [RULES],
                [],
                "valves",
            ),
        ).toEqual([]);
    });

    it("guesses nothing: a repository that is not linked, a code file, a URL", () => {
        expect(
            mentionedFilesNotFollowed(
                "Read rules.md in the pump-rules repository.",
                [RULES],
                [],
                "valves",
            ),
        ).toEqual([]);
        expect(
            mentionedFilesNotFollowed(
                "Check db/schema.rb and https://example.com/guide.md before flagging.",
                [RULES],
                [],
                "valves",
            ),
        ).toEqual([]);
    });
});
