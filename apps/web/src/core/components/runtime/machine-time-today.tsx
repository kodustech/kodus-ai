"use client";

import { Skeleton } from "@components/ui/skeleton";
import { machineMinutesSummary } from "@services/runtime/model/machine-minutes";
import { useRuntimeMachineMinutes } from "@services/runtime/queries";

import { MachineMinuteLimit } from "./machine-minute-limit";

const minutes = (n: number) => `${n.toLocaleString()} min`;

/** Today's machine minutes of the organization: used, held by machines still running, the reset, and the limit that holds. */
export const MachineTimeToday = ({ canEdit }: { canEdit: boolean }) => {
    const today = useRuntimeMachineMinutes();
    if (today.isLoading) return <Skeleton className="h-10 w-80" />;
    if (today.isError || !today.data)
        return (
            <p className="text-text-secondary text-sm">
                Machine time is not available on this deployment right now.
            </p>
        );
    const s = machineMinutesSummary(today.data);
    return (
        <div className="flex flex-col gap-1 text-sm">
            <p className="text-text-primary">
                <span className="font-semibold">{minutes(s.usedMinutes)}</span>
                {s.limitMinutes !== null
                    ? ` of ${minutes(s.limitMinutes)} used`
                    : " used (no daily limit)"}
                {s.runningMachines > 0 &&
                    ` · ${minutes(s.heldByRunningMinutes)} more held by ${s.runningMachines} machine${s.runningMachines === 1 ? "" : "s"} still running`}
            </p>
            {s.exhausted ? (
                <p className="text-warning text-sm" role="status">
                    {s.waitWords} Resets in {s.resetsIn}.
                </p>
            ) : (
                <p className="text-text-tertiary text-xs">
                    {s.remainingMinutes !== null
                        ? `${minutes(s.remainingMinutes)} left · `
                        : ""}
                    Resets at 00:00 UTC, in {s.resetsIn}.
                </p>
            )}
            <div className="border-card-lv3 mt-3 border-t pt-3">
                <MachineMinuteLimit
                    key={String(today.data.orgLimitMinutes ?? "")}
                    today={today.data}
                    canEdit={canEdit}
                />
            </div>
        </div>
    );
};
