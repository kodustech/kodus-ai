import { cn } from "src/core/utils/components";

import { providerAvatarTint, providerLetter } from "../_utils";

/**
 * A colored single-letter badge encoding a model's provider (Anthropic = pink A,
 * Google = violet G, Moonshot/Kimi = purple K, …). Shared by the per-agent model
 * controls and the read-only per-repository table so a user recognizes "which
 * provider" at a glance and the two panels read as one system.
 */
export const ProviderAvatar = ({
    provider,
    size = "sm",
    className,
}: {
    provider?: string;
    size?: "sm" | "md";
    className?: string;
}) => (
    <span
        aria-hidden
        className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-md font-semibold",
            size === "sm" ? "size-5 text-[0.625rem]" : "size-6 text-xs",
            providerAvatarTint(provider),
            className,
        )}>
        {providerLetter(provider)}
    </span>
);
