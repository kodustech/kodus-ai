"use client";

import type { LLMConfigStatus } from "@services/organizationParameters/fetch";

import type { BYOKConfigV2 } from "../../_types";

type RoutingTabProps = {
    config: BYOKConfigV2 | null | undefined;
    llmConfigStatus: LLMConfigStatus | null;
};

/**
 * Wired skeleton for the Routing tab. The manual/auto policy editor lands in
 * 04-10; this tracer only reserves the prop contract + the tab seam.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const RoutingTab = (_props: RoutingTabProps) => (
    <p className="text-text-tertiary text-sm">
        Routing — configure in the next step
    </p>
);
