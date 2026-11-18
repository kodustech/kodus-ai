import type { ForkPullRequestPolicy, RuntimeEnvironment } from "../contracts";
import { formatDurationMs } from "../format";
import {
    environmentSetupMs,
    isEnvironmentBusy,
    setupStepTitle,
} from "./environment";
import { machineSizeOption } from "./machine-size";

// The one line a closed section of the environment page carries, so the
// page reads without opening it: where the last setup ended, and what each
// setting is now.

/** Where the last setup is or ended: "Stopped at Boot on a machine after 4 min 10 s." */
export const setupTakeaway = (
    env: Pick<RuntimeEnvironment, "state" | "setup">,
): string => {
    const setup = env.setup;
    if (!setup)
        return isEnvironmentBusy(env)
            ? "Waiting for the Runtime to pick up the request."
            : "No setup recorded yet.";
    const running = setup.steps.find((s) => s.state === "running");
    if (running && isEnvironmentBusy(env))
        return `Now: ${setupStepTitle(running)}.`;
    const took = environmentSetupMs(env);
    const after = took !== undefined ? ` after ${formatDurationMs(took)}` : "";
    const failed = setup.steps.find((s) => s.state === "failed");
    if (failed) return `Stopped at ${setupStepTitle(failed)}${after}.`;
    if (setup.state === "active")
        return took !== undefined
            ? `Finished ready in ${formatDurationMs(took)}.`
            : "Finished ready.";
    if (isEnvironmentBusy(env)) return "Setting up.";
    return `Did not finish ready${after}.`;
};

const FORKS: Record<ForkPullRequestPolicy, string> = {
    require_approval: "forks wait for a maintainer",
    skip: "forks do not run",
    run: "forks run without approval",
};

const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;

/** "Default machine size · forks wait for a maintainer · 1 machine kept ready · no extra outbound hosts". */
export const settingsTakeaway = (
    env: Pick<
        RuntimeEnvironment,
        "machineSize" | "forkPullRequests" | "pool" | "egressApprovals"
    >,
): string => {
    const parts: string[] = [];
    if (env.machineSize !== undefined) {
        const option = env.machineSize
            ? machineSizeOption(env.machineSize)
            : undefined;
        parts.push(
            option?.size ? `${option.label} machines` : "Default machine size",
        );
    }
    const forks = env.forkPullRequests && FORKS[env.forkPullRequests];
    if (forks) parts.push(forks);
    if (env.pool)
        parts.push(
            env.pool.size > 0
                ? `${plural(env.pool.size, "machine", "machines")} kept ready`
                : "no machine kept ready",
        );
    const hosts = env.egressApprovals?.length ?? 0;
    parts.push(
        hosts
            ? `${plural(hosts, "approved outbound host", "approved outbound hosts")}`
            : "no extra outbound hosts",
    );
    const line = parts.join(" · ");
    return line.charAt(0).toUpperCase() + line.slice(1);
};
