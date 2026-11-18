import {
    canRevokeCellToken,
    cellRegisterSteps,
    defaultCellTopology,
} from "./cell-registration";

describe("connecting a cell", () => {
    it("a self-hosted install connects self-hosted cells by default; Kodus Cloud, cells in your cloud", () => {
        expect(defaultCellTopology(true)).toBe("self_hosted");
        expect(defaultCellTopology(false)).toBe("hybrid");
    });

    it("the self-hosted commands need no value written by hand and never carry the token", () => {
        const { commands } = cellRegisterSteps("self_hosted");
        const all = commands.join("\n");
        expect(all).not.toMatch(/<[^>]+>/);
        expect(all).not.toContain("kcr_");
        // No topology, isolation or capacity flag: the token and the host decide them.
        expect(all).not.toMatch(/-topology|isolation-backend|mem-max|cpus-max/);
        expect(commands[0]).toContain("read -rs KODUS_CELL_REGISTRATION_TOKEN");
    });

    it("a cell in your cloud names the hub and CA Kodus gives you, still without the token", () => {
        const all = cellRegisterSteps("hybrid").commands.join("\n");
        expect(all).toContain("cell register");
        expect(all).not.toContain("kcr_");
    });

    it("only a pending token can be revoked", () => {
        expect(canRevokeCellToken("pending")).toBe(true);
        for (const s of ["used", "expired", "revoked"] as const)
            expect(canRevokeCellToken(s)).toBe(false);
    });
});
