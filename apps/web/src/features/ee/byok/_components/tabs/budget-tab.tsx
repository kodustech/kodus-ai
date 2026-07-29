"use client";

import type { BYOKConfigV2 } from "../../_types";
import { SpendLimitSection } from "../spend-limit-section";

type BudgetTabProps = {
    config: BYOKConfigV2 | null | undefined;
    teamId?: string;
};

/**
 * The Budget & alerts tab: wraps the evolved SpendLimitSection (rename + scope
 * readout toggle + run-rate projection + per-scope breakdown + /token-usage
 * deep-link). Alert-only — no scope ever introduces a hard block (04-11).
 */
export const BudgetTab = ({ teamId }: BudgetTabProps) => (
    <SpendLimitSection teamId={teamId} />
);
