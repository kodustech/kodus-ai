import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import { getMCPConnections, getMCPPlugins } from "@services/mcp-manager/fetch";
import { MCP_CONNECTION_STATUS } from "@services/mcp-manager/types";
import type { AwaitedReturnType } from "src/core/types";

import { PluginsGrid } from "./_components/plugins-grid";

export default async function PluginsPage() {
    let plugins: AwaitedReturnType<typeof getMCPPlugins> = [];
    let orderedActiveIntegrationIds: string[] = [];
    let hasMCPError = false;
    let mcpErrorMessage = "";

    try {
        const [pluginsResult, connectionsResult] = await Promise.all([
            getMCPPlugins(),
            // Connections come back oldest-first — the same order the
            // backend uses when capping runnable plugins on free plans.
            getMCPConnections().catch(() => null),
        ]);

        plugins = pluginsResult;
        orderedActiveIntegrationIds = (connectionsResult?.items ?? [])
            .filter((c) => c.status === MCP_CONNECTION_STATUS.ACTIVE)
            .map((c) => c.integrationId);
    } catch (error) {
        hasMCPError = true;
        mcpErrorMessage =
            error instanceof Error
                ? error.message
                : "MCP Manager service is not available";
    }

    const sortedPlugins = plugins.sort((a, b) => {
        const aIsComposio = a.provider === "composio";
        const bIsComposio = b.provider === "composio";
        if (aIsComposio !== bIsComposio) return aIsComposio ? 1 : -1;
        return a.name > b.name ? 1 : -1;
    });

    return (
        <Page.Root>
            <Page.Header>
                <Page.TitleContainer>
                    <div className="flex items-center gap-2">
                        <Page.Title>Plugins</Page.Title>
                        <Badge
                            variant="secondary"
                            className="pointer-events-none">
                            Beta
                        </Badge>
                    </div>

                    <Page.Description>
                        Connect Kody to external tools and APIs to enhance your
                        code reviews with real-world context
                    </Page.Description>
                </Page.TitleContainer>
            </Page.Header>

            <Page.Content>
                {hasMCPError ? (
                    <div className="flex flex-col items-center justify-center py-12">
                        <p className="text-center text-gray-600">
                            Could not load plugins
                        </p>
                    </div>
                ) : (
                    <PluginsGrid
                        plugins={sortedPlugins}
                        orderedActiveIntegrationIds={
                            orderedActiveIntegrationIds
                        }
                    />
                )}
                <Card className="flex flex-col items-center justify-center border-2 border-dashed border-gray-300 p-6">
                    <CardHeader className="text-center">
                        <CardTitle className="text-text-primary">
                            Add Custom Plugin
                        </CardTitle>
                        <CardDescription className="text-text-secondary">
                            Create and configure your own plugin.
                        </CardDescription>
                    </CardHeader>
                    <Link href="/settings/plugins/custom">
                        <Button size="lg" variant="primary" className="mt-4">
                            Add Plugin
                        </Button>
                    </Link>
                </Card>
            </Page.Content>
        </Page.Root>
    );
}
