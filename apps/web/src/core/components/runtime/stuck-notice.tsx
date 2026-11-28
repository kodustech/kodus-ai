import type { RuntimeStuckState } from "@services/runtime/contracts";
import { formatDurationMs } from "@services/runtime/format";
import { stuckStateLabel } from "@services/runtime/model/health";

/**
 * A Run or a setup past the longest its current step should take (the hang
 * detector's bound): said where it is read, with nothing stopped for it.
 */
export const StuckNotice = ({
    what,
    stuck,
}: {
    what: "Run" | "setup";
    stuck: RuntimeStuckState | undefined;
}) => {
    if (!stuck) return null;
    return (
        <p
            role="status"
            className="bg-warning/10 text-text-secondary rounded-lg px-4 py-3 text-sm">
            <span className="text-text-primary font-medium">
                This {what} looks stuck.
            </span>{" "}
            It has been {stuckStateLabel(stuck.state)} for{" "}
            {formatDurationMs(stuck.ageMs)}
            {stuck.boundMs > 0
                ? `, longer than the ${formatDurationMs(stuck.boundMs)} it should take`
                : ", past its time limit"}
            . Kody Runtime has not stopped it;{" "}
            {what === "Run"
                ? "you can stop it or run it again"
                : "you can set it up again"}
            .
        </p>
    );
};
