import { draftOf, modeOf, sameDraft, toPayload } from "./rules";

describe("Runtime 'When it runs' draft (screen 2)", () => {
    it("reads the saved settings, with the old pilot switch as on request", () => {
        expect(draftOf(undefined)).toEqual({
            mode: "off",
            whoCanAsk: "writers",
            runOnAgentPullRequests: false,
            runOnNewPushes: false,
            rules: [],
        });
        expect(
            draftOf({
                repositoryId: "r",
                pilot: true,
                whoCanAsk: "maintainers",
            }).mode,
        ).toBe("on_request");
        expect(
            draftOf({
                repositoryId: "r",
                pilot: true,
                whoCanAsk: "writers",
                mode: "rules",
                rules: [
                    {
                        conditions: [
                            { field: "files_changed", moreThan: 30 },
                            { field: "label", includes: "payments" },
                        ],
                    },
                ],
            }).rules,
        ).toEqual([
            {
                conditions: [
                    { field: "files_changed", value: "30" },
                    { field: "label", value: "payments" },
                ],
            },
        ]);
    });

    it("turns the draft into the API body, trimming and typing the values", () => {
        const draft = {
            ...draftOf(undefined),
            mode: "rules" as const,
            rules: [
                {
                    conditions: [
                        {
                            field: "changed_paths" as const,
                            value: " db/migrations/** ",
                        },
                    ],
                },
                {
                    conditions: [
                        { field: "files_changed" as const, value: "30" },
                    ],
                },
            ],
        };
        expect(toPayload(draft)).toEqual({
            ok: true,
            body: {
                ...draft,
                rules: [
                    {
                        conditions: [
                            {
                                field: "changed_paths",
                                matches: "db/migrations/**",
                            },
                        ],
                    },
                    { conditions: [{ field: "files_changed", moreThan: 30 }] },
                ],
            },
        });
    });

    it("refuses Rules without a rule, an empty condition or a count that is not a whole number", () => {
        const base = { ...draftOf(undefined), mode: "rules" as const };
        expect(toPayload(base)).toMatchObject({ ok: false });
        expect(
            toPayload({
                ...base,
                rules: [{ conditions: [{ field: "label", value: " " }] }],
            }),
        ).toMatchObject({ ok: false });
        expect(
            toPayload({
                ...base,
                rules: [
                    { conditions: [{ field: "files_changed", value: "2.5" }] },
                ],
            }),
        ).toMatchObject({ ok: false });
    });

    it("outside Rules mode, a half-written rule neither blocks the save nor is sent", () => {
        const draft = {
            ...draftOf(undefined),
            mode: "on_request" as const,
            rules: [
                {
                    conditions: [
                        { field: "files_changed" as const, value: "" },
                    ],
                },
            ],
        };
        const out = toPayload(draft);
        expect(out.ok).toBe(true);
        // `rules` left out: the API keeps the saved ones for when Rules is picked again.
        expect(out.ok && "rules" in out.body).toBe(false);
        expect(out.ok && out.body.mode).toBe("on_request");
    });

    it("reads the mode of a row written before `mode` existed", () => {
        expect(modeOf(undefined)).toBe("off");
        expect(modeOf({ pilot: true })).toBe("on_request");
        expect(modeOf({ pilot: false, mode: "rules" })).toBe("rules");
    });

    it("compares drafts by value", () => {
        expect(sameDraft(draftOf(undefined), draftOf(undefined))).toBe(true);
        expect(
            sameDraft(draftOf(undefined), {
                ...draftOf(undefined),
                runOnNewPushes: true,
            }),
        ).toBe(false);
    });
});
