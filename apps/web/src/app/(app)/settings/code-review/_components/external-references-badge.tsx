"use client";

import { Badge } from "@components/ui/badge";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { AlertTriangle, CheckCircle, Clock, XCircle } from "lucide-react";

import type { ExternalReferencesData } from "../[repositoryId]/pr-summary/_components/external-references-display";

interface ExternalReferencesBadgeProps {
    externalReferences?: ExternalReferencesData;
}

export function ExternalReferencesBadge({
    externalReferences,
}: ExternalReferencesBadgeProps) {
    if (!externalReferences) {
        return null;
    }

    const { references, syncErrors, processingStatus } = externalReferences;

    if (references.length === 0 && syncErrors.length === 0) {
        return null;
    }

    const getStatusIcon = (status: string) => {
        switch (status) {
            case "completed":
                return <CheckCircle className="h-3 w-3" />;
            case "processing":
                return <Clock className="h-3 w-3 animate-spin" />;
            case "failed":
                return <XCircle className="h-3 w-3" />;
            default:
                return null;
        }
    };

    const getStatusColor = (status: string) => {
        switch (status) {
            case "completed":
                return "bg-green-500/10 text-green-700 border-green-200";
            case "processing":
                return "bg-blue-500/10 text-blue-700 border-blue-200";
            case "failed":
                return "bg-red-500/10 text-red-700 border-red-200";
            default:
                return "bg-gray-500/10 text-gray-700 border-gray-200";
        }
    };

    if (syncErrors.length > 0) {
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <Badge
                        variant="destructive"
                        className="cursor-pointer gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        {syncErrors.length}
                    </Badge>
                </TooltipTrigger>
                <TooltipContent>
                    <div className="space-y-1 text-xs">
                        <p className="font-semibold">Sync Errors:</p>
                        {syncErrors.slice(0, 3).map((error, idx) => (
                            <p key={idx}>{error}</p>
                        ))}
                        {syncErrors.length > 3 && (
                            <p>+{syncErrors.length - 3} more...</p>
                        )}
                    </div>
                </TooltipContent>
            </Tooltip>
        );
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Badge
                    variant="outline"
                    className={`cursor-pointer gap-1 border ${getStatusColor(processingStatus)}`}>
                    {getStatusIcon(processingStatus)}
                    {references.length}
                </Badge>
            </TooltipTrigger>
            <TooltipContent>
                <div className="space-y-1 text-xs">
                    <p className="font-semibold">
                        {references.length} Reference
                        {references.length > 1 ? "s" : ""}
                    </p>
                    {references.map((ref, idx) => (
                        <p key={idx}>
                            {ref.filePath} ({ref.repositoryName})
                        </p>
                    ))}
                </div>
            </TooltipContent>
        </Tooltip>
    );
}
