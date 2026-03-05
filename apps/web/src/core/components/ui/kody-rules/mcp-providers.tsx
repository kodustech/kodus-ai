import type { ComponentProps, SVGProps } from "react";
import { Badge } from "@components/ui/badge";
import { Heading } from "@components/ui/heading";
import {
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
} from "@components/ui/hover-card";
import { SvgAsana } from "@components/ui/icons/SvgAsana";
import { SvgDatadog } from "@components/ui/icons/SvgDatadog";
import { SvgExa } from "@components/ui/icons/SvgExa";
import { SvgGithub } from "@components/ui/icons/SvgGithub";
import { SvgGrafana } from "@components/ui/icons/SvgGrafana";
import { SvgJira } from "@components/ui/icons/SvgJira";
import { SvgLinear } from "@components/ui/icons/SvgLinear";
import { SvgPerplexity } from "@components/ui/icons/SvgPerplexity";
import { SvgSentry } from "@components/ui/icons/SvgSentry";
import { SvgSlack } from "@components/ui/icons/SvgSlack";
import { cn } from "src/core/utils/components";

const normalizeProviderKey = (value: string) =>
    value.trim().toLowerCase().replace(/\s+/g, "");

const getProviderInitials = (value: string) => {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
};

const PROVIDER_ICON_MAP: Record<
    string,
    (props: SVGProps<SVGSVGElement>) => React.JSX.Element
> = {
    "slack": SvgSlack,
    "jira": SvgJira,
    "datadog": SvgDatadog,
    "linear": SvgLinear,
    "asana": SvgAsana,
    "grafana": SvgGrafana,
    "perplexity": SvgPerplexity,
    "exa": SvgExa,
    "github": SvgGithub,
    "sentry": SvgSentry,
    "sentryio": SvgSentry,
    "sentry.io": SvgSentry,
};

const McpProviderLogo = ({
    provider,
    size = "md",
}: {
    provider: string;
    size?: "sm" | "md";
}) => {
    const key = normalizeProviderKey(provider);
    const Icon = PROVIDER_ICON_MAP[key];

    const sizeClasses = size === "sm" ? "size-4" : "size-6";
    const iconClasses = size === "sm" ? "size-2.5" : "size-4";
    const textClasses = size === "sm" ? "text-[8px]" : "text-[10px]";

    return (
        <span
            className={cn(
                "bg-card-lv3 border-card-lv3 flex items-center justify-center rounded-full border",
                sizeClasses,
            )}>
            {Icon ? (
                <Icon className={iconClasses} />
            ) : (
                <span
                    className={cn(
                        "text-text-secondary font-semibold",
                        textClasses,
                    )}>
                    {getProviderInitials(provider)}
                </span>
            )}
        </span>
    );
};

export const McpProvidersBadge = ({
    providers,
    maxVisible = 3,
    badgeVariant = "secondary",
    className,
    hoverTitle = "Required Plugins",
    hoverDescription,
}: {
    providers?: string[];
    maxVisible?: number;
    badgeVariant?: ComponentProps<typeof Badge>["variant"];
    className?: string;
    hoverTitle?: string;
    hoverDescription?: string;
}) => {
    const normalizedProviders = Array.isArray(providers)
        ? providers.filter(Boolean)
        : [];

    if (normalizedProviders.length === 0) return null;

    const visibleProviders = normalizedProviders.slice(0, maxVisible);
    const remaining = normalizedProviders.length - visibleProviders.length;

    return (
        <HoverCard openDelay={150}>
            <HoverCardTrigger asChild>
                <Badge
                    variant={badgeVariant}
                    className={cn(
                        "h-5 cursor-default gap-1.5 px-2 font-normal",
                        className,
                    )}>
                    <div className="flex -space-x-1">
                        {visibleProviders.map((provider) => (
                            <McpProviderLogo
                                key={provider}
                                provider={provider}
                                size="sm"
                            />
                        ))}
                        {remaining > 0 && (
                            <span className="bg-card-lv2 text-text-secondary flex size-4 items-center justify-center rounded-full text-[8px] font-semibold">
                                +{remaining}
                            </span>
                        )}
                    </div>
                    <span className="text-xs">Requires Plugin</span>
                </Badge>
            </HoverCardTrigger>
            <HoverCardContent className="w-64">
                <div className="space-y-3">
                    <div className="space-y-1">
                        <Heading variant="h3">{hoverTitle}</Heading>
                        <p className="text-text-secondary text-sm">
                            {hoverDescription ??
                                "This rule requires one of the following plugins:"}
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {normalizedProviders.map((provider) => (
                            <div
                                key={provider}
                                className="bg-card-lv3 flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1.5">
                                <McpProviderLogo
                                    provider={provider}
                                    size="sm"
                                />
                                <span className="text-text-primary text-xs font-medium">
                                    {provider}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            </HoverCardContent>
        </HoverCard>
    );
};
