import type {
    IssueOwner,
    IssueSecurityDetails,
    SecurityVulnerabilityClass,
} from "@services/issues/types";
import type { SecurityScan } from "@services/security-scans/types";

const usd = (value: number) =>
    new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    }).format(value);

/** 1234567 → "1.2M", 2000000 → "2M", 850 → "850". */
export const formatTokenCount = (value: number) =>
    new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
    }).format(value);

/** "$3.12 of $20" or "1.2M of 2M tokens". */
export const formatScanSpend = ({
    budget,
    spend,
}: Pick<SecurityScan, "budget" | "spend">): string => {
    if (budget.maxUsd !== undefined) {
        return `${usd(spend.usd)} of ${usd(budget.maxUsd)}`;
    }

    const tokens = spend.inputTokens + spend.outputTokens;
    if (budget.maxTokens !== undefined) {
        return `${formatTokenCount(tokens)} of ${formatTokenCount(budget.maxTokens)} tokens`;
    }

    return usd(spend.usd);
};

/** "38/40 areas examined · 2 skipped at the limit · 1 failed". */
export const formatScanCoverage = (
    coverage: SecurityScan["coverage"],
): string | undefined => {
    if (!coverage || coverage.unitsTotal === 0) return undefined;

    const parts = [
        `${coverage.unitsDone}/${coverage.unitsTotal} areas examined`,
    ];
    if (coverage.unitsSkippedByBudget > 0) {
        parts.push(`${coverage.unitsSkippedByBudget} skipped at the limit`);
    }
    if (coverage.unitsFailed > 0) {
        parts.push(`${coverage.unitsFailed} failed`);
    }

    return parts.join(" · ");
};

/** "5 new · 2 still open · 1 resolved", or "No findings". */
export const formatScanOutcome = (
    outcome: SecurityScan["outcome"],
): string | undefined => {
    if (!outcome) return undefined;

    const parts = [
        [outcome.created, "new"],
        [outcome.stillOpen, "still open"],
        [outcome.reopened, "reopened"],
        [outcome.resolved, "resolved"],
        [outcome.dismissed, "dismissed"],
    ] as const;

    const nonZero = parts.filter(([count]) => count > 0);
    if (nonZero.length === 0) return "No findings";

    return nonZero.map(([count, label]) => `${count} ${label}`).join(" · ");
};

export const SCAN_STATUS_LABEL = {
    queued: "Queued",
    running: "Running",
    completed: "Completed",
    stopped_by_budget: "Stopped at limit",
    failed: "Failed",
} as const satisfies Record<SecurityScan["status"], string>;

export const VULNERABILITY_CLASS_LABEL = {
    authz: "Authorization",
    injection: "Injection",
    ssrf: "SSRF",
    data_exposure: "Data exposure",
    secret_identity: "Secrets and identity",
    misconfiguration: "Misconfiguration",
} as const satisfies Record<SecurityVulnerabilityClass, string>;

export const OWNER_ORIGIN_NOTE = {
    pr_author: "PR author",
    codeowners: "from CODEOWNERS",
    last_author: "last author",
} as const satisfies Record<NonNullable<IssueOwner["origin"]>, string>;

/** "CWE-89" → its MITRE page. Anything else has no link. */
export const cweUrl = (cwe: string): string | undefined => {
    const id = /^CWE-(\d+)$/i.exec(cwe.trim())?.[1];
    return id ? `https://cwe.mitre.org/data/definitions/${id}.html` : undefined;
};

/** "handler (lines 12-40)", "handler (line 12)" or just "handler". */
export const formatSymbolLines = ({
    symbol,
    startLine,
    endLine,
}: Pick<IssueSecurityDetails, "symbol" | "startLine" | "endLine">):
    string | undefined => {
    let lines: string | undefined;
    if (
        startLine !== undefined &&
        endLine !== undefined &&
        endLine !== startLine
    ) {
        lines = `lines ${startLine}-${endLine}`;
    } else if (startLine !== undefined) {
        lines = `line ${startLine}`;
    }

    if (symbol && lines) return `${symbol} (${lines})`;
    return (
        symbol ?? (lines ? lines[0].toUpperCase() + lines.slice(1) : undefined)
    );
};

type Reproduction = NonNullable<
    NonNullable<IssueSecurityDetails["evidence"]>["reproduction"]
>;

export const reproductionStatus = (
    reproduction: Pick<Reproduction, "executed" | "reproduced" | "exitCode">,
): { label: string; tone: "danger" | "warning" | "neutral" } => {
    if (reproduction.executed && reproduction.reproduced) {
        return { label: "Reproduced in an isolated sandbox", tone: "danger" };
    }

    // A test that did not pass here most often needed what the sandbox does
    // not have (the app running, its database, a secret): it is no evidence
    // against the finding, so it reads as a test to run, not a verdict.
    return { label: "Reproduction test to run", tone: "neutral" };
};

/** The API's "no known price" refusal: the scan can only be capped in tokens. */
export const isNoKnownPriceMessage = (message: string | undefined) =>
    !!message && /no known price/i.test(message);
