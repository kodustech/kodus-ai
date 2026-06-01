"use client";

import { useMemo, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { Heading } from "@components/ui/heading";
import { Input } from "@components/ui/input";
import { magicModal } from "@components/ui/magic-modal";
import type { KodyRule } from "@services/kodyRules/types";
import { CheckCircle2, FileCode2, XCircle } from "lucide-react";
import { splitRulesByFileMatch } from "src/core/utils/kody-rules/match-file-against-rules";

type TestAgainstFileModalProps = {
    rules: KodyRule[];
};

// "Will any of these rules fire on this file?" — debug helper for the
// quintoandar-style scope leak. The user pastes a repo-relative file
// path and immediately sees which rules would match it (and which ones
// would not). Pure client-side: re-uses the same minimatch options the
// backend pipeline applies.
export const TestAgainstFileModal = ({ rules }: TestAgainstFileModalProps) => {
    const [filePath, setFilePath] = useState("");

    const result = useMemo(() => {
        if (!filePath.trim()) return null;
        return splitRulesByFileMatch(rules, filePath.trim());
    }, [rules, filePath]);

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Test rules against a file path</DialogTitle>
                    <DialogDescription>
                        Paste a repository-relative file path to see which
                        rules would fire on it. Useful to verify rule scoping
                        before opening a PR.
                    </DialogDescription>
                </DialogHeader>

                <Input
                    size="md"
                    type="text"
                    name="file-path"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="applications/sales-flow/src/main/java/.../TaskRepository.java"
                    value={filePath}
                    onChange={(e) => setFilePath(e.target.value)}
                    leftIcon={<FileCode2 aria-hidden />}
                    aria-label="File path to test"
                />

                {result && (
                    <div className="mt-4 flex flex-col gap-4">
                        <section>
                            <div className="mb-2 flex items-center gap-2">
                                <CheckCircle2
                                    aria-hidden
                                    className="text-success size-4"
                                />
                                <Heading variant="h3" className="text-sm">
                                    Matches ({result.matched.length})
                                </Heading>
                            </div>
                            {result.matched.length === 0 ? (
                                <p className="text-text-secondary text-sm">
                                    No rules would fire on this file.
                                </p>
                            ) : (
                                <ul className="flex flex-col gap-1">
                                    {result.matched.map((rule) => (
                                        <li
                                            key={rule.uuid}
                                            className="bg-card-lv2 flex items-center gap-2 rounded-md px-3 py-2 text-sm">
                                            <Badge size="xs" active>
                                                {rule.severity}
                                            </Badge>
                                            <span className="truncate font-medium">
                                                {rule.title}
                                            </span>
                                            <span className="text-text-secondary ml-auto truncate text-xs">
                                                {rule.path}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>

                        <section>
                            <div className="mb-2 flex items-center gap-2">
                                <XCircle
                                    aria-hidden
                                    className="text-text-secondary size-4"
                                />
                                <Heading variant="h3" className="text-sm">
                                    Skipped ({result.unmatched.length})
                                </Heading>
                            </div>
                            {result.unmatched.length === 0 ? (
                                <p className="text-text-secondary text-sm">
                                    Every rule applies to this file.
                                </p>
                            ) : (
                                <details>
                                    <summary className="text-text-secondary cursor-pointer text-sm">
                                        Show {result.unmatched.length} rule
                                        {result.unmatched.length === 1
                                            ? ""
                                            : "s"}{" "}
                                        that would not fire
                                    </summary>
                                    <ul className="mt-2 flex flex-col gap-1">
                                        {result.unmatched.map((rule) => (
                                            <li
                                                key={rule.uuid}
                                                className="bg-card-lv2 flex items-center gap-2 rounded-md px-3 py-2 text-sm opacity-60">
                                                <span className="truncate">
                                                    {rule.title}
                                                </span>
                                                <span className="text-text-secondary ml-auto truncate text-xs">
                                                    {rule.path}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                        </section>
                    </div>
                )}

                <div className="mt-4 flex justify-end">
                    <Button
                        size="md"
                        variant="cancel"
                        onClick={() => magicModal.hide()}>
                        Close
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
};
