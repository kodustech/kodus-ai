import { MCP_CONNECTION_STATUS } from "@services/mcp-manager/types";

import {
    computeLockedPluginIds,
    countInstalledPlugins,
} from "./compute-locked-plugins";

const connected = (id: string, overrides: Partial<{
    isDefault: boolean;
    connectionStatus: MCP_CONNECTION_STATUS;
}> = {}) => ({
    id,
    isConnected: true,
    isDefault: false,
    connectionStatus: MCP_CONNECTION_STATUS.ACTIVE,
    ...overrides,
});

describe("computeLockedPluginIds", () => {
    it("returns nothing when the plan isn't limited", () => {
        const plugins = [connected("a"), connected("b"), connected("c")];
        expect(
            computeLockedPluginIds(plugins, [], false, 3),
        ).toEqual(new Set());
    });

    it("never locks default (system-managed) plugins, even when /mcp/connections is empty", () => {
        // Regression: "Kodus MCP" is isConnected+ACTIVE+isDefault but never
        // appears in /mcp/connections. Before excluding isDefault, an empty
        // orderedActiveIntegrationIds made the runnable set empty, so this
        // single always-on default plugin was wrongly marked locked.
        const defaultPlugin = connected("kd_mcp", { isDefault: true });

        const locked = computeLockedPluginIds(
            [defaultPlugin],
            [], // /mcp/connections came back empty for this default plugin
            true,
            3,
        );

        expect(locked.has("kd_mcp")).toBe(false);
        expect(locked.size).toBe(0);
    });

    it("locks connected non-default plugins beyond the cap, oldest-first kept runnable", () => {
        const plugins = [
            connected("exa"),
            connected("osv"),
            connected("docs"),
            connected("issues"),
        ];
        // oldest-first order, as returned by /mcp/connections (createdAt ASC)
        const ordered = ["exa", "osv", "docs", "issues"];

        const locked = computeLockedPluginIds(plugins, ordered, true, 3);

        expect(locked).toEqual(new Set(["issues"]));
    });

    it("does not lock plugins beyond the cap that aren't connected", () => {
        const plugins = [
            connected("exa"),
            connected("osv"),
            connected("docs"),
            { id: "issues", isConnected: false, isDefault: false },
        ];

        const locked = computeLockedPluginIds(
            plugins,
            ["exa", "osv", "docs"],
            true,
            3,
        );

        expect(locked.size).toBe(0);
    });

    it("does not lock a PENDING connection even if it falls outside the runnable set", () => {
        const plugins = [
            connected("exa"),
            connected("osv"),
            connected("docs"),
            connected("issues", {
                connectionStatus: MCP_CONNECTION_STATUS.PENDING,
            }),
        ];

        const locked = computeLockedPluginIds(
            plugins,
            ["exa", "osv", "docs", "issues"],
            true,
            3,
        );

        expect(locked.size).toBe(0);
    });

    it("locks nothing when connected count is within the cap", () => {
        const plugins = [connected("exa"), connected("osv")];
        const locked = computeLockedPluginIds(
            plugins,
            ["exa", "osv"],
            true,
            3,
        );

        expect(locked.size).toBe(0);
    });
});

describe("countInstalledPlugins", () => {
    it("excludes default plugins from the installed count", () => {
        const plugins = [
            connected("exa"),
            connected("kd_mcp", { isDefault: true }),
        ];

        expect(countInstalledPlugins(plugins)).toBe(1);
    });

    it("excludes non-connected plugins", () => {
        const plugins = [
            connected("exa"),
            { id: "osv", isConnected: false, isDefault: false },
        ];

        expect(countInstalledPlugins(plugins)).toBe(1);
    });
});
