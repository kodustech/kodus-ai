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

    it("takes no place phrase that crosses a sentence end", () => {
        expect(
            mentionedFilesNotFollowed(
                "Read docs/conventions.md in full. Pump repository notes follow.",
                [],
                [],
                "valves",
            ),
        ).toEqual([{ path: "docs/conventions.md", kind: "doc" }]);
    });

    it("keeps a crossing place phrase whose own sentence names an owner/name place", () => {
        expect(
            mentionedFilesNotFollowed(
                "Read docs/conventions.md in acme/rules. Repository notes follow.",
                [],
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

    describe("the file's own sentence decides where it lives", () => {
        const placed = (text: string, repositories: string[]) =>
            mentionedFilesNotFollowed(text, repositories, [], "valves").map(
                (file) => `${file.repository ?? "(reviewed)"}:${file.path}`,
            );

        it("places a file by its own sentence over a repository named earlier", () => {
            expect(
                placed(
                    "Read irrigation-rules first. Read docs/pumps.md in pump-rules.",
                    [RULES, OTHER_RULES],
                ),
            ).toEqual([`${OTHER_RULES}:docs/pumps.md`]);
        });

        it("offers nothing when its own sentence names a repository that is not linked, even after a linked one", () => {
            expect(
                placed(
                    "Read irrigation-rules first. Read docs/pumps.md in the pump-rules repository.",
                    [RULES],
                ),
            ).toEqual([]);
        });

        it("does not take another owner's repository for the linked one of the same name", () => {
            expect(
                placed(
                    "Read docs/pumps.md in the repository other/irrigation-rules.",
                    [RULES],
                ),
            ).toEqual([]);
            expect(
                placed("Read docs/pumps.md in other/irrigation-rules.", [
                    RULES,
                ]),
            ).toEqual([]);
        });

        it("offers nothing for a file placed in an owner/name that is not linked", () => {
            expect(placed("Read docs/pumps.md in acme/rules.", [])).toEqual([]);
            expect(
                placed(
                    "Read docs/pumps.md from https://github.com/acme/rules.",
                    [],
                ),
            ).toEqual([]);
            // A link to an issue is not a repository the file lives in.
            expect(
                placed(
                    "As discussed in https://github.com/acme/app/issues/12, read docs/pumps.md.",
                    [],
                ),
            ).toEqual(["(reviewed):docs/pumps.md"]);
        });

        it("gives each file of one sentence the place right after it", () => {
            expect(
                placed(
                    "Read docs/a.md in the irrigation-rules repository and docs/b.md in the pump-rules repository.",
                    [RULES],
                ),
            ).toEqual([`${RULES}:docs/a.md`]);
        });

        it("does not let an earlier file's place drop a later file placed right after it", () => {
            expect(
                placed(
                    "Read docs/a.md in the pump-rules repository and docs/b.md from irrigation-rules.",
                    [RULES],
                ),
            ).toEqual([`${RULES}:docs/b.md`]);
        });

        it("offers nothing when its sentence names two linked repositories and neither is attached to it", () => {
            expect(
                placed("Compare pump-rules with docs/a.md, irrigation-rules.", [
                    RULES,
                    OTHER_RULES,
                ]),
            ).toEqual([]);
        });

        it("places a file by a linked repository in parentheses right after it", () => {
            expect(
                placed(
                    "Compare pump-rules with docs/a.md (irrigation-rules).",
                    [RULES, OTHER_RULES],
                ),
            ).toEqual([`${RULES}:docs/a.md`]);
        });

        it("places every file of a list by what its last file is attached to", () => {
            expect(
                placed(
                    "For pump-rules work, read docs/a.md, docs/b.md and docs/c.md in irrigation-rules.",
                    [RULES, OTHER_RULES],
                ),
            ).toEqual([
                `${RULES}:docs/a.md`,
                `${RULES}:docs/b.md`,
                `${RULES}:docs/c.md`,
            ]);
        });

        it("offers nothing for a list item whose sentence names another place than the list's", () => {
            // The list's place, a linked owner/name or its URL, still places
            // the file it is attached to.
            for (const listPlace of [
                `in ${OTHER_RULES}`,
                `from https://github.com/${OTHER_RULES}`,
            ]) {
                expect(
                    placed(
                        `In the irrigation-rules repository, see docs/a.md and docs/b.md ${listPlace}.`,
                        [RULES, OTHER_RULES],
                    ),
                ).toEqual([`${OTHER_RULES}:docs/b.md`]);
            }
            expect(
                placed(
                    "In the pump-rules repository, see docs/a.md and rules.md in acme/rules.",
                    [OTHER_RULES],
                ),
            ).toEqual([]);
            // A place that follows another file is that file's, not the
            // sentence's.
            expect(
                placed(
                    "Read docs/a.md and docs/b.md in irrigation-rules, then docs/c.md in the pump-rules repository.",
                    [RULES, OTHER_RULES],
                ),
            ).toEqual([
                `${RULES}:docs/a.md`,
                `${RULES}:docs/b.md`,
                `${OTHER_RULES}:docs/c.md`,
            ]);
        });

        it("offers nothing for a file placed in two repositories joined by and/or", () => {
            for (const text of [
                "Read docs/a.md from irrigation-rules or pump-rules.",
                "Read docs/a.md from irrigation-rules and/or pump-rules.",
                "Read docs/a.md (irrigation-rules or pump-rules).",
                "Read docs/a.md in the irrigation-rules or pump-rules repository.",
                "In the irrigation-rules or pump-rules repository, read docs/a.md.",
                `Read docs/a.md in ${RULES} and ${OTHER_RULES}.`,
                "Read docs/a.md and docs/b.md from irrigation-rules and pump-rules.",
                "Use irrigation-rules and pump-rules.\n\nRead docs/a.md.",
            ]) {
                expect(placed(text, [RULES, OTHER_RULES])).toEqual([]);
            }
            // Each file with its own repository is no choice.
            expect(
                placed(
                    "Read docs/a.md from irrigation-rules and docs/b.md from pump-rules.",
                    [RULES, OTHER_RULES],
                ),
            ).toEqual([`${RULES}:docs/a.md`, `${OTHER_RULES}:docs/b.md`]);
        });

        it("offers nothing for a choice of repositories written out in full", () => {
            for (const text of [
                "Read docs/a.md in the pump-rules repository or the irrigation-rules repository.",
                "In the pump-rules repository or the irrigation-rules repository, read docs/a.md.",
                `Read docs/a.md in ${OTHER_RULES} or in ${RULES}.`,
                "Read docs/a.md from pump-rules (or irrigation-rules).",
                "Read docs/a.md from pump-rules, irrigation-rules or another one.",
                `Leia docs/a.md no repositório ${OTHER_RULES} ou no repositório ${RULES}.`,
            ]) {
                expect(placed(text, [RULES, OTHER_RULES])).toEqual([]);
            }
            // A repository named after the file's own place is no choice.
            expect(
                placed(
                    "Read docs/a.md in the pump-rules repository, then compare it with irrigation-rules.",
                    [RULES, OTHER_RULES],
                ),
            ).toEqual([`${OTHER_RULES}:docs/a.md`]);
        });

        it("places one file in each of two clauses that each name their own repository", () => {
            for (const [text, first, second] of [
                [
                    "Follow docs/conventions.md in the pump-rules repository, and in the irrigation-rules repository read docs/valves.md.",
                    "docs/conventions.md",
                    "docs/valves.md",
                ],
                [
                    "Read docs/a.md in the pump-rules repository, or in the irrigation-rules repository, read docs/b.md.",
                    "docs/a.md",
                    "docs/b.md",
                ],
                [
                    `Leia docs/a.md no repositório ${OTHER_RULES}, e no repositório ${RULES} leia docs/b.md.`,
                    "docs/a.md",
                    "docs/b.md",
                ],
            ]) {
                expect(placed(text, [RULES, OTHER_RULES])).toEqual([
                    `${OTHER_RULES}:${first}`,
                    `${RULES}:${second}`,
                ]);
            }
            // A choice the sentence goes on from is still a choice: the
            // file after it is not the second repository's own.
            for (const text of [
                "Read docs/a.md from pump-rules or irrigation-rules, then docs/b.md.",
                "Read docs/a.md in pump-rules or in irrigation-rules, then docs/b.md.",
            ]) {
                expect(placed(text, [RULES, OTHER_RULES])).toEqual([]);
            }
        });

        it("keeps a clause whose own verb carries an adverb", () => {
            for (const text of [
                "Follow docs/conventions.md in the pump-rules repository, and in the irrigation-rules repository also read docs/valves.md.",
                `Leia docs/conventions.md no repositório ${OTHER_RULES}, e no repositório ${RULES} também leia docs/valves.md.`,
            ]) {
                expect(placed(text, [RULES, OTHER_RULES])).toEqual([
                    `${OTHER_RULES}:docs/conventions.md`,
                    `${RULES}:docs/valves.md`,
                ]);
            }
        });

        it("places a file in the reviewed repository its sentence names over a repository named earlier", () => {
            for (const text of [
                "Use acme/rules. Read docs/conventions.md in this repository.",
                "Use acme/rules. In the same repository, read docs/conventions.md.",
                "Use acme/rules. Leia docs/conventions.md neste repositório.",
            ]) {
                expect(placed(text, ["acme/rules"])).toEqual([
                    "(reviewed):docs/conventions.md",
                ]);
            }
            // A linked name right after it makes it a named place.
            expect(
                placed(
                    "Read docs/conventions.md in the repository irrigation-rules.",
                    [RULES],
                ),
            ).toEqual([`${RULES}:docs/conventions.md`]);
        });

        it("does not cut a repository name at a dot inside it", () => {
            for (const text of [
                "Read docs/conventions.md in acme/rules.v2.",
                "Read docs/conventions.md from https://github.com/acme/rules.v2.",
            ]) {
                expect(placed(text, ["acme/rules"])).toEqual([]);
            }
            expect(
                placed("Read docs/conventions.md in acme/rules.", [
                    "acme/rules",
                ]),
            ).toEqual(["acme/rules:docs/conventions.md"]);
        });

        it("offers nothing when two linked repositories share the short name the sentence uses", () => {
            for (const repositories of [
                ["acme/rules", "other/rules"],
                ["other/rules", "acme/rules"],
            ]) {
                expect(
                    placed(
                        "Read docs/conventions.md in the rules repository.",
                        repositories,
                    ),
                ).toEqual([]);
            }
        });

        it("offers nothing for a choice whose other side is not linked", () => {
            for (const text of [
                "Read docs/conventions.md in acme/rules or other/policies.",
                "Read docs/conventions.md in other/policies or acme/rules.",
                "Read docs/conventions.md from https://github.com/acme/rules or https://github.com/other/policies.",
            ]) {
                expect(placed(text, ["acme/rules"])).toEqual([]);
            }
        });

        it("offers nothing for a file whose sentence names a choice with an unlinked side", () => {
            for (const text of [
                "In pump-rules or acme/style, read docs/a.md.",
                "Read docs/a.md, kept in pump-rules or acme/style.",
            ]) {
                expect(placed(text, [RULES, OTHER_RULES])).toEqual([]);
            }
        });

        it("places a file compared to another repository in that repository", () => {
            for (const text of [
                "Read docs/conventions.md in the same repo as acme/rules.",
                "Read docs/conventions.md in the same repository as https://github.com/acme/rules.",
                "Leia docs/conventions.md no mesmo repositório que acme/rules.",
            ]) {
                expect(placed(text, ["acme/rules"])).toEqual([
                    "acme/rules:docs/conventions.md",
                ]);
            }
            // An unlinked one places nowhere; a linked one in the same
            // sentence still places its own file.
            expect(
                placed(
                    "Read docs/conventions.md in the same repo as acme/rules and docs/valves.md in the same repo as other/policies.",
                    ["acme/rules"],
                ),
            ).toEqual(["acme/rules:docs/conventions.md"]);
        });

        it("keeps a comparison that names no repository as the reviewed one", () => {
            for (const text of [
                "Use acme/rules. Read docs/conventions.md in the same repo as before.",
                "Use acme/rules. Leia docs/conventions.md no mesmo repositório que usamos.",
            ]) {
                expect(placed(text, ["acme/rules"])).toEqual([
                    "(reviewed):docs/conventions.md",
                ]);
            }
        });

        it("offers nothing for a file compared to a repository named with its noun and not linked", () => {
            expect(
                placed(
                    "Read docs/conventions.md in the same repo as the pump-rules repository.",
                    [RULES],
                ),
            ).toEqual([]);
            expect(
                placed(
                    "Read docs/conventions.md in the same repository as the pump-rules repository.",
                    [RULES],
                ),
            ).toEqual([]);
        });

        it("reads a comparison within its own sentence", () => {
            for (const text of [
                "Read docs/conventions.md in the same repo as before. Follow every repository rule.",
                "Read docs/conventions.md in the same repo as our guide. The repository rules apply.",
            ]) {
                expect(placed(text, [RULES])).toEqual([
                    "(reviewed):docs/conventions.md",
                ]);
            }
        });

        it("reads a Portuguese list as it reads an English one", () => {
            expect(
                placed(
                    `No repositório ${RULES}, leia docs/a.md e docs/b.md no repositório ${OTHER_RULES}.`,
                    [RULES, OTHER_RULES],
                ),
            ).toEqual([`${OTHER_RULES}:docs/b.md`]);
            expect(
                placed(
                    `Leia docs/a.md ou docs/b.md no repositório ${OTHER_RULES}.`,
                    [RULES, OTHER_RULES],
                ),
            ).toEqual([`${OTHER_RULES}:docs/a.md`, `${OTHER_RULES}:docs/b.md`]);
        });

        it("does not offer a file again where only a fallback places it", () => {
            expect(
                placed(
                    "Read docs/a.md. docs/a.md lives in the pump-rules repository.",
                    [OTHER_RULES],
                ),
            ).toEqual([`${OTHER_RULES}:docs/a.md`]);
            expect(
                placed("Read docs/a.md. docs/a.md lives in acme/rules.", []),
            ).toEqual([]);
        });
    });
});
