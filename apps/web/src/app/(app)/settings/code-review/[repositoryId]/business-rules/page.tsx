"use client";

import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import { getMCPPlugins } from "@services/mcp-manager/fetch";
import { MCP_CONNECTION_STATUS } from "@services/mcp-manager/types";
import { useGetSkillMeta } from "@services/skills/hooks";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, CheckCircleIcon, PlugIcon } from "lucide-react";

import { CodeReviewPagesBreadcrumb } from "../../_components/breadcrumb";
import { useFeatureFlags } from "../../../_components/context";

const SKILL_NAME = "business-rules-validation";

export default function BusinessRules() {
    const { businessLogic } = useFeatureFlags();
    const { data: meta } = useGetSkillMeta(SKILL_NAME);

    if (businessLogic !== true) {
        return null;
    }

    const { data: plugins = [], isLoading: pluginsLoading } = useQuery({
        queryKey: ["mcp-plugins-business-rules"],
        queryFn: async () => {
            try {
                return await getMCPPlugins();
            } catch {
                return [];
            }
        },
    });

    const hasTaskPlugin = plugins.some(
        (p) =>
            !p.isDefault &&
            p.isConnected &&
            p.connectionStatus === MCP_CONNECTION_STATUS.ACTIVE,
    );

    const requiredMcps = meta?.requiredMcps ?? [];

    return (
        <Page.Root>
            <Page.Header>
                <CodeReviewPagesBreadcrumb pageName="Business Rules" />
            </Page.Header>

            <Page.Header>
                <Page.Title>Business Rules Validation</Page.Title>
            </Page.Header>

            <Page.Content className="gap-6">
                {!pluginsLoading && !hasTaskPlugin && (
                    <Alert variant="warning">
                        <AlertTriangleIcon className="size-4" />
                        <AlertTitle>Task management plugin required</AlertTitle>
                        <AlertDescription className="flex flex-col gap-3">
                            <p>
                                Business Rules Validation needs access to your
                                linked tasks or tickets to check if the
                                implementation matches requirements.
                                {requiredMcps.length > 0 && (
                                    <>
                                        {" "}
                                        Connect a{" "}
                                        <strong>
                                            {requiredMcps[0].label}
                                        </strong>{" "}
                                        plugin
                                        {requiredMcps[0].examples && (
                                            <> ({requiredMcps[0].examples})</>
                                        )}
                                        .
                                    </>
                                )}
                            </p>

                            <Link href="/settings/plugins">
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    leftIcon={<PlugIcon />}>
                                    Connect a plugin
                                </Button>
                            </Link>
                        </AlertDescription>
                    </Alert>
                )}

                {!pluginsLoading && hasTaskPlugin && (
                    <Alert variant="success">
                        <CheckCircleIcon className="size-4" />
                        <AlertTitle>Plugin connected</AlertTitle>
                        <AlertDescription>
                            A task management plugin is connected. Business
                            Rules Validation is ready to use.
                        </AlertDescription>
                    </Alert>
                )}

                <div className="flex flex-col gap-4 rounded-lg border p-6">
                    <div>
                        <h3 className="text-sm font-semibold">
                            {meta?.name ?? "Business Rules Validation"}
                        </h3>
                        {meta?.description && (
                            <p className="text-text-secondary mt-1 text-sm">
                                {meta.description}
                            </p>
                        )}
                    </div>

                    <div className="flex flex-col gap-2">
                        <p className="text-text-secondary text-sm">
                            Kody analyses the PR diff against the linked task's
                            acceptance criteria and business rules, then posts a
                            structured gap report as a PR comment.
                        </p>

                        <p className="text-text-secondary text-sm">
                            Trigger it automatically on every PR review, or
                            on-demand by commenting{" "}
                            <code className="bg-card-lv2 rounded px-1 py-0.5 font-mono text-xs">
                                @kody -v business-logic
                            </code>{" "}
                            in the main PR conversation.
                        </p>
                    </div>

                    {meta?.version && (
                        <p className="text-text-secondary text-xs">
                            Version {meta.version}
                        </p>
                    )}
                </div>
            </Page.Content>
        </Page.Root>
    );
}
