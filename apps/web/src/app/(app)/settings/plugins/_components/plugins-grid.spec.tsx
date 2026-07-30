/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MCP_CONNECTION_STATUS } from "@services/mcp-manager/types";
import { SubscriptionProvider } from "src/features/ee/subscription/_providers/subscription-context";

import { PluginsGrid } from "./plugins-grid";

jest.mock("src/core/utils/gate-hit", () => ({
    captureGateHit: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { captureGateHit } = require("src/core/utils/gate-hit");

const plugin = (
    id: string,
    overrides: Partial<{
        isConnected: boolean;
        isDefault: boolean;
        connectionStatus: MCP_CONNECTION_STATUS;
    }> = {},
) => ({
    id,
    name: id,
    appName: id,
    description: `${id} description`,
    authScheme: "none" as any,
    logo: "",
    provider: "kodusmcp",
    isConnected: false,
    ...overrides,
});

const FREE_PLAN_LICENSE = {
    valid: true,
    subscriptionStatus: "active",
    planType: "free_byok",
} as any;

const renderOnFreePlan = (
    plugins: ReturnType<typeof plugin>[],
    orderedActiveIntegrationIds: string[],
) =>
    render(
        <SubscriptionProvider
            license={FREE_PLAN_LICENSE}
            usersWithAssignedLicense={[]}>
            <PluginsGrid
                plugins={plugins as any}
                orderedActiveIntegrationIds={orderedActiveIntegrationIds}
            />
        </SubscriptionProvider>,
    );

describe("PluginsGrid — free plan cap", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("never locks the default (system-managed) plugin, even when /mcp/connections is empty", () => {
        // Regression for the real bug found while testing issue #1459:
        // "Kodus MCP" is isConnected+ACTIVE+isDefault but never appears in
        // /mcp/connections. An empty orderedActiveIntegrationIds used to make
        // the runnable set empty, wrongly locking this always-on plugin.
        const defaultPlugin = plugin("kd_mcp", {
            isConnected: true,
            isDefault: true,
            connectionStatus: MCP_CONNECTION_STATUS.ACTIVE,
        });

        renderOnFreePlan([defaultPlugin], []);

        expect(screen.queryByText("Locked")).not.toBeInTheDocument();
        expect(screen.getByText("Default")).toBeInTheDocument();
    });

    it("locks connected plugins beyond the 3-plugin cap and shows the upgrade banner", () => {
        const plugins = [
            plugin("exa", {
                isConnected: true,
                connectionStatus: MCP_CONNECTION_STATUS.ACTIVE,
            }),
            plugin("osv", {
                isConnected: true,
                connectionStatus: MCP_CONNECTION_STATUS.ACTIVE,
            }),
            plugin("docs", {
                isConnected: true,
                connectionStatus: MCP_CONNECTION_STATUS.ACTIVE,
            }),
            plugin("issues", {
                isConnected: true,
                connectionStatus: MCP_CONNECTION_STATUS.ACTIVE,
            }),
        ];

        renderOnFreePlan(plugins, ["exa", "osv", "docs", "issues"]);

        expect(screen.getByText(/1 of your plugins is locked/i)).toBeInTheDocument();
        expect(screen.getAllByText("Locked")).toHaveLength(1);
        expect(screen.getAllByText("Installed")).toHaveLength(3);
    });

    it("does not lock or show the banner when connected count is within the cap", () => {
        const plugins = [
            plugin("exa", {
                isConnected: true,
                connectionStatus: MCP_CONNECTION_STATUS.ACTIVE,
            }),
            plugin("osv", {
                isConnected: true,
                connectionStatus: MCP_CONNECTION_STATUS.ACTIVE,
            }),
        ];

        renderOnFreePlan(plugins, ["exa", "osv"]);

        expect(screen.queryByText(/locked/i)).not.toBeInTheDocument();
    });

    it("fires captureGateHit exactly once when locked plugins are present", () => {
        const plugins = [
            plugin("exa", {
                isConnected: true,
                connectionStatus: MCP_CONNECTION_STATUS.ACTIVE,
            }),
            plugin("osv", {
                isConnected: true,
                connectionStatus: MCP_CONNECTION_STATUS.ACTIVE,
            }),
            plugin("docs", {
                isConnected: true,
                connectionStatus: MCP_CONNECTION_STATUS.ACTIVE,
            }),
            plugin("issues", {
                isConnected: true,
                connectionStatus: MCP_CONNECTION_STATUS.ACTIVE,
            }),
        ];

        renderOnFreePlan(plugins, ["exa", "osv", "docs", "issues"]);

        expect(captureGateHit).toHaveBeenCalledTimes(1);
        expect(captureGateHit).toHaveBeenCalledWith(
            expect.objectContaining({ feature: "mcp_plugins" }),
        );
    });
});
