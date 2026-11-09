"use client";

import { useMemo, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Page } from "@components/ui/page";
import { useIssues } from "@services/issues/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useSecurityScans } from "@services/security-scans/hooks";
import { useAuth } from "src/core/providers/auth.provider";
import { usePermissions } from "src/core/providers/permissions.provider";
import type { SeverityLevel } from "src/core/types";
import { hasPermission } from "src/core/utils/permission-map";
import { safeArray } from "src/core/utils/safe-array";

import { IssueDetailsRightSheet } from "../issues/_components/issue-details-right-sheet";
import { RunSecurityScanButton } from "../issues/_components/security-scan/run-security-scan-dialog";
import { useRefreshIssuesAsScansProgress } from "../issues/_components/security-scan/use-refresh-issues-as-scans-progress";
import {
    FindingsList,
    type FindingsStatusFilter,
} from "./_components/findings-list";
import { ScanHistory } from "./_components/scan-history";
import { ScanStatusBanner } from "./_components/scan-status-banner";
import { SeveritySummary } from "./_components/severity-summary";

/**
 * Deep scan: scan a whole repository for vulnerabilities and work through
 * what it found. Read top to bottom: where scanning stands, how much is open
 * at each severity, the findings themselves, then every scan run.
 */
export default function DeepScanPage() {
    const permissions = usePermissions();
    const { organizationId } = useAuth();
    const { data: issues, isLoading } = useIssues();
    const { data: scans, isFetched } = useSecurityScans();
    useRefreshIssuesAsScansProgress(scans, isFetched);

    const [status, setStatus] = useState<FindingsStatusFilter>("open");
    const [severity, setSeverity] = useState<SeverityLevel | null>(null);

    const findings = useMemo(
        () =>
            safeArray(issues).filter(
                (issue) =>
                    issue.source === "security_scan" &&
                    hasPermission({
                        permissions,
                        organizationId: organizationId!,
                        action: Action.Read,
                        resource: ResourceType.Issues,
                        repoId: issue.repository.id,
                    }),
            ),
        [issues, permissions, organizationId],
    );

    return (
        <Page.Root>
            <Page.Header>
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <Page.Title>Deep scan</Page.Title>
                        <Badge>Beta</Badge>
                    </div>
                    <p className="text-text-secondary max-w-2xl text-sm">
                        Finds broken access control, injection, XSS, SSRF, data
                        exposure, leaked secrets and unsafe settings in a
                        repository&apos;s default branch, with your
                        organization&apos;s model, within the spend limit you
                        set.
                    </p>
                    <p className="text-text-tertiary max-w-2xl text-xs">
                        Deep scan is in beta and free on every plan while it is.
                        Expect some findings that are not exploitable: check
                        each before acting on it.
                    </p>
                </div>

                <RunSecurityScanButton />
            </Page.Header>

            <Page.Content>
                <ScanStatusBanner scans={scans} />

                <SeveritySummary
                    findings={findings}
                    selected={severity}
                    onSelect={(next) => {
                        setSeverity(next);
                        if (next) setStatus("open");
                    }}
                />

                <FindingsList
                    findings={findings}
                    loading={isLoading}
                    status={status}
                    onStatusChange={setStatus}
                    severity={severity}
                />

                <ScanHistory scans={scans} />
            </Page.Content>

            <IssueDetailsRightSheet issues={findings} />
        </Page.Root>
    );
}
