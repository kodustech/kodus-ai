"use client";

import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";
import { useCodeReviewConfig } from "src/app/(app)/settings/_components/context";
import { cn } from "src/core/utils/components";

import { ReviewCadenceType } from "../../../_types";

/* Match @variable-name, @variable_name, @variableName */
export const VARIABLE_REGEX = /\@((?:\w(?:[-_]?))+)/g;

const miniTableCellClassName = "h-8 px-3 py-1";

const SimpleCollapsible = (
    props: React.PropsWithChildren & { label: string },
) => (
    <details>
        <summary>{props.label}</summary>
        {props.children}
    </details>
);

const REVIEW_CADENCE_COPY: Record<
    ReviewCadenceType,
    { label: string; description: string }
> = {
    [ReviewCadenceType.AUTOMATIC]: {
        label: "🤖 Automatic Review",
        description: "Kody will automatically review every push to this PR.",
    },
    [ReviewCadenceType.AUTO_PAUSE]: {
        label: "⏸️ Auto-Pause Mode",
        description:
            "Kody reviews the first push automatically, then pauses if you make 3+ pushes in 15 minutes. Use @kody resume to continue.",
    },
    [ReviewCadenceType.MANUAL]: {
        label: "✋ Manual Review",
        description:
            "Kody only reviews when you request with @kody start-review command.",
    },
};

const ReviewCadencePreview = () => {
    const config = useCodeReviewConfig();
    const automationEnabled = config?.automatedReviewActive?.value;
    const cadenceType =
        automationEnabled === false
            ? ReviewCadenceType.MANUAL
            : (config?.reviewCadence?.type?.value ??
              ReviewCadenceType.AUTOMATIC);
    const cadenceCopy =
        REVIEW_CADENCE_COPY[cadenceType] ??
        REVIEW_CADENCE_COPY[ReviewCadenceType.AUTOMATIC];

    return (
        <p className="text-sm">
            <strong>{cadenceCopy.label}</strong>: {cadenceCopy.description}
        </p>
    );
};

export const dropdownItems = {
    reviewOptions: {
        label: "Review options",
        description: "Active review options for the repository",
        example: (
            <SimpleCollapsible label="🔧 Review options">
                <p className="text-text-secondary mb-2">
                    The following review options are enabled or disabled:
                </p>
                <Table className="border-card-lv1 w-80 border">
                    <TableHeader>
                        <TableRow>
                            <TableHead className={miniTableCellClassName}>
                                Options
                            </TableHead>
                            <TableHead className={miniTableCellClassName}>
                                Enabled
                            </TableHead>
                        </TableRow>
                    </TableHeader>

                    <TableBody>
                        <TableRow>
                            <TableCell className={miniTableCellClassName}>
                                Security
                            </TableCell>
                            <TableCell className={miniTableCellClassName}>
                                ✅
                            </TableCell>
                        </TableRow>
                        <TableRow>
                            <TableCell className={miniTableCellClassName}>
                                Code style
                            </TableCell>
                            <TableCell className={miniTableCellClassName}>
                                ❌
                            </TableCell>
                        </TableRow>
                        <TableRow>
                            <TableCell className={miniTableCellClassName}>
                                Refactoring
                            </TableCell>
                            <TableCell className={miniTableCellClassName}>
                                ❌
                            </TableCell>
                        </TableRow>
                        <TableRow>
                            <TableCell className={miniTableCellClassName}>
                                Error handling
                            </TableCell>
                            <TableCell className={miniTableCellClassName}>
                                ✅
                            </TableCell>
                        </TableRow>
                        <TableRow>
                            <TableCell
                                colSpan={2}
                                className={miniTableCellClassName}>
                                and more...
                            </TableCell>
                        </TableRow>
                    </TableBody>
                </Table>
            </SimpleCollapsible>
        ),
    },
    reviewCadence: {
        label: "Review cadence",
        description:
            "Shows how Kody will review this PR (automatic, auto-pause, or manual)",
        example: (
            <SimpleCollapsible label="⏱️ Review cadence">
                <ReviewCadencePreview />
            </SimpleCollapsible>
        ),
    },
    changedFiles: {
        label: "Changed files",
        description: "List of changed files in the PR",
        example: (
            <SimpleCollapsible label="📂 Changed files">
                <Table className="border-card-lv1 mt-2 border">
                    <TableHeader>
                        <TableRow>
                            <TableHead className={miniTableCellClassName}>
                                File
                            </TableHead>
                            <TableHead className={miniTableCellClassName}>
                                Status
                            </TableHead>
                            <TableHead
                                className={cn(
                                    miniTableCellClassName,
                                    "text-center",
                                )}>
                                Additions
                            </TableHead>
                            <TableHead
                                className={cn(
                                    miniTableCellClassName,
                                    "text-center",
                                )}>
                                Deletions
                            </TableHead>
                            <TableHead
                                className={cn(
                                    miniTableCellClassName,
                                    "text-center",
                                )}>
                                Changes
                            </TableHead>
                        </TableRow>
                    </TableHeader>

                    <TableBody>
                        <TableRow>
                            <TableCell className={miniTableCellClassName}>
                                path/to/folder/file1.js
                            </TableCell>
                            <TableCell className={miniTableCellClassName}>
                                Modified
                            </TableCell>
                            <TableCell className={miniTableCellClassName}>
                                10
                            </TableCell>
                            <TableCell className={miniTableCellClassName}>
                                2
                            </TableCell>
                            <TableCell className={miniTableCellClassName}>
                                12
                            </TableCell>
                        </TableRow>

                        <TableRow>
                            <TableCell className={miniTableCellClassName}>
                                path/to/folder/file2.css
                            </TableCell>
                            <TableCell className={miniTableCellClassName}>
                                Added
                            </TableCell>
                            <TableCell className={miniTableCellClassName}>
                                82
                            </TableCell>
                            <TableCell className={miniTableCellClassName}>
                                0
                            </TableCell>
                            <TableCell className={miniTableCellClassName}>
                                82
                            </TableCell>
                        </TableRow>

                        <TableRow>
                            <TableCell
                                colSpan={5}
                                className={miniTableCellClassName}>
                                and more...
                            </TableCell>
                        </TableRow>
                    </TableBody>
                </Table>
            </SimpleCollapsible>
        ),
    },
    changeSummary: {
        label: "Changes summary",
        description: "Message summarizing the changes in the PR",
        example: (
            <SimpleCollapsible label="📊 Changes summary">
                <ul className="mt-2 list-disc pl-5">
                    <li>
                        <strong>Total files:</strong> 3
                    </li>

                    <li>
                        <strong>Total lines added:</strong> 503
                    </li>

                    <li>
                        <strong>Total lines removed:</strong> 0
                    </li>

                    <li>
                        <strong>Total changes:</strong> 503
                    </li>
                </ul>
            </SimpleCollapsible>
        ),
    },
} satisfies Record<
    string,
    {
        label: string;
        description: string;
        example: React.JSX.Element;
    }
>;
