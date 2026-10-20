import type { CustomAgentMcpTools } from "./types";

/**
 * Every read-only tool the plugin offers, now or later. Mirrors
 * `MCP_ALL_READ_TOOLS` in the backend config types.
 */
export const MCP_ALL_READ_TOOLS = "*";

export type McpPluginSelection = {
    on: boolean;
    /** Every read tool, including the ones the plugin adds later. */
    all: boolean;
    /** The tools the agent gets, among those the plugin offers today. */
    selected: string[];
};

export const mcpPluginSelection = (
    mcp: CustomAgentMcpTools[],
    integrationId: string,
    available: string[],
): McpPluginSelection => {
    const entry = mcp.find((item) => item.integrationId === integrationId);
    if (!entry?.tools.length) return { on: false, all: false, selected: [] };
    if (entry.tools.includes(MCP_ALL_READ_TOOLS)) {
        return { on: true, all: true, selected: available };
    }
    const stored = new Set(entry.tools);
    return {
        on: true,
        all: false,
        selected: available.filter((tool) => stored.has(tool)),
    };
};

const withTools = (
    mcp: CustomAgentMcpTools[],
    integrationId: string,
    tools: string[],
): CustomAgentMcpTools[] => {
    const rest = mcp.filter((item) => item.integrationId !== integrationId);
    return tools.length ? [...rest, { integrationId, tools }] : rest;
};

/** On grants every read tool of the plugin; off removes it. */
export const setMcpPlugin = (
    mcp: CustomAgentMcpTools[],
    integrationId: string,
    on: boolean,
): CustomAgentMcpTools[] =>
    withTools(mcp, integrationId, on ? [MCP_ALL_READ_TOOLS] : []);

/**
 * Narrows or widens a plugin one tool at a time. Picking every tool it offers
 * goes back to "every tool", so tools it adds later are included again.
 */
export const toggleMcpTool = (
    mcp: CustomAgentMcpTools[],
    integrationId: string,
    tool: string,
    on: boolean,
    available: string[],
): CustomAgentMcpTools[] => {
    const current = new Set(
        mcpPluginSelection(mcp, integrationId, available).selected,
    );
    if (on) current.add(tool);
    else current.delete(tool);
    const selected = available.filter((name) => current.has(name));
    if (available.length && selected.length === available.length) {
        return setMcpPlugin(mcp, integrationId, true);
    }
    return withTools(mcp, integrationId, selected);
};
