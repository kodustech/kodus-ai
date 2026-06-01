import { Avatar, AvatarImage } from "@components/ui/avatar";
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
import { getMCPPlugins } from "@services/mcp-manager/fetch";
import { MCP_CONNECTION_STATUS } from "@services/mcp-manager/types";
import { CheckIcon, ImageOff } from "lucide-react";
import type { AwaitedReturnType } from "src/core/types";

export default async function PluginsPage() {
    let plugins: AwaitedReturnType<typeof getMCPPlugins> = [];
    let hasMCPError = false;
    let mcpErrorMessage = "";

    try {
        plugins = await getMCPPlugins();
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

    console.log(sortedPlugins);

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
                    <div className="grid grid-cols-2 gap-2">
                        {sortedPlugins.map((item) => (
                            <Link
                                key={item.id}
                                className="w-full"
                                href={`/settings/plugins/${item.provider}/${item.id}`}>
                                <Button
                                    size="lg"
                                    decorative
                                    variant="helper"
                                    className="h-full w-full items-start gap-0 px-0 py-0">
                                    <Card className="flex w-full gap-0 bg-transparent shadow-none">
                                        <CardHeader className="gap-4">
                                            <div className="flex h-fit flex-row items-center gap-5">
                                                <Avatar className="bg-card-lv3 group-disabled/link:bg-card-lv3/50 size-10 rounded-lg p-1">
                                                    {item.logo ? (
                                                        <AvatarImage
                                                            src={item.logo}
                                                            alt={`${item.appName} logo`}
                                                            className="object-contain"
                                                        />
                                                    ) : (
                                                        <ImageOff className="text-text-tertiary m-auto h-6 w-6" />
                                                    )}
                                                </Avatar>

                                                <div className="flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <CardTitle className="text-text-primary capitalize">
                                                            {item.appName}
                                                        </CardTitle>
                                                        {item.provider ===
                                                            "composio" && (
                                                            <Badge className="bg-red-500/10 text-red-500 border-red-500/20 pointer-events-none text-[10px]">
                                                                Deprecated
                                                            </Badge>
                                                        )}
                                                    </div>

                                                    <span className="text-text-tertiary text-xs">
                                                        @{item.provider}
                                                    </span>
                                                </div>

                                                {item.isConnected &&
                                                    item.connectionStatus ===
                                                        MCP_CONNECTION_STATUS.ACTIVE && (
                                                        <Badge
                                                            variant="tertiary"
                                                            leftIcon={
                                                                <CheckIcon />
                                                            }
                                                            className="bg-success! text-card-lv2! pointer-events-none">
                                                            {item.isDefault
                                                                ? "Default"
                                                                : "Installed"}
                                                        </Badge>
                                                    )}
                                            </div>

                                            {item.description && (
                                                <CardDescription className="text-sm">
                                                    {item.description}
                                                </CardDescription>
                                            )}
                                        </CardHeader>
                                    </Card>
                                </Button>
                            </Link>
                        ))}
                    </div>
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
