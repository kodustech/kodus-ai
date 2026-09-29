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

                // This probe asks "is the MCP manager reachable?", so a
                // failure is its answer, not an application error. The navbar
                // runs it on every page: logging at error level turned an
                // unhealthy manager into a console error on every screen (and
                // a red badge in the dev overlay) for something the user can
                // neither see nor act on. Still fails OPEN — a blip should not
                // make the Plugins entry disappear.
                console.warn("MCP availability check failed:", error);
                return true;
            }
        },
    });
