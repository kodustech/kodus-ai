import type { ReactNode } from "react";
import type { BootPhase, RunBuildSteps } from "@services/runtime/contracts";
import { formatDurationMs } from "@services/runtime/format";
import {
    baseVersionLabel,
    comparisonSideLabel,
} from "@services/runtime/model/base-version";
import {
    buildStepsLine,
    timingSummary,
    type RunPhase,
    type RunPhaseId,
    type RunTiming,
} from "@services/runtime/model/run-timing";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

// Support hues and tones only: a phase is not a status, and amber is for actions.
const PHASE_COLOR: Record<RunPhaseId, string> = {
    wait: "bg-card-lv3",
    boot: "bg-secondary-light",
    apply: "bg-secondary-light/55",
    test: "bg-tertiary-light",
    report: "bg-text-secondary",
};

const Duration = ({ ms }: { ms: number | undefined }) => (
    <span className="text-text-primary ml-auto shrink-0 pl-3 font-mono text-sm whitespace-nowrap tabular-nums">
        {ms === undefined ? "not measured" : formatDurationMs(ms)}
    </span>
);

/** One timed line inside a phase: a boot sub-step or a build step, its duration on the right. */
const SubRow = ({
    name,
    ms,
    note,
    mono,
}: {
    name: ReactNode;
    ms: number;
    note?: ReactNode;
    mono?: boolean;
}) => (
    <li className="flex min-w-0 items-baseline gap-2 text-sm">
        <span
            className={cn(
                "text-text-secondary min-w-0 break-words",
                mono && "font-mono text-xs break-all",
            )}>
            {name}
            {note}
        </span>
        <Duration ms={ms} />
    </li>
);

const BootSteps = ({
    title,
    phases,
    live,
}: {
    title: string;
    phases: BootPhase[];
    live: boolean;
}) => (
    <div className="flex flex-col gap-1">
        <span className="text-text-tertiary text-xs">{title}</span>
        <ol className="flex flex-col gap-0.5">
            {phases.map((p, i) => (
                <SubRow
                    key={`${p.name}-${i}`}
                    name={p.name}
                    ms={p.ms}
                    note={
                        p.running &&
                        (live ? (
                            <span className="text-info"> · running</span>
                        ) : (
                            <span className="text-danger"> · stopped here</span>
                        ))
                    }
                />
            ))}
        </ol>
    </div>
);

/** One side's build: its counts, then the steps that ran longest. */
const BuildSteps = ({
    build,
    baseLabel,
}: {
    build: RunBuildSteps;
    baseLabel: string;
}) => (
    <div className="flex flex-col gap-1">
        <span className="text-text-tertiary text-xs">
            Build of {comparisonSideLabel(build.side, baseLabel)}:{" "}
            {buildStepsLine(build)}
            {build.slowest.length > 0 && " · slowest steps"}
        </span>
        {build.slowest.length > 0 && (
            <ol className="flex flex-col gap-0.5">
                {build.slowest.map((s, i) => (
                    <SubRow
                        key={`${s.service}-${i}`}
                        mono
                        ms={s.ms}
                        name={
                            <>
                                <span className="text-text-primary">
                                    {s.service}
                                </span>{" "}
                                {s.name}
                            </>
                        }
                    />
                ))}
            </ol>
        )}
    </div>
);

const ROW =
    "flex min-h-11 min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2";

/** A phase, GitHub Actions style: its name and what it did, its duration on the right; open it for its steps. */
const PhaseRow = ({
    phase,
    baseLabel,
}: {
    phase: RunPhase;
    baseLabel: string;
}) => {
    const boots = phase.bootPhases ?? [];
    const builds = phase.builds ?? [];
    const line = (
        <>
            <span
                aria-hidden
                className={cn(
                    "inline-block size-2.5 shrink-0 rounded-sm",
                    PHASE_COLOR[phase.id],
                )}
            />
            <span className="text-text-primary text-sm font-medium">
                {phase.label}
            </span>
            {phase.detail && (
                <span className="text-text-secondary min-w-0 text-xs">
                    {phase.detail}
                </span>
            )}
            {phase.running && (
                <span className="text-info text-xs">running</span>
            )}
            <Duration ms={phase.ms} />
        </>
    );
    if (!boots.length && !builds.length)
        return (
            <li className="bg-card-lv2/40 rounded-lg">
                <div className={ROW}>
                    <span aria-hidden className="size-4 shrink-0" />
                    {line}
                </div>
            </li>
        );
    return (
        <li className="bg-card-lv2/40 rounded-lg">
            <details className="group/phase">
                <summary
                    className={cn(
                        ROW,
                        "focus-visible:ring-ring cursor-pointer list-none rounded-lg hover:brightness-120 focus-visible:ring-3 focus-visible:outline-none [&::-webkit-details-marker]:hidden",
                    )}>
                    <ChevronRightIcon
                        aria-hidden
                        className="text-text-secondary size-4 shrink-0 transition-transform duration-200 group-open/phase:rotate-90"
                    />
                    {line}
                </summary>
                <div className="flex flex-col gap-3 pr-3 pb-3 pl-10">
                    {boots.map((b) => (
                        <BootSteps
                            key={b.side}
                            phases={b.phases}
                            live={!!phase.running}
                            title={`Where the boot of ${comparisonSideLabel(b.side, baseLabel)} went`}
                        />
                    ))}
                    {builds.map((b) => (
                        <BuildSteps
                            key={b.side}
                            build={b}
                            baseLabel={baseLabel}
                        />
                    ))}
                </div>
            </details>
        </li>
    );
};

/** The phase bar, then one row per phase; each row opens to its boot sub-steps and slowest build steps. */
export const RunTimingView = ({ timing }: { timing: RunTiming }) => {
    const baseLabel = timing.baseLabel ?? baseVersionLabel();
    const measured = timing.phases.filter((p) => (p.ms ?? 0) > 0);
    const sum = measured.reduce((s, p) => s + (p.ms ?? 0), 0);
    if (timing.phases.length === 0)
        return (
            <p className="text-text-secondary text-sm">
                The phases appear once a machine takes the Run.
            </p>
        );
    return (
        <div className="flex flex-col gap-3">
            {sum > 0 && (
                <div
                    role="img"
                    aria-label={timingSummary(timing)}
                    className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
                    {measured.map((p) => (
                        <div
                            key={p.id}
                            className={cn("h-full min-w-1", PHASE_COLOR[p.id])}
                            style={{ width: `${((p.ms ?? 0) / sum) * 100}%` }}
                        />
                    ))}
                </div>
            )}
            <ol aria-label="Phases" className="flex flex-col gap-1">
                {timing.phases.map((p) => (
                    <PhaseRow key={p.id} phase={p} baseLabel={baseLabel} />
                ))}
            </ol>
        </div>
    );
};
