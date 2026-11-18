import { egressLastUseLabel, egressTierLabel, sortEgressApprovals } from "./egress";

describe("egress approval labels", () => {
    it("says reads only, with the paths when they narrow it, and full access otherwise", () => {
        expect(egressTierLabel({ mode: "inspected", pathPrefixes: ["/"] })).toBe("Reads only");
        expect(egressTierLabel({ mode: "inspected", pathPrefixes: ["/xlsx-"] })).toBe("Reads only under /xlsx-");
        expect(egressTierLabel({ mode: "passthrough" })).toBe("Full access");
        // An approval made before tiers has no mode: it was full access.
        expect(egressTierLabel({})).toBe("Full access");
    });

    it("says when a claim last got the host, since approvals never expire (D5)", () => {
        expect(egressLastUseLabel({ lastSentAt: "2026-11-13T10:00:00.000Z" })).toBe("Last used");
        expect(egressLastUseLabel({})).toBe("Not used yet");
        expect(egressLastUseLabel({ revokedAt: "2026-11-13T10:00:00.000Z", lastSentAt: "2026-11-13T09:00:00.000Z" })).toBe("Revoked");
    });

    it("lists live approvals first, newest first", () => {
        const rows = sortEgressApprovals([
            { host: "old.example", approvedAt: "2026-11-01T00:00:00.000Z" },
            { host: "gone.example", approvedAt: "2026-11-12T00:00:00.000Z", revokedAt: "2026-11-13T00:00:00.000Z" },
            { host: "new.example", approvedAt: "2026-11-10T00:00:00.000Z" },
        ]);
        expect(rows.map((r) => r.host)).toEqual(["new.example", "old.example", "gone.example"]);
    });
});
