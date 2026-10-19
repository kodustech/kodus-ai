"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Input } from "@components/ui/input";
import { prepareAgentsForSave } from "@services/custom-agents/drafts";
import { useTryCustomAgent } from "@services/custom-agents/hooks";
import type {
    CustomAgent,
    CustomAgentTryFinding,
    CustomAgentTryTrace,
    KnowledgeItem,
} from "@services/custom-agents/types";
import {
    CircleAlertIcon,
    CircleCheckIcon,
    CircleSlashIcon,
    CircleXIcon,
} from "lucide-react";

import { Chip } from "./field";

const errorMessage = (error: unknown) => {
    const message =
        (error as { response?: { data?: { message?: unknown } } })?.response
            ?.data?.message ?? (error as Error)?.message;
    if (Array.isArray(message)) return message.join(" · ");
    return typeof message === "string" && message
        ? message
        : "Couldn't run the agent. Try again.";
};

/**
 * Runs the agent on screen, saved or not, on one pull request. Nothing is
 * posted or stored; the result shows what it read and what it would post.
 */
export const TryIt = ({
    teamId,
    repositoryId,
    directoryId,
    agent,
    knowledge,
    canEdit,
}: {
    teamId: string;
    repositoryId: string;
    /** Set at a directory: its stored secrets are the ones a run can use. */
    directoryId?: string;
    agent: CustomAgent;
    knowledge: KnowledgeItem[];
    canEdit: boolean;
}) => {
    const [prUrl, setPrUrl] = useState("");
    // The agent as it was when the run started: a result stays on screen
    // after an edit or a reset, and must say it no longer matches.
    const [ranWith, setRanWith] = useState<string | null>(null);
    const run = useTryCustomAgent();
    const canRun = canEdit && !!prUrl.trim();
    const onScreen = JSON.stringify({
        agent: prepareAgentsForSave([agent])[0],
        knowledge,
    });
    const start = () => {
        run.reset();
        setRanWith(onScreen);
        run.mutate({
            teamId,
            repositoryId,
            directoryId,
            prUrl: prUrl.trim(),
            agent: prepareAgentsForSave([agent])[0],
            knowledge,
        });
    };
    const isStale = ranWith !== null && ranWith !== onScreen;

    return (
        <Card
            id="try-it"
            color="lv1"
            role="region"
            aria-labelledby="try-it-title"
            className="flex scroll-mt-24 flex-col gap-3 px-5 py-4">
            <span className="flex flex-col">
                <span
                    id="try-it-title"
                    className="text-text-primary text-sm font-medium">
                    Try it
                </span>
                <span className="text-text-secondary text-xs">
                    Runs the agent as it is on screen, saved or not, on one pull
                    request of this repository. Nothing is posted.
                </span>
            </span>
            {repositoryId === "global" ? (
                <p className="text-text-secondary text-xs">
                    Open a repository&apos;s settings to try the agent on one of
                    its pull requests.
                </p>
            ) : (
                <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                        <Input
                            size="md"
                            aria-label="Pull request link"
                            placeholder="Pull request link"
                            value={prUrl}
                            onChange={(e) => setPrUrl(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && canRun) start();
                            }}
                        />
                    </div>
                    <Button
                        size="md"
                        variant="secondary"
                        disabled={!canRun}
                        loading={run.isPending}
                        onClick={start}>
                        Run agent
                    </Button>
                </div>
            )}
            {!canEdit && (
                <p className="text-text-secondary text-xs">
                    Trying an agent needs permission to edit these settings.
                </p>
            )}
            {run.isPending && (
                <p className="text-text-secondary text-sm">
                    Reviewing the pull request. This takes a few minutes on a
                    large change.
                </p>
            )}
            {run.isError && (
                <p className="text-danger text-sm">{errorMessage(run.error)}</p>
            )}
            {run.data && !run.isPending && isStale && (
                <p className="text-warning text-xs">
                    This result is from an earlier version of the agent. Run it
                    again to see what the agent on screen does.
                </p>
            )}
            {run.data && !run.isPending && <TryResult trace={run.data} />}
        </Card>
    );
};

/** Said when a warning carries no detail of its own. */
const WARNING_LABEL: Record<string, string> = {
    SANDBOX_UNAVAILABLE:
        "The repository could not be checked out, so the agent read only the diff",
    CLI_INSTALL_FAILED:
        "A CLI could not be installed; the agent ran without it",
    AST_GREP_UNAVAILABLE:
        "ast-grep is not installed in the sandbox; the agent ran without it",
};

const VERDICT_ICON = {
    kept: <CircleCheckIcon className="text-success size-4 shrink-0" />,
    dropped: <CircleXIcon className="text-text-tertiary size-4 shrink-0" />,
    unverified: <CircleAlertIcon className="text-warning size-4 shrink-0" />,
};

const FindingRow = ({ finding }: { finding: CustomAgentTryFinding }) => (
    <div className="border-card-lv3/60 flex flex-col gap-1.5 border-t pt-3 first:border-t-0 first:pt-0">
        <div className="flex items-start gap-2">
            {VERDICT_ICON[finding.verdict]}
            <div className="flex min-w-0 flex-col gap-1">
                <span className="text-text-primary text-sm">
                    {finding.summary}
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-text-tertiary font-mono text-xs">
                        {finding.file}
                        {finding.lineStart ? `:${finding.lineStart}` : ""}
                    </span>
                    {finding.severity && <Chip>{finding.severity}</Chip>}
                    {finding.kind && <Chip>{finding.kind}</Chip>}
                    <Chip
                        tone={
                            finding.verdict === "kept"
                                ? "neutral"
                                : finding.verdict === "dropped"
                                  ? "danger"
                                  : "warning"
                        }>
                        {finding.verdict}
                    </Chip>
                    {finding.verdict === "kept" && (
                        <Chip tone={finding.wouldPost ? "neutral" : "warning"}>
                            {finding.wouldPost
                                ? "would post"
                                : "kept, not posted"}
                        </Chip>
                    )}
                </span>
                {finding.reason && (
                    <span className="text-text-secondary text-xs">
                        {finding.reason}
                    </span>
                )}
                {finding.source && (
                    <blockquote className="border-card-lv3 text-text-secondary border-l-2 pl-2 text-xs">
                        “{finding.source.quote}” · {finding.source.file}
                        {finding.source.section
                            ? ` › ${finding.source.section}`
                            : ""}
                    </blockquote>
                )}
                {(finding.comment ?? finding.body) && (
                    <details>
                        <summary className="text-text-secondary cursor-pointer text-xs">
                            {finding.comment ? "Comment" : "What it said"}
                        </summary>
                        <pre className="text-text-secondary bg-card-lv2 mt-1 max-h-64 overflow-auto rounded-lg px-3 py-2 text-xs whitespace-pre-wrap">
                            {finding.comment ?? finding.body}
                        </pre>
                    </details>
                )}
            </div>
        </div>
    </div>
);

export const TryResult = ({ trace }: { trace: CustomAgentTryTrace }) => {
    const kept = trace.findings.filter((finding) => finding.verdict === "kept");
    const wouldPost = kept.filter((finding) => finding.wouldPost).length;

    return (
        <Card color="lv1" className="flex flex-col gap-4 px-5 py-4 text-sm">
            <span className="text-text-primary flex items-center gap-2 font-medium">
                {trace.status === "completed" ? (
                    <CircleCheckIcon className="text-success size-4" />
                ) : trace.status === "skipped" ? (
                    <CircleSlashIcon className="text-text-tertiary size-4" />
                ) : (
                    <CircleXIcon className="text-danger size-4" />
                )}
                {trace.status === "completed"
                    ? `${trace.findings.length} findings · ${kept.length} kept · ${wouldPost} would post`
                    : trace.status === "skipped"
                      ? `Skipped${trace.reason ? ` · ${trace.reason}` : ""}`
                      : `Failed${trace.reason ? ` · ${trace.reason}` : ""}`}
            </span>
            <span className="text-text-secondary flex flex-wrap gap-x-3 text-xs">
                {trace.models?.run && <span>Model: {trace.models.run}</span>}
                {typeof trace.durationMs === "number" && (
                    <span>{Math.round(trace.durationMs / 1000)} s</span>
                )}
            </span>

            {!!trace.warnings?.length && (
                <div className="flex flex-col gap-1">
                    <span className="text-text-primary text-xs font-medium">
                        Warnings
                    </span>
                    {trace.warnings.map((warning, index) => (
                        <span
                            key={index}
                            className="text-text-secondary flex items-start gap-1.5 text-xs">
                            <CircleAlertIcon className="text-warning mt-px size-3.5 shrink-0" />
                            {warning.detail ??
                                WARNING_LABEL[warning.kind] ??
                                warning.kind}
                        </span>
                    ))}
                </div>
            )}

            {trace.skillsOpened.length > 0 && (
                <div className="flex flex-col gap-1">
                    <span className="text-text-primary text-xs font-medium">
                        Skills opened
                    </span>
                    {trace.skillsOpened.map((skill) => (
                        <span
                            key={skill.path}
                            className="text-text-secondary font-mono text-xs">
                            {skill.path}
                            {skill.files?.length
                                ? ` (+ ${skill.files.join(", ")})`
                                : ""}
                        </span>
                    ))}
                </div>
            )}

            {trace.toolCalls.length > 0 && (
                <details className="flex flex-col gap-1">
                    <summary className="text-text-primary cursor-pointer text-xs font-medium">
                        {trace.toolCalls.length} tool calls
                    </summary>
                    <div className="mt-2 flex flex-col gap-2">
                        {trace.toolCalls.map((call, index) => (
                            <div
                                key={index}
                                className="bg-card-lv2 flex flex-col gap-1 rounded-lg px-3 py-2">
                                <span className="text-text-primary font-mono text-xs">
                                    {call.tool}
                                    {call.input ? ` ${call.input}` : ""}
                                </span>
                                {call.error ? (
                                    <span className="text-danger text-xs">
                                        {call.error}
                                    </span>
                                ) : (
                                    call.outputPreview && (
                                        <pre className="text-text-secondary max-h-32 overflow-auto text-xs whitespace-pre-wrap">
                                            {call.outputPreview}
                                        </pre>
                                    )
                                )}
                            </div>
                        ))}
                    </div>
                </details>
            )}

            {trace.findings.length > 0 && (
                <div className="flex flex-col gap-3">
                    {trace.findings.map((finding, index) => (
                        <FindingRow key={index} finding={finding} />
                    ))}
                </div>
            )}
        </Card>
    );
};
