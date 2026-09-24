import { middleEllipsis } from "./middle-ellipsis";

describe("middleEllipsis", () => {
    it("leaves text that fits untouched", () => {
        expect(middleEllipsis("kodus-ai", 36)).toBe("kodus-ai");
        expect(middleEllipsis("x".repeat(36), 36)).toBe("x".repeat(36));
    });

    it("keeps both ends of a repository name, cut at its hyphens", () => {
        expect(
            middleEllipsis("kodus-service-billing-reconciliation-worker", 36),
        ).toBe("kodus-service-billing-…-worker");
        expect(
            middleEllipsis("kodus-service-analytics-warehouse-ingest", 36),
        ).toBe("kodus-service-analytics-…-ingest");
    });

    it("tells apart names that only differ at the end", () => {
        const a = middleEllipsis("acme-platform-service-billing-worker", 30);
        const b = middleEllipsis("acme-platform-service-billing-api", 30);
        expect(a).not.toBe(b);
    });

    it("cuts mid-word when the name has no separators", () => {
        const cut = middleEllipsis("a".repeat(20) + "b".repeat(20), 21);
        expect(cut.length).toBeLessThanOrEqual(21);
        expect(cut.startsWith("a")).toBe(true);
        expect(cut.endsWith("b")).toBe(true);
        expect(cut).toContain("…");
    });

    it("never returns more than max characters", () => {
        for (const name of [
            "kodus-service-billing-reconciliation-worker",
            "kodustech/kodus-service-billing-reconciliation-worker-v2",
            "group/subgroup/deeply/nested/repository-name",
            "a".repeat(80),
        ]) {
            for (const max of [20, 30, 36, 44]) {
                expect(middleEllipsis(name, max).length).toBeLessThanOrEqual(
                    max,
                );
            }
        }
    });
});
