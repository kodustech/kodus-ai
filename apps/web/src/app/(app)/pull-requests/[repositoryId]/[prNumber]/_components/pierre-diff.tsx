"use client";

import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";

interface PierreDiffProps {
    oldCode: string;
    newCode: string;
    fileName: string;
    diffStyle?: "split" | "unified";
}

export default function PierreDiff({
    oldCode,
    newCode,
    fileName,
    diffStyle = "split",
}: PierreDiffProps) {
    if (!oldCode && !newCode) return null;

    return (
        <div className="pierre-diff-container overflow-x-auto p-2">
            <MultiFileDiff
                oldFile={{ name: fileName, contents: oldCode }}
                newFile={{ name: fileName, contents: newCode }}
                options={{
                    theme: "pierre-dark",
                    diffStyle,
                    overflow: "scroll",
                }}
            />
        </div>
    );
}

interface PierrePatchDiffProps {
    patch: string;
    filename: string;
    previousFilename?: string;
    diffStyle?: "split" | "unified";
}

export function PierrePatchDiffComponent({
    patch,
    filename,
    previousFilename,
    diffStyle = "split",
}: PierrePatchDiffProps) {
    if (!patch) return null;

    // GitHub's API returns only hunk content (starting with @@) without
    // the unified diff headers. PatchDiff requires either git diff headers
    // or standard unified diff headers to parse correctly.
    const prev = previousFilename ?? filename;
    const isNewFile = patch.startsWith("@@ -0,0");
    const isDeletedFile = /^@@ -\d+,\d+ \+0,0 @@/.test(patch);
    const fromPath = isNewFile ? "/dev/null" : `a/${prev}`;
    const toPath = isDeletedFile ? "/dev/null" : `b/${filename}`;
    const fullPatch = `diff --git a/${prev} b/${filename}\n--- ${fromPath}\n+++ ${toPath}\n${patch}`;

    return (
        <div className="pierre-diff-container overflow-x-auto">
            <PatchDiff
                patch={fullPatch}
                options={{
                    theme: "pierre-dark",
                    diffStyle,
                    overflow: "scroll",
                }}
            />
        </div>
    );
}
