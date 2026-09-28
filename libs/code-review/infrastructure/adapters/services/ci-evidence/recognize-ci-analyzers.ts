import { CheckEvidence } from '@libs/platform/domain/platformIntegrations/types/codeManagement/checkEvidence.type';

/**
 * Analyzers we can recognize in a customer's CI.
 *
 * Deliberately broader than what we run ourselves: recognition feeds the CI
 * evidence shown to the reviewer as well as the duplication check, and knowing
 * a repository already runs CodeQL is worth telling the reviewer even though we
 * no longer run anything equivalent.
 */
export type KnownAnalyzer =
    | 'semgrep'
    | 'opengrep'
    | 'codeql'
    | 'snyk'
    | 'sonarqube'
    | 'checkmarx'
    | 'bandit'
    | 'brakeman'
    | 'gitleaks'
    | 'trufflehog'
    | 'ggshield'
    | 'detect-secrets'
    | 'actionlint'
    | 'zizmor'
    | 'osv-scanner'
    | 'dependabot'
    | 'trivy'
    | 'checkov'
    | 'tfsec';

/** Deterministic tools Kody can run itself. */
export enum ManagedTool {
    SECRETS = 'secrets',
    DEPENDENCIES = 'dependencies',
}

const ANALYZER_ALIASES: Record<KnownAnalyzer, readonly string[]> = {
    semgrep: ['semgrep'],
    opengrep: ['opengrep'],
    codeql: ['codeql'],
    snyk: ['snyk'],
    sonarqube: ['sonarqube', 'sonarcloud', 'sonar'],
    checkmarx: ['checkmarx'],
    bandit: ['bandit'],
    brakeman: ['brakeman'],
    gitleaks: ['gitleaks'],
    trufflehog: ['trufflehog', 'truffle hog'],
    ggshield: ['ggshield', 'gitguardian'],
    'detect-secrets': ['detect-secrets', 'detect secrets'],
    actionlint: ['actionlint'],
    zizmor: ['zizmor'],
    'osv-scanner': ['osv-scanner', 'osv scanner'],
    dependabot: ['dependabot'],
    trivy: ['trivy'],
    checkov: ['checkov'],
    tfsec: ['tfsec'],
};

/**
 * Which CI analyzers make one of our tools redundant. Only the two we actually
 * run appear here, and it deliberately does not cross categories: a SAST run
 * proves nothing about secret scanning.
 */
const COVERED_BY: Record<ManagedTool, readonly KnownAnalyzer[]> = {
    [ManagedTool.SECRETS]: [
        'gitleaks',
        'trufflehog',
        'ggshield',
        'detect-secrets',
    ],
    // Deliberately narrow. Standing down is only safe when the check proves a
    // dependency scan actually ran on this commit, and a NAME does not:
    // "Dependabot auto-merge" is a merge workflow that scans nothing, while
    // `trivy` and `snyk` are as often container or SAST jobs as they are SCA.
    // Treating those as coverage silently disabled the scan; recognizing them
    // for display (`recognizeCiAnalyzers`) stays unchanged.
    [ManagedTool.DEPENDENCIES]: ['osv-scanner'],
};

/**
 * Conclusions that mean the analysis actually produced a result. A non-zero
 * exit is how most scanners report findings, so `failure` counts; the rest
 * mean the job never delivered an answer.
 */
const CONCLUSIVE = new Set(['success', 'failure', 'neutral', 'action_required']);

const escapeForRegex = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Alias must sit on its own word boundary — a substring match would read
 * "resemgrepped" as semgrep and silently disable our own scan.
 */
const mentions = (haystack: string, alias: string): boolean =>
    new RegExp(`(?:^|[^a-z0-9])${escapeForRegex(alias)}(?:[^a-z0-9]|$)`).test(
        haystack,
    );

const hasRun = (check: CheckEvidence): boolean =>
    check.status === 'completed' &&
    check.conclusion !== null &&
    CONCLUSIVE.has(check.conclusion);

/** Analyzers the customer's CI already ran to completion for this commit. */
export function recognizeCiAnalyzers(
    evidence: readonly CheckEvidence[],
): Set<KnownAnalyzer> {
    const found = new Set<KnownAnalyzer>();

    for (const check of evidence) {
        if (!hasRun(check)) {
            continue;
        }

        const haystacks = [check.name, check.reporter]
            .filter((value): value is string => Boolean(value))
            .map((value) => value.toLowerCase());

        for (const [analyzer, aliases] of Object.entries(ANALYZER_ALIASES)) {
            const hit = aliases.some((alias) =>
                haystacks.some((haystack) => mentions(haystack, alias)),
            );
            if (hit) {
                found.add(analyzer as KnownAnalyzer);
            }
        }
    }

    return found;
}

/** Whether the customer's CI already covers what `tool` would report. */
export function isToolCoveredByCi(
    tool: ManagedTool,
    evidence: readonly CheckEvidence[],
): boolean {
    const ran = recognizeCiAnalyzers(evidence);
    return COVERED_BY[tool].some((analyzer) => ran.has(analyzer));
}
