import { LockedFeatureUnlocks } from "@components/system/locked-feature-unlocks";

/**
 * What the Cockpit would add, named one by one, for the card that sits on
 * the locked screen — led by the one number the workspace already owns: how
 * many pull requests Kody reviewed for it. That count comes from the same
 * Reviews list the viewer can open, so it argues from their own work instead
 * of from sample charts, and leaks nothing they can't already read.
 */
const UNLOCKS = [
    "Cycle time and lead time, per repository",
    "Which Kody Rules catch things — and which get ignored",
    "Suggestions sent vs. implemented, by category and repo",
    "Deploy frequency, PR size and bug ratio",
];

export const LockedCockpitDetails = ({
    reviewedCount,
    windowDays,
}: {
    /** Distinct PRs Kody reviewed in this workspace, or null if unknown. */
    reviewedCount: number | null;
    windowDays: number;
}) => (
    <LockedFeatureUnlocks
        items={UNLOCKS}
        lead={
            reviewedCount !== null &&
            reviewedCount > 0 && (
                <p className="border-primary-light/25 bg-card-lv2 rounded-lg border px-4 py-3 text-sm">
                    <span className="text-primary-light font-semibold">
                        {reviewedCount.toLocaleString()} pull request
                        {reviewedCount === 1 ? "" : "s"}
                    </span>{" "}
                    <span className="text-text-secondary">
                        reviewed in this workspace in the last {windowDays}{" "}
                        days. None of it is measured yet.
                    </span>
                </p>
            )
        }
    />
);
