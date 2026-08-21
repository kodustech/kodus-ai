"use client";

import { useState } from "react";
import { Input } from "@components/ui/input";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

type SecretInputProps = Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "size" | "type"
> & {
    error?: unknown;
};

/**
 * Single-line masked credential input with a show/hide toggle — the right
 * affordance for an API key (a one-line secret). A multi-row textarea both
 * exposes the secret in clear text (shoulder-surfing) and wrongly implies
 * multi-line content. Genuinely multi-line credentials (Vertex SA JSON) keep
 * their textarea; this is for the standard single-line key.
 */
export const SecretInput = ({
    error,
    className,
    ...props
}: SecretInputProps) => {
    const [revealed, setRevealed] = useState(false);

    return (
        <Input
            {...props}
            size="md"
            type={revealed ? "text" : "password"}
            error={error}
            autoComplete="off"
            spellCheck={false}
            className={cn("font-mono", className)}
            rightIcon={
                <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setRevealed((v) => !v)}
                    aria-label={revealed ? "Hide key" : "Show key"}
                    className="text-text-tertiary hover:text-text-primary pointer-events-auto transition-colors">
                    {revealed ? <EyeOffIcon /> : <EyeIcon />}
                </button>
            }
        />
    );
};
