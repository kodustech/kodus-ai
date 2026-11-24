"use client";

import { useState } from "react";
import { Alert, AlertDescription } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Link } from "@components/ui/link";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { EXPORT_MAX_ISSUES } from "@libs/security-scan/domain/scan-schedule";
import type { IssueListItem } from "@services/issues/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { exportScanFindings } from "@services/security-scans/fetch";
import { useExportDestinations } from "@services/security-scans/hooks";
import type { ExportResult } from "@services/security-scans/types";
import { useQueryClient } from "@tanstack/react-query";
import { SendIcon, XCircleIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { extractRejectionMessage } from "src/core/utils/extract-error-message";

const RESULT_LABEL: Record<ExportResult["status"], string> = {
    created: "Filed",
    already: "Already filed",
    failed: "Not filed",
    skipped: "Skipped",
};

/**
 * "File in…": Kody files the listed findings in the team's own tool, through
 * one of the organization's plugins, one item per finding.
 */
export const ExportFindingsButton = ({
    findings,
}: {
    findings: IssueListItem[];
}) => {
    const canExport = usePermission(Action.Create, ResourceType.SecurityScan);
    const [open, setOpen] = useState(false);

    if (!canExport || findings.length === 0) return null;

    const count = Math.min(findings.length, EXPORT_MAX_ISSUES);

    return (
        <>
            <Button
                size="sm"
                variant="secondary"
                leftIcon={<SendIcon />}
                onClick={() => setOpen(true)}>
                {count === 1 ? "File in…" : `File ${count} in…`}
            </Button>

            {open && (
                <ExportFindingsDialog
                    findings={findings.slice(0, EXPORT_MAX_ISSUES)}
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    );
};

const ExportFindingsDialog = ({
    findings,
    onClose,
}: {
    findings: IssueListItem[];
    onClose: () => void;
}) => {
    const { teamId } = useSelectedTeamId();
    const queryClient = useQueryClient();
    const destinations = useExportDestinations(teamId);
    const [integrationId, setIntegrationId] = useState("");
    const [note, setNote] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string>();
    const [results, setResults] = useState<ExportResult[]>();

    const titleOf = new Map(findings.map((f) => [f.uuid, f.title]));

    const submit = async () => {
        if (!teamId || !integrationId) return;
        setSubmitting(true);
        setError(undefined);
        try {
            const out = await exportScanFindings({
                teamId,
                issueIds: findings.map((f) => f.uuid),
                integrationId,
                ...(note.trim() ? { destinationNote: note.trim() } : {}),
            });
            setResults(out);
            await queryClient.invalidateQueries();
        } catch (e) {
            setError(
                extractRejectionMessage(e) ??
                    "We couldn't file the findings. Try again.",
            );
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        File {findings.length}{" "}
                        {findings.length === 1 ? "finding" : "findings"} in…
                    </DialogTitle>
                    <DialogDescription>
                        Kody creates one item per finding in the tool you pick,
                        through your organization&apos;s plugin and model. It
                        only reads and creates there: nothing that exists is
                        changed, and a finding already filed there is not filed
                        again. These are unfixed vulnerabilities: pick a private
                        destination.
                    </DialogDescription>
                </DialogHeader>

                {results ? (
                    <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto text-sm">
                        {results.map((r) => (
                            <li key={r.issueId} className="flex flex-col">
                                <span className="text-text-primary truncate">
                                    {titleOf.get(r.issueId) ?? r.issueId}
                                </span>
                                <span className="text-text-secondary text-xs">
                                    {RESULT_LABEL[r.status]}
                                    {r.url && (
                                        <>
                                            {" · "}
                                            <Link
                                                href={r.url}
                                                target="_blank"
                                                className="underline">
                                                {r.ticketId || r.url}
                                            </Link>
                                        </>
                                    )}
                                    {r.error && ` · ${r.error}`}
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <form
                        id="export-findings"
                        className="flex flex-col gap-5"
                        onSubmit={(ev) => {
                            ev.preventDefault();
                            submit();
                        }}>
                        <FormControl.Root>
                            <FormControl.Label htmlFor="export-destination">
                                Plugin
                            </FormControl.Label>
                            <FormControl.Input>
                                <Select
                                    value={integrationId}
                                    disabled={submitting}
                                    onValueChange={setIntegrationId}>
                                    <SelectTrigger
                                        id="export-destination"
                                        size="md"
                                        loading={destinations.isLoading}>
                                        <SelectValue placeholder="Choose a plugin" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {destinations.data.map((d) => (
                                            <SelectItem
                                                key={d.integrationId}
                                                value={d.integrationId}>
                                                {d.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </FormControl.Input>
                            {!destinations.isLoading &&
                                destinations.data.length === 0 && (
                                    <FormControl.Helper>
                                        No plugin of this organization can
                                        create anything. Connect one (Linear,
                                        Jira, GitHub…) in Plugins.
                                    </FormControl.Helper>
                                )}
                        </FormControl.Root>

                        <FormControl.Root>
                            <FormControl.Label htmlFor="export-note">
                                Where in it (optional)
                            </FormControl.Label>
                            <FormControl.Input>
                                <Input
                                    id="export-note"
                                    size="md"
                                    placeholder='e.g. "team SEC", "project APPSEC", "#security"'
                                    value={note}
                                    disabled={submitting}
                                    maxLength={300}
                                    onChange={(ev) => setNote(ev.target.value)}
                                />
                            </FormControl.Input>
                        </FormControl.Root>

                        {error && (
                            <Alert variant="danger">
                                <XCircleIcon />
                                <AlertDescription>{error}</AlertDescription>
                            </Alert>
                        )}
                    </form>
                )}

                <DialogFooter>
                    <Button size="md" variant="cancel" onClick={onClose}>
                        {results ? "Close" : "Cancel"}
                    </Button>
                    {!results && (
                        <Button
                            size="md"
                            variant="primary"
                            type="submit"
                            form="export-findings"
                            leftIcon={<SendIcon />}
                            loading={submitting}
                            disabled={!integrationId || submitting}>
                            File them
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
