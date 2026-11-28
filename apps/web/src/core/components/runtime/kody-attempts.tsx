import type {
    EnvironmentLearn,
    EnvironmentLearnAttempt,
} from "@services/runtime/contracts";
import type { Tone } from "@services/runtime/labels";

import { StatusChip } from "./status-chip";

const REFUSAL: Record<
    NonNullable<EnvironmentLearnAttempt["refusal"]>,
    string
> = {
    not_json: "the answer was not one of the changes Kody may make",
    not_allowed: "the answer was not one of the changes Kody may make",
    not_in_evidence: "it named something the failure log does not show",
    already_set: "the setup file already sets it",
    not_higher: "the setup file already waits that long",
    unknown_service: "the setup file does not expose that service",
    duplicate: "it was already tried",
    edit_failed: "the setup file could not take the change",
};

/** One attempt in Kodus's words: the typed fix it tried, and how it ended. */
export const attemptText = (
    a: EnvironmentLearnAttempt,
): { what: string; result: string; tone: Tone } => {
    const what = a.fix?.label ?? "A change Kody could not use";
    switch (a.result) {
        case "trying":
            return { what, result: "Trying on a clean machine", tone: "info" };
        case "booted":
            return {
                what,
                result: `Booted from zero on ${a.cleanBoots ?? 2} clean machines`,
                tone: "success",
            };
        case "booted_once":
            return {
                what,
                result: "Booted once, not on the second clean machine",
                tone: "warning",
            };
        case "blocked":
            return {
                what,
                result: a.blocker?.title
                    ? `Did not boot: ${a.blocker.title}`
                    : "Did not boot",
                tone: "danger",
            };
        case "refused":
            return {
                what,
                result: `Not tried: ${a.refusal ? REFUSAL[a.refusal] : "not a change Kody may make"}`,
                tone: "neutral",
            };
    }
};

/** Why the loop stopped, when it says something the attempts do not. */
export const stopText = (learn: EnvironmentLearn): string | undefined => {
    switch (learn.stopped) {
        case "proven":
            return learn.proven?.origin === "inferred"
                ? "Kody's fix booted from zero on two clean machines. Open the setup file PR in the setup file section."
                : "Kody's fix booted from zero on two clean machines. Open its PR from the blocker card.";
        case "cap":
            return "Kody tried 3 changes for this blocker. Fix it by hand with its blocker card, then set up again.";
        case "cannot_fix":
            return "Kody found no setup file change that fits this blocker. Its blocker card says what to do.";
        case "budget":
            return "Kody stopped: the LLM budget for this setup ran out.";
        case "no_token":
            return "Kody stopped: a new clean machine could not download the repository again.";
        default:
            return undefined;
    }
};

/**
 * Kody's learn loop on a blocked setup (docs "Ciclo de aprender"): each
 * typed change it tried on a clean machine and the result. Everything here
 * is a template filled with checked fields (S-23); nothing the LLM wrote is
 * shown. Without attempts (no LLM, nothing to change) it renders nothing and
 * the blocker card stays as it is.
 */
export const KodyAttempts = ({ learn }: { learn?: EnvironmentLearn }) => {
    if (!learn?.attempts.length) return null;
    const stop = stopText(learn);
    return (
        <div className="flex flex-col gap-2" aria-label="Kody tried">
            <span className="text-text-secondary text-xs font-medium">
                Kody tried
            </span>
            <ol className="flex flex-col gap-2">
                {learn.attempts.map((a) => {
                    const t = attemptText(a);
                    return (
                        <li
                            key={`${a.setupKey}:${a.n}`}
                            className="flex flex-wrap items-center gap-2 text-sm">
                            <span>{t.what}</span>
                            <StatusChip tone={t.tone}>{t.result}</StatusChip>
                        </li>
                    );
                })}
            </ol>
            {stop && <p className="text-text-secondary text-sm">{stop}</p>}
        </div>
    );
};
