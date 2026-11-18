import type { BootPhase } from "@services/runtime/contracts";
import { formatDurationMs } from "@services/runtime/format";

/** "Where the time went: yarn install 16 min 45 s · export layers 21 min 00 s · …". */
export const BootPhases = ({
    phases,
    label = "Where the time went",
    live = false,
}: {
    phases: BootPhase[] | undefined;
    label?: string;
    /** The boot still runs: its running phase is under way, not where it stopped. */
    live?: boolean;
}) => {
    if (!phases?.length) return null;
    return (
        <p className="text-text-secondary text-xs">
            <span className="text-text-tertiary">{label}: </span>
            {phases.map((p, i) => (
                <span key={`${p.name}-${i}`}>
                    {i > 0 && " · "}
                    <span className="text-text-primary">{p.name}</span>{" "}
                    <span className="font-mono">{formatDurationMs(p.ms)}</span>
                    {p.running &&
                        (live ? (
                            <span className="text-info"> · running</span>
                        ) : (
                            <span className="text-danger"> · stopped here</span>
                        ))}
                </span>
            ))}
        </p>
    );
};
