import { typedFetch, TypedFetchError } from "@services/fetch";
import { pathToApiUrl } from "src/core/utils/helpers";
import { addSearchParamsToUrl } from "src/core/utils/url";

import type {
    AppliedBlockerFix,
    BlockerGroup,
    CellRegistrationToken,
    CellRegistrationTokenView,
    CellTopology,
    EgressApprovalMode,
    EgressWhoMayAdd,
    EnvironmentRepositoriesResult,
    EvidenceSide,
    EvidenceType,
    FindingFeedback,
    FindingFeedbackValue,
    FindingIntentResult,
    ForkPullRequestPolicy,
    MachineSizePreset,
    OrgEgress,
    PoolPolicy,
    PreviewSide,
    ProposedRecipe,
    RunStreamPage,
    RuntimeBlocker,
    RuntimeCell,
    RuntimeEnvironment,
    RuntimeEnvironmentSuite,
    RuntimeEnvironmentStatus,
    RuntimeEnvironmentPreview,
    RuntimeHealth,
    RuntimeLesson,
    RuntimeMachineMinutesLimitChange,
    RuntimeMachineMinutesToday,
    RuntimePreview,
    RuntimePreviewAuditRecord,
    RuntimePreviewSettings,
    RuntimePreviewSettingsView,
    RuntimeRepositorySettings,
    RuntimeRun,
    RuntimeRunPreviews,
    RuntimeRunSummary,
    RuntimeSettings,
    RuntimeSpeed,
    RuntimeStopScope,
    RuntimeSuiteRun,
    RuntimeUsageReport,
    SpeedWindowDays,
    SandboxCapacityView,
} from "./contracts";
import { readReproductionDownload } from "./model/reproduction";
import type { RuntimeSettingsPayload } from "./model/rules";
import { parseStreamResponse, RunStreamFatalError } from "./stream";

// Every Runtime call of the web app. Client-side only: the URLs go through the
// same-origin /api/proxy, which adds the session's Bearer token.

const enc = encodeURIComponent;

/** Routes of docs §7, served by apps/api under /runtime/*. */
export const RUNTIME_PATHS = {
    RUNS: () => pathToApiUrl("/runtime/runs"),
    RUN: (runId: string) => pathToApiUrl(`/runtime/runs/${enc(runId)}`),
    RUN_STREAM: (runId: string) =>
        pathToApiUrl(`/runtime/runs/${enc(runId)}/stream`),
    RUN_EVIDENCE: (runId: string, stepId: string) =>
        pathToApiUrl(`/runtime/runs/${enc(runId)}/evidence/${enc(stepId)}`),
    RUN_REPRODUCE: (runId: string, probeId: string) =>
        pathToApiUrl(
            `/runtime/runs/${enc(runId)}/findings/${enc(probeId)}/reproduce`,
        ),
    RUN_SUITE: (runId: string) =>
        pathToApiUrl(`/runtime/runs/${enc(runId)}/suite`),
    RUN_SUITE_RETRY: (runId: string) =>
        pathToApiUrl(`/runtime/runs/${enc(runId)}/suite/retry`),
    RUN_SUITE_ARTIFACT: (runId: string) =>
        pathToApiUrl(`/runtime/runs/${enc(runId)}/suite/artifacts`),
    RUN_APPROVALS: (runId: string) =>
        pathToApiUrl(`/runtime/runs/${enc(runId)}/approvals`),
    RUN_FINDING_FEEDBACK: (runId: string, probeId: string) =>
        pathToApiUrl(
            `/runtime/runs/${enc(runId)}/findings/${enc(probeId)}/feedback`,
        ),
    RUN_FINDING_INTENT: (runId: string, probeId: string) =>
        pathToApiUrl(
            `/runtime/runs/${enc(runId)}/findings/${enc(probeId)}/intent`,
        ),
    ENVIRONMENTS: () => pathToApiUrl("/runtime/environments"),
    ENVIRONMENT_STATUSES: () => pathToApiUrl("/runtime/environments/status"),
    ENVIRONMENT: (environmentId: string) =>
        pathToApiUrl(`/runtime/environments/${enc(environmentId)}`),
    ENVIRONMENT_REPOSITORIES: (environmentId: string) =>
        pathToApiUrl(
            `/runtime/environments/${enc(environmentId)}/repositories`,
        ),
    ENVIRONMENT_REPOSITORY: (environmentId: string, repositoryId: string) =>
        pathToApiUrl(
            `/runtime/environments/${enc(environmentId)}/repositories/${enc(repositoryId)}`,
        ),
    ENVIRONMENT_BLOCKERS: (environmentId: string) =>
        pathToApiUrl(`/runtime/environments/${enc(environmentId)}/blockers`),
    ENVIRONMENT_EGRESS_APPROVALS: (environmentId: string) =>
        pathToApiUrl(
            `/runtime/environments/${enc(environmentId)}/egress-approvals`,
        ),
    ENVIRONMENT_BLOCKER_FIXES: (environmentId: string) =>
        pathToApiUrl(
            `/runtime/environments/${enc(environmentId)}/blockers/fixes`,
        ),
    ENVIRONMENT_RECIPE_PROPOSE: (environmentId: string) =>
        pathToApiUrl(
            `/runtime/environments/${enc(environmentId)}/recipe/propose`,
        ),
    ENVIRONMENT_LESSONS: (environmentId: string) =>
        pathToApiUrl(`/runtime/environments/${enc(environmentId)}/lessons`),
    ENVIRONMENT_LESSON_ACTION: (
        environmentId: string,
        lessonId: string,
        action: "promote" | "retire",
    ) =>
        pathToApiUrl(
            `/runtime/environments/${enc(environmentId)}/lessons/${enc(lessonId)}/${action}`,
        ),
    ENVIRONMENT_SETUP: (environmentId: string) =>
        pathToApiUrl(`/runtime/environments/${enc(environmentId)}/setup`),
    ENVIRONMENT_SETTINGS: (environmentId: string) =>
        pathToApiUrl(`/runtime/environments/${enc(environmentId)}/settings`),
    ENVIRONMENT_SUITE: (environmentId: string) =>
        pathToApiUrl(`/runtime/environments/${enc(environmentId)}/suite`),
    ENVIRONMENT_SUITE_RESUME: (environmentId: string) =>
        pathToApiUrl(
            `/runtime/environments/${enc(environmentId)}/suite/selection/resume`,
        ),
    ENVIRONMENT_SIMULATE: (environmentId: string) =>
        pathToApiUrl(`/runtime/environments/${enc(environmentId)}/simulate`),
    STOP: () => pathToApiUrl("/runtime/stop"),
    STOP_CLEAR: () => pathToApiUrl("/runtime/stop/clear"),
    CELLS: () => pathToApiUrl("/runtime/cells"),
    CELL_REGISTRATION_TOKENS: () =>
        pathToApiUrl("/runtime/cells/registration-tokens"),
    CELL_REGISTRATION_TOKEN_REVOKE: (id: string) =>
        pathToApiUrl(`/runtime/cells/registration-tokens/${enc(id)}/revoke`),
    CELL_REVOKE: (cellId: string) =>
        pathToApiUrl(`/runtime/cells/${enc(cellId)}/revoke`),
    SETTINGS: () => pathToApiUrl("/runtime/settings"),
    MACHINE_MINUTES: () => pathToApiUrl("/runtime/settings/machine-minutes"),
    USAGE: () => pathToApiUrl("/runtime/settings/usage"),
    HEALTH: () => pathToApiUrl("/runtime/settings/health"),
    HEALTH_SPEED: () => pathToApiUrl("/runtime/settings/health/speed"),
    USAGE_EXPORT: () => pathToApiUrl("/runtime/settings/usage/export"),
    REPOSITORY_SETTINGS: (repositoryId: string) =>
        pathToApiUrl(`/runtime/settings/repositories/${enc(repositoryId)}`),
    RUN_PREVIEWS: (runId: string) =>
        pathToApiUrl(`/runtime/runs/${enc(runId)}/previews`),
    PREVIEW: (previewId: string) =>
        pathToApiUrl(`/runtime/previews/${enc(previewId)}`),
    PREVIEW_GRANT: (previewId: string) =>
        pathToApiUrl(`/runtime/previews/${enc(previewId)}/grant`),
    PREVIEW_STOP: (previewId: string) =>
        pathToApiUrl(`/runtime/previews/${enc(previewId)}/stop`),
    ENVIRONMENT_PREVIEWS: (environmentId: string) =>
        pathToApiUrl(`/runtime/environments/${enc(environmentId)}/previews`),
    PREVIEW_SETTINGS: () => pathToApiUrl("/runtime/settings/preview"),
    SANDBOX_CAPACITY: () => pathToApiUrl("/sandbox-capacity"),
    PREVIEW_AUDIT: (before?: string) =>
        pathToApiUrl(
            `/runtime/audit?kind=preview&limit=50${before ? `&before=${enc(before)}` : ""}`,
        ),
} as const;

const unwrap = <T>(payload: unknown): T =>
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "data" in payload
        ? ((payload as { data: T }).data as T)
        : (payload as T);

const runtimeFetch = async <T>(
    url: string,
    init?: Parameters<typeof typedFetch>[1],
): Promise<T> => unwrap<T>(await typedFetch<unknown>(url, init));

/**
 * A single resource that is not there (another org's id, an expired Run)
 * reads as `null`. Lists never use this: a 404 on a list is a broken route or
 * a denied path, and must show as an error, not as "nothing yet".
 */
const orNullWhenMissing = async <T>(promise: Promise<T>): Promise<T | null> => {
    try {
        return await promise;
    } catch (error) {
        if (TypedFetchError.isError(error) && error.statusCode === 404)
            return null;
        throw error;
    }
};

/** The API's page size cap for GET /runtime/runs. */
export const MAX_RUNS_PAGE = 200;

export const listRuntimeRuns = (params: {
    repositoryId?: string;
    prNumber?: number;
    limit?: number;
}) =>
    runtimeFetch<RuntimeRunSummary[]>(RUNTIME_PATHS.RUNS(), {
        params: {
            repositoryId: params.repositoryId,
            prNumber:
                params.prNumber !== undefined
                    ? String(params.prNumber)
                    : undefined,
            limit:
                params.limit !== undefined
                    ? String(Math.min(params.limit, MAX_RUNS_PAGE))
                    : undefined,
        },
    });

export const getRuntimeRun = (runId: string) =>
    orNullWhenMissing(runtimeFetch<RuntimeRun>(RUNTIME_PATHS.RUN(runId)));

/** The Run's e2e suite, or `null` when the Run has none (404). */
export const getRunSuite = (runId: string) =>
    orNullWhenMissing(runtimeFetch<RuntimeSuiteRun>(RUNTIME_PATHS.RUN_SUITE(runId)));

/** "Re-run failed": the specs of the suite that did not pass, run again as a suite run of their own. */
export const retryRunSuite = (runId: string) =>
    runtimeFetch<{ suiteRunId: string; state: "queued" }>(
        RUNTIME_PATHS.RUN_SUITE_RETRY(runId),
        { method: "POST", body: JSON.stringify({}) },
    );

/** The URL (valid 5 minutes) of a file kept for a failed spec; unchecked, as the evidence URL is. */
export const getRunSuiteArtifactUrl = async (params: {
    runId: string;
    spec: string;
    name: string;
}): Promise<{ url: unknown; expiresAt?: string }> => {
    const res = await runtimeFetch<{
        url?: unknown;
        expiresAt?: string;
    } | null>(RUNTIME_PATHS.RUN_SUITE_ARTIFACT(params.runId), {
        params: { spec: params.spec, name: params.name },
    });
    return { url: res?.url, expiresAt: res?.expiresAt };
};

/** Settings, e2e suite of one environment. */
export const getEnvironmentSuite = (environmentId: string) =>
    runtimeFetch<RuntimeEnvironmentSuite>(
        RUNTIME_PATHS.ENVIRONMENT_SUITE(environmentId),
    );

/** "Resume selection": the Runtime turns spec selection on again after the shadow check paused it. */
export const resumeSuiteSelection = (environmentId: string) =>
    runtimeFetch<{ state: "requested" }>(
        RUNTIME_PATHS.ENVIRONMENT_SUITE_RESUME(environmentId),
        { method: "POST", body: JSON.stringify({}) },
    );

/** 👍/👎 on one tested path; `null` clears the vote. */
export const setFindingFeedback = (params: {
    runId: string;
    probeId: string;
    value: FindingFeedbackValue | null;
}) =>
    runtimeFetch<FindingFeedback>(
        RUNTIME_PATHS.RUN_FINDING_FEEDBACK(params.runId, params.probeId),
        { method: "PUT", body: JSON.stringify({ value: params.value }) },
    );

/**
 * "This change is intended" on a finding, or undo it. A learning signal: it
 * does not change the Run, its check or the PR comment.
 */
export const setFindingIntent = (params: {
    runId: string;
    probeId: string;
    intended: boolean;
}) =>
    runtimeFetch<FindingIntentResult>(
        RUNTIME_PATHS.RUN_FINDING_INTENT(params.runId, params.probeId),
        { method: "PUT", body: JSON.stringify({ intended: params.intended }) },
    );

/** "Run again": a new runId with attempt + 1, accepted once the Run ended. */
export const rerunRun = (runId: string) =>
    runtimeFetch<Partial<RuntimeRun> & { runId: string }>(
        RUNTIME_PATHS.RUNS(),
        {
            method: "POST",
            body: JSON.stringify({ runId }),
        },
    );

/** Opens (or finds) the preview of one side of a finished Run (docs/runtime/preview-urls.md §9.3). */
export const openRunPreview = (runId: string, side: PreviewSide) =>
    runtimeFetch<RuntimePreview>(RUNTIME_PATHS.RUN_PREVIEWS(runId), {
        method: "POST",
        body: JSON.stringify({ side }),
    });

export const getRunPreview = (previewId: string) =>
    runtimeFetch<RuntimePreview>(RUNTIME_PATHS.PREVIEW(previewId));

/** Both sides of a Run's preview and whether they can open (the Run page card). */
export const getRunPreviews = (runId: string) =>
    runtimeFetch<RuntimeRunPreviews>(RUNTIME_PATHS.RUN_PREVIEWS(runId));

export const stopRunPreview = (previewId: string) =>
    runtimeFetch<RuntimePreview>(RUNTIME_PATHS.PREVIEW_STOP(previewId), {
        method: "POST",
    });

/** The environment's own preview: its base at the last setup's commit. */
export const getEnvironmentPreview = (environmentId: string) =>
    runtimeFetch<RuntimeEnvironmentPreview>(
        RUNTIME_PATHS.ENVIRONMENT_PREVIEWS(environmentId),
    );

export const openEnvironmentPreview = (environmentId: string) =>
    runtimeFetch<RuntimePreview>(
        RUNTIME_PATHS.ENVIRONMENT_PREVIEWS(environmentId),
        { method: "POST" },
    );

export const getPreviewSettings = () =>
    runtimeFetch<RuntimePreviewSettingsView>(RUNTIME_PATHS.PREVIEW_SETTINGS());

export const updatePreviewSettings = (settings: RuntimePreviewSettings) =>
    runtimeFetch<RuntimePreviewSettingsView>(RUNTIME_PATHS.PREVIEW_SETTINGS(), {
        method: "PUT",
        body: JSON.stringify(settings),
    });

export const listPreviewActivity = (before?: string) =>
    runtimeFetch<{ items: RuntimePreviewAuditRecord[] }>(
        RUNTIME_PATHS.PREVIEW_AUDIT(before),
    );

/** A single-use, 60-second grant inside the URL to send the browser to: use it at once. */
export const grantRunPreview = (previewId: string, to = "/") =>
    runtimeFetch<{ redirectUrl: string; expiresAt: string }>(
        RUNTIME_PATHS.PREVIEW_GRANT(previewId),
        { method: "POST", body: JSON.stringify({ to }) },
    );

/**
 * Approves a fork Run waiting for a maintainer. The API binds it to the
 * current head and refuses the PR author or someone without write access.
 */
export const approveRun = (runId: string) =>
    runtimeFetch<{ runId: string; headSha: string; approvedAt: string }>(
        RUNTIME_PATHS.RUN_APPROVALS(runId),
        { method: "POST" },
    );

/**
 * Simulate: one Run on a past PR of the environment's primary repository, or
 * of one of its members (`repositoryId`); nothing is posted.
 */
export const simulateRun = (params: {
    environmentId: string;
    prNumber: number;
    repositoryId?: string;
}) =>
    runtimeFetch<{ runId: string; state: "queued" }>(
        RUNTIME_PATHS.ENVIRONMENT_SIMULATE(params.environmentId),
        {
            method: "POST",
            body: JSON.stringify({
                prNumber: params.prNumber,
                ...(params.repositoryId
                    ? { repositoryId: params.repositoryId }
                    : {}),
            }),
        },
    );

/** Recorded JSON data, never a host-executable replay artifact. */
export const getRunReproduction = async (runId: string, probeId: string) => {
    const response = await runtimeFetch<unknown>(
        RUNTIME_PATHS.RUN_REPRODUCE(runId, probeId),
    );
    const data = readReproductionDownload(response, { runId, probeId });
    if (!data) throw new Error("Reproduction data is unavailable");
    return data;
};

/**
 * The evidence URL (valid 5 minutes) the API mints for one step. The URL is
 * returned unchecked (`unknown`): the caller passes it to checkEvidenceUrl
 * before opening it.
 */
export const getRunEvidenceUrl = async (params: {
    runId: string;
    stepId: string;
    side: EvidenceSide;
    type?: EvidenceType;
}): Promise<{ url: unknown; expiresAt?: string }> => {
    const res = await runtimeFetch<{
        url?: unknown;
        expiresAt?: string;
    } | null>(RUNTIME_PATHS.RUN_EVIDENCE(params.runId, params.stepId), {
        params: { side: params.side, type: params.type ?? "output" },
    });
    return { url: res?.url, expiresAt: res?.expiresAt };
};

/**
 * One long-poll read of the Run stream. Returns null while the stream does
 * not exist (404); throws RunStreamFatalError for answers a retry cannot fix.
 */
export const readRunStreamPage = async (
    runId: string,
    offset: string | undefined,
    signal: AbortSignal,
): Promise<RunStreamPage | null> => {
    const url = addSearchParamsToUrl(RUNTIME_PATHS.RUN_STREAM(runId), {
        offset: offset ?? "-1",
        live: "long-poll",
    });
    const response = await fetch(url, {
        signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
    });
    if (response.status === 404) return null;
    if (response.status === 204)
        return parseStreamResponse(null, response.headers, offset);
    if ([400, 401, 403, 410].includes(response.status)) {
        throw new RunStreamFatalError(
            `stream read failed (${response.status})`,
            response.status,
        );
    }
    if (!response.ok)
        throw new Error(`stream read failed (${response.status})`);
    const body = await response.json().catch(() => null);
    return parseStreamResponse(body, response.headers, offset);
};

export const listRuntimeEnvironments = () =>
    runtimeFetch<RuntimeEnvironment[]>(RUNTIME_PATHS.ENVIRONMENTS());

/** Each environment's state and setup times: what the screens poll while a setup runs. */
export const listRuntimeEnvironmentStatuses = () =>
    runtimeFetch<RuntimeEnvironmentStatus[]>(
        RUNTIME_PATHS.ENVIRONMENT_STATUSES(),
    );

export const getRuntimeEnvironment = (environmentId: string) =>
    orNullWhenMissing(
        runtimeFetch<RuntimeEnvironment>(
            RUNTIME_PATHS.ENVIRONMENT(environmentId),
        ),
    );

export const listEnvironmentBlockers = (environmentId: string) =>
    runtimeFetch<Array<BlockerGroup | RuntimeBlocker>>(
        RUNTIME_PATHS.ENVIRONMENT_BLOCKERS(environmentId),
    );

export const listEnvironmentLessons = (environmentId: string) =>
    runtimeFetch<RuntimeLesson[]>(
        RUNTIME_PATHS.ENVIRONMENT_LESSONS(environmentId),
    );

/** Promote a lesson to the whole org, or retire it (org admins). */
export const updateEnvironmentLesson = (params: {
    environmentId: string;
    lessonId: string;
    action: "promote" | "retire";
}) =>
    runtimeFetch<{ lessonId: string; action: string; requestedAt: string }>(
        RUNTIME_PATHS.ENVIRONMENT_LESSON_ACTION(
            params.environmentId,
            params.lessonId,
            params.action,
        ),
        { method: "POST" },
    );

/** Applies a fix the catalog offers: one click runs now, a recipe fix opens a PR. */
export const applyBlockerFix = (params: {
    environmentId: string;
    signature: string;
    fixId: string;
    /** An allow-host fix: reads only (default) or full access, the card's second step. */
    mode?: EgressApprovalMode;
}) =>
    runtimeFetch<AppliedBlockerFix>(
        RUNTIME_PATHS.ENVIRONMENT_BLOCKER_FIXES(params.environmentId),
        {
            method: "POST",
            body: JSON.stringify({
                signature: params.signature,
                fixId: params.fixId,
                ...(params.mode ? { mode: params.mode } : {}),
            }),
        },
    );

/** environmentId "*" is the org list (owners only). Inspected unless mode says passthrough. */
export const approveEgressHost = (params: {
    environmentId: string;
    host: string;
    mode?: EgressApprovalMode;
    pathPrefixes?: string[];
    source?: "blocker" | "settings";
}) =>
    runtimeFetch<unknown>(
        RUNTIME_PATHS.ENVIRONMENT_EGRESS_APPROVALS(params.environmentId),
        {
            method: "POST",
            body: JSON.stringify({
                host: params.host,
                ...(params.mode ? { mode: params.mode } : {}),
                ...(params.pathPrefixes?.length
                    ? { pathPrefixes: params.pathPrefixes }
                    : {}),
                ...(params.source ? { source: params.source } : {}),
            }),
        },
    );

/** Revokes an approval: the scope's live claims lose the host at once (G3). */
export const revokeEgressHost = (params: {
    environmentId: string;
    host: string;
}) =>
    runtimeFetch<unknown>(
        `${RUNTIME_PATHS.ENVIRONMENT_EGRESS_APPROVALS(params.environmentId)}/${enc(params.host)}`,
        { method: "DELETE", body: JSON.stringify({}) },
    );

export const getOrgEgress = () =>
    runtimeFetch<OrgEgress>(pathToApiUrl("/runtime/egress"));

export const updateOrgEgressSettings = (body: {
    recommendedEnabled?: boolean;
    whoMayAdd?: EgressWhoMayAdd;
}) =>
    runtimeFetch<unknown>(pathToApiUrl("/runtime/egress/settings"), {
        method: "PUT",
        body: JSON.stringify(body),
    });

/**
 * Creates the repo's environment (idempotent) and asks the Runtime to set it
 * up. The answer is the stored row, not the environment view: only its id is
 * read; the page reads the view itself.
 */
export const createRuntimeEnvironment = (repositoryId: string) =>
    runtimeFetch<Pick<RuntimeEnvironment, "environmentId">>(
        RUNTIME_PATHS.ENVIRONMENTS(),
        {
            method: "POST",
            body: JSON.stringify({ repositoryId }),
        },
    );

/** Opens the PR that adds the recipe Kodus inferred, once it booted on two clean machines. */
export const proposeInferredRecipe = (environmentId: string) =>
    runtimeFetch<ProposedRecipe>(
        RUNTIME_PATHS.ENVIRONMENT_RECIPE_PROPOSE(environmentId),
        { method: "POST" },
    );

export const requestEnvironmentSetup = (environmentId: string) =>
    runtimeFetch<RuntimeEnvironment>(
        RUNTIME_PATHS.ENVIRONMENT_SETUP(environmentId),
        { method: "POST" },
    );

export const listRuntimeCells = () =>
    runtimeFetch<RuntimeCell[]>(RUNTIME_PATHS.CELLS());

/** A single-use token, valid for 15 minutes; its plain value is returned once. */
export const createCellRegistrationToken = (topology: CellTopology) =>
    runtimeFetch<CellRegistrationToken>(
        RUNTIME_PATHS.CELL_REGISTRATION_TOKENS(),
        {
            method: "POST",
            body: JSON.stringify({ topology }),
        },
    );

export const listCellRegistrationTokens = () =>
    runtimeFetch<CellRegistrationTokenView[]>(
        RUNTIME_PATHS.CELL_REGISTRATION_TOKENS(),
    );

/** A pending token only; a cell already registered with it is revoked as a cell. */
export const revokeCellRegistrationToken = (id: string) =>
    runtimeFetch<unknown>(RUNTIME_PATHS.CELL_REGISTRATION_TOKEN_REVOKE(id), {
        method: "POST",
    });

/** The hub drops the cell's connection and refuses its certificate. */
export const revokeRuntimeCell = (params: {
    cellId: string;
    reason?: string;
}) =>
    runtimeFetch<unknown>(RUNTIME_PATHS.CELL_REVOKE(params.cellId), {
        method: "POST",
        body: JSON.stringify(params.reason ? { reason: params.reason } : {}),
    });

export const stopRuntime = (scope: RuntimeStopScope) =>
    runtimeFetch<unknown>(RUNTIME_PATHS.STOP(), {
        method: "POST",
        body: JSON.stringify({ scope }),
    });

/** Reopens the Runtime after a stop (same scope rules as the stop). */
export const resumeRuntime = (scope: RuntimeStopScope) =>
    runtimeFetch<unknown>(RUNTIME_PATHS.STOP_CLEAR(), {
        method: "POST",
        body: JSON.stringify({ scope }),
    });

/** Only the fields sent change; `poolSize: null` is the plan's default, `machineSize: null` the cell's. */
export const updateEnvironmentSettings = ({
    environmentId,
    ...body
}: {
    environmentId: string;
    diagnosticHold?: boolean;
    machineSize?: MachineSizePreset | null;
    forkPullRequests?: ForkPullRequestPolicy;
    poolSize?: number | null;
    poolPolicy?: PoolPolicy | null;
    previewSecrets?: "none" | "run";
    /** Run the e2e suite on every push as a CI check; null follows the deployment's default. */
    suiteCi?: boolean | null;
    /** Run only the specs the change reaches (false: the whole suite on every pull request). */
    suiteSelection?: boolean;
}) =>
    runtimeFetch<unknown>(RUNTIME_PATHS.ENVIRONMENT_SETTINGS(environmentId), {
        method: "PATCH",
        body: JSON.stringify(body),
    });

export const getRuntimeSettings = () =>
    runtimeFetch<RuntimeSettings>(RUNTIME_PATHS.SETTINGS());

export const getRuntimeMachineMinutes = () =>
    runtimeFetch<RuntimeMachineMinutesToday>(RUNTIME_PATHS.MACHINE_MINUTES());

/** Org admin. A whole number of minutes lowers the deployment's daily limit for the org; `null` removes the org's own. */
export const updateRuntimeMachineMinutes = (body: {
    minutesPerDay: number | null;
}) =>
    runtimeFetch<RuntimeMachineMinutesLimitChange>(
        RUNTIME_PATHS.MACHINE_MINUTES(),
        {
            method: "PATCH",
            body: JSON.stringify(body),
        },
    );

/** The month (`YYYY-MM`, UTC) and the filters of the usage report and its CSV. */
export type RuntimeUsageQuery = {
    month: string;
    repositoryId?: string;
    environmentId?: string;
};

const usageParams = (q: RuntimeUsageQuery) => ({
    month: q.month,
    repositoryId: q.repositoryId,
    environmentId: q.environmentId,
});

export const getRuntimeHealth = () =>
    runtimeFetch<RuntimeHealth>(RUNTIME_PATHS.HEALTH());

export const getRuntimeSpeed = (windowDays: SpeedWindowDays) =>
    runtimeFetch<RuntimeSpeed>(RUNTIME_PATHS.HEALTH_SPEED(), {
        params: { windowDays },
    });

export const getRuntimeUsageReport = (q: RuntimeUsageQuery) =>
    runtimeFetch<RuntimeUsageReport>(RUNTIME_PATHS.USAGE(), {
        params: usageParams(q),
    });

/** The report's Runs as CSV text, from the API's export (the same numbers as the screen). */
export const getRuntimeUsageCsv = async (q: RuntimeUsageQuery) => {
    const url = addSearchParamsToUrl(
        RUNTIME_PATHS.USAGE_EXPORT(),
        usageParams(q),
    );
    const response = await fetch(url, { headers: { Accept: "text/csv" } });
    if (!response.ok)
        throw new TypedFetchError(response.status, response.statusText, url);
    return {
        filename: `kody-runtime-usage-${q.month}.csv`,
        text: await response.text(),
    };
};

/** A field left out is kept by the API. */
export const updateRuntimeOrgSettings = (body: {
    tokenBudgetPerDay?: number | null;
    exercisedLinesThresholdPercent?: number | null;
    machineUsdPerHostHour?: number | null;
}) =>
    runtimeFetch<RuntimeSettings>(RUNTIME_PATHS.SETTINGS(), {
        method: "PATCH",
        body: JSON.stringify(body),
    });

/** `mode` is the one on/off switch the UI writes (the API derives `pilot`). */
export const updateRuntimeRepositorySettings = ({
    repositoryId,
    ...body
}: { repositoryId: string } & Partial<RuntimeSettingsPayload>) =>
    runtimeFetch<RuntimeRepositorySettings>(
        RUNTIME_PATHS.REPOSITORY_SETTINGS(repositoryId),
        { method: "PUT", body: JSON.stringify(body) },
    );

/**
 * Adds a connected repository to the environment and asks for a setup; Runs
 * keep the last good setup until the new one boots. `alias` defaults to the
 * repository's name on the API.
 */
export const addEnvironmentRepository = ({
    environmentId,
    ...body
}: {
    environmentId: string;
    repositoryId: string;
    alias?: string;
    triggers?: boolean;
    pairBranches?: boolean;
}) =>
    runtimeFetch<EnvironmentRepositoriesResult>(
        RUNTIME_PATHS.ENVIRONMENT_REPOSITORIES(environmentId),
        { method: "POST", body: JSON.stringify(body) },
    );

/** Only the fields sent change; a new alias asks for a setup. */
export const updateEnvironmentRepository = ({
    environmentId,
    repositoryId,
    ...body
}: {
    environmentId: string;
    repositoryId: string;
    alias?: string;
    triggers?: boolean;
    pairBranches?: boolean;
}) =>
    runtimeFetch<EnvironmentRepositoriesResult>(
        RUNTIME_PATHS.ENVIRONMENT_REPOSITORY(environmentId, repositoryId),
        { method: "PATCH", body: JSON.stringify(body) },
    );

/** Removes a member (never the primary) and asks for a setup without it. */
export const removeEnvironmentRepository = (params: {
    environmentId: string;
    repositoryId: string;
}) =>
    runtimeFetch<EnvironmentRepositoriesResult>(
        RUNTIME_PATHS.ENVIRONMENT_REPOSITORY(
            params.environmentId,
            params.repositoryId,
        ),
        { method: "DELETE" },
    );

export const getSandboxCapacity = () =>
    runtimeFetch<SandboxCapacityView>(RUNTIME_PATHS.SANDBOX_CAPACITY());

export const updateSandboxCapacity = (settings: {
    maxConcurrent: number | null;
    maxWaitMs: number;
}) =>
    runtimeFetch<SandboxCapacityView>(RUNTIME_PATHS.SANDBOX_CAPACITY(), {
        method: "PUT",
        body: JSON.stringify(settings),
    });
