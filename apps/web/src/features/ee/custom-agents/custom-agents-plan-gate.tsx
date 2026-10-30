"use client";

import { useEffect, useRef } from "react";
import { LockedFeatureOverlay } from "@components/system/locked-feature-overlay";
import { LockedFeatureUnlocks } from "@components/system/locked-feature-unlocks";
import { LockedPagePreview } from "@components/system/locked-page-preview";
import {
    availabilityLine,
    planCtaTarget,
} from "@components/system/plan-cta-target";
import { captureGateHit } from "src/core/utils/gate-hit";
import type { GateSurface } from "src/core/utils/gate-hit";
import { isTeamsOrEnterprisePlan } from "src/features/ee/byok/_utils";
import { useSubscriptionContext } from "src/features/ee/subscription/_providers/subscription-context";

// Every item maps to something the unlocked screens do.
const UNLOCKS = [
    "Reviewers with your own instructions, scoped to the files they own",
    "Skills and docs from your repository loaded into the review",
    "One agent on demand with @kody -v <agent>",
    "Try an agent on a pull request before it posts",
];

/**
 * Custom agents run on Teams, Enterprise and the trial: the mirror of the
 * server's `isCustomAgentsPlanAllowed`, which runs none on another plan and
 * keeps the saved ones for an upgrade.
 */
export const useCustomAgentsPlanAllowed = () =>
    isTeamsOrEnterprisePlan(useSubscriptionContext().license);

const LockedCustomAgents = ({
    surface,
    children,
    className,
}: React.PropsWithChildren<{ surface: GateSurface; className?: string }>) => {
    const { license } = useSubscriptionContext();
    const reported = useRef(false);

    useEffect(() => {
        if (reported.current) return;
        reported.current = true;
        void captureGateHit({
            feature: "custom_agents",
            surface,
            planType: license.planType,
            subscriptionStatus: license.subscriptionStatus,
        });
    }, [license.planType, license.subscriptionStatus, surface]);

    return (
        <LockedFeatureOverlay
            className={className}
            title="Unlock custom agents"
            description="Write reviewers for what only your team knows. They review every pull request next to Kody. Saved agents are kept and run again after an upgrade."
            details={
                <LockedFeatureUnlocks
                    lead={
                        <p className="text-text-secondary text-sm">
                            {availabilityLine()}
                        </p>
                    }
                    items={UNLOCKS}
                />
            }
            cta={{
                ...planCtaTarget(),
                feature: "custom_agents",
                surface,
                planType: license.planType,
                subscriptionStatus: license.subscriptionStatus,
            }}>
            {children}
        </LockedFeatureOverlay>
    );
};

/** The Custom agents section on What to review, locked on a plan without
 *  them. The preview behind the blur is shapes only, never the saved agents. */
export const CustomAgentsSectionGate = ({
    children,
}: React.PropsWithChildren) => {
    if (useCustomAgentsPlanAllowed()) return children;

    return (
        <LockedCustomAgents surface="settings_general" className="min-h-[32rem]">
            <div className="flex flex-col gap-4">
                <h3 className="text-base font-semibold">Custom agents</h3>
                {Array.from({ length: 3 }).map((_, i) => (
                    <div
                        key={i}
                        className="border-card-lv3/60 bg-card-lv1 flex items-center gap-4 rounded-xl border p-4">
                        <div className="bg-card-lv3 size-8 rounded-full" />
                        <div className="flex flex-1 flex-col gap-2">
                            <div className="bg-card-lv3 h-3 w-40 rounded" />
                            <div className="bg-card-lv2 h-3 w-2/3 rounded" />
                        </div>
                        <div className="bg-card-lv3 h-6 w-11 rounded-full" />
                    </div>
                ))}
            </div>
        </LockedCustomAgents>
    );
};

/** An agent page or the Skills & docs page, locked on a plan without custom
 *  agents: the page itself (and what it loads) never renders. */
export const CustomAgentsPageGate = ({
    title,
    children,
}: React.PropsWithChildren<{ title: string }>) => {
    if (useCustomAgentsPlanAllowed()) return children;

    return (
        <LockedCustomAgents surface="locked_preview">
            <LockedPagePreview title={title} />
        </LockedCustomAgents>
    );
};
