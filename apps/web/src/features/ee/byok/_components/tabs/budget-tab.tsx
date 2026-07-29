"use client";

import type { BYOKConfigV2 } from "../../_types";
import { SpendLimitSection } from "../spend-limit-section";

type BudgetTabProps = {
    config: BYOKConfigV2 | null | undefined;
    teamId?: string;
};

/**
 * Wired skeleton for the Budget & alerts tab: wraps the existing
 * SpendLimitSection verbatim. 04-11 evolves it (per-model budgets, alerts).
 */
export const BudgetTab = ({ teamId }: BudgetTabProps) => (
    <SpendLimitSection teamId={teamId} />
);
