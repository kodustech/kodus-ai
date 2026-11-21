import { hunkAround } from "./diff-hunk";
import { findingHeadline, findingProof } from "./finding-headline";
import type { Finding } from "./findings";

const side = (answer: string, status?: number): Finding["base"] => ({
    side: "base",
    sha: "abc1234",
    answer,
    steady: true,
    rounds: [{ stepId: "s", round: 1, answer, status, lost: false }],
});

const finding = (over: Partial<Finding> = {}): Finding => ({
    baseLabel: "main",
    probeId: "p1",
    entryPoint: "POST /orders",
    route: "POST /orders",
    intended: false,
    change: "",
    differingFields: [],
    base: side("201", 201),
    pr: { ...side("400", 400), side: "pr" },
    proof: "",
    evidenceKind: "http",
    reproducible: false,
    boot: false,
    destabilizes: false,
    ...over,
});

describe("findingHeadline", () => {
    it("states a status change from the data", () => {
        expect(
            findingHeadline(finding({ purpose: "Exercise the boundary" })),
        ).toBe("POST /orders now returns 400 instead of 201");
    });

    it("says a 5xx fails", () => {
        expect(
            findingHeadline(
                finding({ pr: { ...side("500", 500), side: "pr" } }),
            ),
        ).toBe("POST /orders now fails with 500 instead of 201");
    });

    it("names the field of a body-only change", () => {
        const f = finding({
            pr: { ...side("201", 201), side: "pr" },
            responseDiff: {
                truncated: false,
                fields: [{ path: "body.id", base: "3" }],
            },
        });
        expect(findingHeadline(f)).toBe("POST /orders no longer returns id");
        expect(
            findingHeadline({
                ...f,
                responseDiff: {
                    truncated: false,
                    fields: [{ path: "body.extra", pr: "1" }],
                },
            }),
        ).toBe("POST /orders now also returns extra");
    });

    it("falls back when the data says nothing", () => {
        const f = finding({
            base: side("not recorded"),
            pr: { ...side("not recorded"), side: "pr" },
            route: "GET web:3000/x",
            request: "GET web:3000/x",
        });
        expect(findingHeadline(f)).toBe(
            "GET /x behaves differently on this PR",
        );
    });
});

describe("findingProof", () => {
    it("shows both sides with the error message", () => {
        const proof = findingProof(
            finding({
                responseDiff: {
                    truncated: false,
                    fields: [
                        {
                            path: "body.error",
                            pr: "quantity must be at most 100",
                        },
                    ],
                },
            }),
        );
        expect(proof).toEqual({
            request: "POST /orders",
            base: "201 Created",
            pr: '400 Bad Request "quantity must be at most 100"',
        });
    });
});

describe("hunkAround", () => {
    const patch = "@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n d\n";
    it("marks the hit line with its context", () => {
        const rows = hunkAround(patch, 2, 2)!;
        expect(rows.find((r) => r.hit)).toMatchObject({
            kind: "add",
            text: "B",
        });
        expect(rows.map((r) => r.kind)).toEqual([
            "context",
            "del",
            "add",
            "context",
            "context",
        ]);
    });
    it("is undefined when the patch lacks the line", () => {
        expect(hunkAround(patch, 99)).toBeUndefined();
        expect(hunkAround(undefined, 2)).toBeUndefined();
    });
});
