"use client";

import React from "react";
import { Badge } from "@components/ui/badge";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { AlertTriangle, CheckCircle, Clock, Info, XCircle } from "lucide-react";

export interface ExternalReferencesData {
    references: Array<{
        filePath: string;
        repositoryName: string;
        originalText?: string;
        lineRange?: { start: number; end: number } | null;
    }>;
    syncErrors: Array<
        | string
        | {
              fileName?: string;
              message?: string;
              errorType?: string;
              attemptedPaths?: string[];
              timestamp?: string;
          }
    >;
    processingStatus: "completed" | "processing" | "failed" | "pending";
}

export const useHighlightReferences = (
    text: string,
    references: ExternalReferencesData["references"],
) => {
    const getHighlightedParts = React.useMemo(() => {
        if (!text || references.length === 0) {
            return null;
        }

        const allMatches: Array<{
            start: number;
            end: number;
            ref: ExternalReferencesData["references"][0];
        }> = [];

        references.forEach((ref) => {
            const patternText = ref.originalText || ref.filePath;
            const escapedPatternText = patternText.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&",
            );
            const pattern = new RegExp(escapedPatternText, "gi");

            let match;
            while ((match = pattern.exec(text)) !== null) {
                allMatches.push({
                    start: match.index,
                    end: pattern.lastIndex,
                    ref: ref,
                });
            }
        });

        allMatches.sort((a, b) => a.start - b.start);

        const parts = [];
        let lastIndex = 0;

        allMatches.forEach((match) => {
            if (match.start > lastIndex) {
                parts.push({
                    type: "text",
                    content: text.slice(lastIndex, match.start),
                });
            }
            if (match.start >= lastIndex) {
                parts.push({
                    type: "reference",
                    content: text.slice(match.start, match.end),
                    filePath: match.ref.filePath,
                    repositoryName: match.ref.repositoryName,
                });
                lastIndex = match.end;
            }
        });

        if (lastIndex < text.length) {
            parts.push({ type: "text", content: text.slice(lastIndex) });
        }

        return parts.length > 0 ? parts : null;
    }, [text, references]);

    return getHighlightedParts;
};

interface ExternalReferencesDisplayProps {
    externalReferences?: ExternalReferencesData;
    onProcessingChange?: (isProcessing: boolean) => void;
    compact?: boolean;
}

export function ExternalReferencesDisplay({
    externalReferences,
    onProcessingChange,
    compact = false,
}: ExternalReferencesDisplayProps) {
    if (!externalReferences) {
        return null;
    }

    const { references, syncErrors, processingStatus } = externalReferences;

    React.useEffect(() => {
        onProcessingChange?.(
            processingStatus === "processing" || processingStatus === "pending",
        );
    }, [processingStatus, onProcessingChange]);

    const getStatusIcon = (status: string) => {
        switch (status) {
            case "completed":
                return <CheckCircle className="h-3.5 w-3.5 text-green-500" />;
            case "processing":
                return (
                    <Clock className="h-3.5 w-3.5 animate-spin text-blue-500" />
                );
            case "failed":
                return <XCircle className="h-3.5 w-3.5 text-red-500" />;
            case "pending":
                return (
                    <Clock className="h-3.5 w-3.5 animate-spin text-yellow-500" />
                );
            default:
                return <Info className="h-3.5 w-3.5 text-gray-500" />;
        }
    };

    const hasErrors = syncErrors.length > 0;
    const hasReferences = references.length > 0;
    const isProcessingStatus =
        processingStatus === "processing" || processingStatus === "pending";

    if (!hasReferences && !hasErrors && !isProcessingStatus) {
        return null;
    }

    const getErrorMessage = (error: any) => {
        if (typeof error === "string") {
            return error;
        }
        if (error && typeof error === "object") {
            const fileName = error.fileName || "Unknown file";
            const message = error.message || error.details || "Unknown error";
            const errorType = error.errorType ? ` (${error.errorType})` : "";
            return `${fileName}: ${message}${errorType}`;
        }
        return String(error);
    };

    return (
        <div
            className={
                compact
                    ? "mt-1.5 flex flex-col gap-0.5"
                    : "flex flex-wrap items-center gap-1"
            }>
            {isProcessingStatus && !hasReferences && !hasErrors && (
                <div className="text-text-secondary flex items-center gap-1 text-xs">
                    {getStatusIcon(processingStatus)}
                    <span>Processing references...</span>
                </div>
            )}

            {hasReferences && compact ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <div className="text-text-secondary hover:text-text-primary flex cursor-help items-center gap-1 text-xs transition-colors">
                            <CheckCircle className="h-3 w-3 shrink-0 text-green-500" />
                            <span className="truncate">
                                {(() => {
                                    // Compact mode used to inline every
                                    // file path joined by ", ", which on
                                    // a rule with 30+ references blew
                                    // the card height to 3-4× its
                                    // siblings (quintoandar feedback).
                                    // Show a couple of file names as a
                                    // teaser plus the count; the full
                                    // list lives in the tooltip below.
                                    const TEASER = 2;
                                    const teaser = references
                                        .slice(0, TEASER)
                                        .map((r) =>
                                            r.filePath.split("/").pop(),
                                        )
                                        .filter(Boolean)
                                        .join(", ");
                                    const extra =
                                        references.length - TEASER > 0
                                            ? ` +${references.length - TEASER} more`
                                            : "";
                                    return references.length === 1
                                        ? `Found 1 reference: ${teaser}`
                                        : `Found ${references.length} references: ${teaser}${extra}`;
                                })()}
                            </span>
                        </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                        <div className="space-y-1.5">
                            {references.map((ref, idx) => (
                                <div key={idx} className="text-xs">
                                    <p className="font-medium">
                                        {ref.filePath}
                                    </p>
                                    <p className="text-text-secondary">
                                        {ref.repositoryName}
                                    </p>
                                    {ref.lineRange && (
                                        <p className="text-text-secondary text-[10px]">
                                            Lines {ref.lineRange.start}-
                                            {ref.lineRange.end}
                                        </p>
                                    )}
                                </div>
                            ))}
                        </div>
                    </TooltipContent>
                </Tooltip>
            ) : !compact && hasReferences ? (
                <div className="flex items-center gap-1 text-xs">
                    {getStatusIcon(processingStatus)}
                    <div className="flex flex-wrap gap-1">
                        {references.map((ref, idx) => (
                            <Tooltip key={idx}>
                                <TooltipTrigger asChild>
                                    <button
                                        type="button"
                                        className="bg-secondary text-secondary-foreground inline-flex cursor-help items-center rounded-md border px-1.5 py-0 text-xs transition-opacity hover:opacity-80">
                                        {ref.filePath}
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <div className="flex flex-col gap-0.5">
                                        <p className="font-medium">
                                            {ref.filePath}
                                        </p>
                                        <p className="text-text-secondary text-xs">
                                            {ref.repositoryName}
                                        </p>
                                        {ref.lineRange && (
                                            <p className="text-text-secondary text-[10px]">
                                                Lines {ref.lineRange.start}-
                                                {ref.lineRange.end}
                                            </p>
                                        )}
                                    </div>
                                </TooltipContent>
                            </Tooltip>
                        ))}
                    </div>
                </div>
            ) : null}

            {hasErrors && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <div className="text-text-secondary hover:text-text-primary flex cursor-help items-center gap-1 text-xs transition-colors">
                            <AlertTriangle className="h-3 w-3 text-orange-500" />
                            <span>
                                {syncErrors.length} sync error
                                {syncErrors.length > 1 ? "s" : ""}
                            </span>
                        </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-md">
                        <div className="space-y-2">
                            <p className="text-xs font-medium">Sync Errors:</p>
                            {syncErrors.slice(0, 3).map((error, idx) => {
                                const isObject =
                                    typeof error === "object" && error !== null;
                                return (
                                    <div
                                        key={idx}
                                        className="space-y-0.5 text-xs">
                                        <p className="text-text-primary font-medium">
                                            {getErrorMessage(error)}
                                        </p>
                                        {isObject &&
                                            (error as any).attemptedPaths &&
                                            (error as any).attemptedPaths
                                                .length > 0 && (
                                                <p className="text-text-secondary text-[10px]">
                                                    Attempted:{" "}
                                                    {(
                                                        error as any
                                                    ).attemptedPaths.join(", ")}
                                                </p>
                                            )}
                                    </div>
                                );
                            })}
                            {syncErrors.length > 3 && (
                                <p className="text-text-secondary text-xs italic">
                                    +{syncErrors.length - 3} more...
                                </p>
                            )}
                        </div>
                    </TooltipContent>
                </Tooltip>
            )}
        </div>
    );
}
