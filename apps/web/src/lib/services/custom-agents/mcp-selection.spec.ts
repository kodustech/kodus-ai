import {
    MCP_ALL_READ_TOOLS,
    mcpPluginSelection,
    setMcpPlugin,
    toggleMcpTool,
} from "./mcp-selection";
import type { CustomAgentMcpTools } from "./types";

const AVAILABLE = ["get_issue", "list_issues", "get_project"];

describe("MCP plugin selection", () => {
    it("is off when the plugin has no entry", () => {
        expect(mcpPluginSelection([], "linear", AVAILABLE)).toEqual({
            on: false,
            all: false,
            selected: [],
        });
    });

    it("turning a plugin on grants every read tool, now and later", () => {
        const mcp = setMcpPlugin([], "linear", true);

        expect(mcp).toEqual([
            { integrationId: "linear", tools: [MCP_ALL_READ_TOOLS] },
        ]);
        expect(mcpPluginSelection(mcp, "linear", AVAILABLE)).toEqual({
            on: true,
            all: true,
            selected: AVAILABLE,
        });
    });

    it("turning a plugin off removes it and keeps the others", () => {
        const mcp: CustomAgentMcpTools[] = [
            { integrationId: "linear", tools: [MCP_ALL_READ_TOOLS] },
            { integrationId: "azure", tools: ["wiki"] },
        ];

        expect(setMcpPlugin(mcp, "linear", false)).toEqual([
            { integrationId: "azure", tools: ["wiki"] },
        ]);
    });

    it("unchecking one tool of an all-tools plugin keeps the rest, by name", () => {
        const mcp = toggleMcpTool(
            setMcpPlugin([], "linear", true),
            "linear",
            "get_project",
            false,
            AVAILABLE,
        );

        expect(mcp).toEqual([
            { integrationId: "linear", tools: ["get_issue", "list_issues"] },
        ]);
        expect(mcpPluginSelection(mcp, "linear", AVAILABLE)).toMatchObject({
            on: true,
            all: false,
        });
    });

    it("checking the last missing tool goes back to every tool", () => {
        const mcp = toggleMcpTool(
            [{ integrationId: "linear", tools: ["get_issue", "list_issues"] }],
            "linear",
            "get_project",
            true,
            AVAILABLE,
        );

        expect(mcp).toEqual([
            { integrationId: "linear", tools: [MCP_ALL_READ_TOOLS] },
        ]);
    });

    it("unchecking the last tool turns the plugin off", () => {
        const mcp = toggleMcpTool(
            [{ integrationId: "linear", tools: ["get_issue"] }],
            "linear",
            "get_issue",
            false,
            AVAILABLE,
        );

        expect(mcp).toEqual([]);
    });

    it("ignores stored names the plugin no longer offers", () => {
        expect(
            mcpPluginSelection(
                [{ integrationId: "linear", tools: ["get_issue", "gone"] }],
                "linear",
                AVAILABLE,
            ),
        ).toEqual({ on: true, all: false, selected: ["get_issue"] });
    });
});
