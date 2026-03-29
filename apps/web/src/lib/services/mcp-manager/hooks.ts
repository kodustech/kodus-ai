"use client";

import { useQuery } from "@tanstack/react-query";

import { getMCPPlugins } from "./fetch";
import { MCPServiceUnavailableError } from "./utils";

export const useMCPAvailability = (enabled = true) =>
    useQuery({
        queryKey: ["mcp-availability"],
        enabled,
        retry: false,
        staleTime: 60_000,
        queryFn: async () => {
            try {
                await getMCPPlugins();
                return true;
            } catch (error) {
                if (error instanceof MCPServiceUnavailableError) {
                    return false;
                }

                console.error("Failed to check MCP availability:", error);
                return true;
            }
        },
    });
