"use client";

import React from "react";

import type { ExternalReferencesData } from "../[repositoryId]/pr-summary/_components/external-references-display";

export const useExternalReferencesProcessing = () => {
    const [processingFields, setProcessingFields] = React.useState<Set<string>>(
        new Set(),
    );

    const isProcessing = (fieldName: string) => processingFields.has(fieldName);

    const setProcessing = (fieldName: string, isProcessing: boolean) => {
        setProcessingFields((prev) => {
            const next = new Set(prev);
            if (isProcessing) {
                next.add(fieldName);
            } else {
                next.delete(fieldName);
            }
            return next;
        });
    };

    const isAnyProcessing = processingFields.size > 0;

    return {
        isProcessing,
        setProcessing,
        isAnyProcessing,
    };
};

export const getExternalReferencesTooltip = (
    externalReferences?: ExternalReferencesData,
) => {
    if (!externalReferences || externalReferences.references.length === 0) {
        return null;
    }

    const count = externalReferences.references.length;
    return `${count} reference${count > 1 ? "s" : ""} linked`;
};

export const hasExternalReferences = (
    externalReferences?: ExternalReferencesData,
) => {
    return (
        externalReferences &&
        (externalReferences.references.length > 0 ||
            externalReferences.syncErrors.length > 0)
    );
};

export const isExternalReferencesProcessing = (
    externalReferences?: ExternalReferencesData,
) => {
    return externalReferences?.processingStatus === "processing";
};
