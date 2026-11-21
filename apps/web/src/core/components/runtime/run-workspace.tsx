"use client";

import {
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";
import type { WorkspaceSideRow } from "@services/runtime/model/environment-repositories";

import { RuntimeSection, RuntimeSubsection } from "./section";

const Side = ({ side }: { side: WorkspaceSideRow["base"] }) => (
    <span className="text-sm">
        <code className="text-text-primary font-mono text-xs">{side.sha}</code>
        <span className="text-text-tertiary"> · {side.label}</span>
    </span>
);

/**
 * "What ran on each side" of a multi-repository Run: the commit of every
 * repository on the base side and on the PR side, and why the PR side is
 * that commit. Nothing for a Run of one repository.
 */
export const RunWorkspaceSection = ({
    rows,
    pullRequestBranch,
    embedded = false,
}: {
    rows: WorkspaceSideRow[];
    /** The Run's own PR branch, when known: a paired PR elsewhere comes from a branch of this name. */
    pullRequestBranch?: string;
    /** Inside a section that already has a panel ("What was running"). */
    embedded?: boolean;
}) => {
    if (!rows.length) return null;
    const unpaired = rows.some((r) => r.source === "default_branch");
    const Section = embedded ? RuntimeSubsection : RuntimeSection;
    return (
        <Section
            title="What ran on each side"
            description="The only difference between the sides is this pull request. The other repositories were fixed at one commit when the Run started.">
            <TableContainer>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Repository</TableHead>
                            <TableHead>Base side</TableHead>
                            <TableHead>PR side</TableHead>
                            <TableHead>Why this commit</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((r) => (
                            <TableRow key={r.repositoryId}>
                                <TableCell>
                                    <span className="flex flex-col gap-0.5">
                                        <span className="font-medium">
                                            {r.name}
                                        </span>
                                        <span className="text-text-tertiary font-mono text-xs">
                                            ws/{r.alias}
                                        </span>
                                    </span>
                                </TableCell>
                                <TableCell>
                                    <Side side={r.base} />
                                </TableCell>
                                <TableCell>
                                    <Side side={r.pr} />
                                </TableCell>
                                <TableCell className="text-text-secondary text-sm">
                                    {r.why}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
            {unpaired && pullRequestBranch && (
                <p className="text-text-tertiary text-xs">
                    If another repository needs a change for this pull request,
                    open it from a branch named{" "}
                    <code className="text-text-primary font-mono">
                        {pullRequestBranch}
                    </code>
                    : with “Pair branches” on for that repository, the next Run
                    boots both pull requests together.
                </p>
            )}
        </Section>
    );
};
