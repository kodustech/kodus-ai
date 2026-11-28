import type { RichText } from "@services/runtime/model/rich-text";
import { cn } from "src/core/utils/components";

/** A sentence of the Run screen: plain text with inline code and bold values. */
export const RichTextView = ({
    text,
    codeClassName,
}: {
    text: RichText;
    codeClassName?: string;
}) => (
    <>
        {text.map((part, i) =>
            typeof part === "string" ? (
                <span key={i}>{part}</span>
            ) : "strong" in part ? (
                <strong
                    key={i}
                    className="text-text-primary font-mono font-semibold">
                    {part.strong}
                </strong>
            ) : part.href ? (
                <a
                    key={i}
                    href={part.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-light underline-offset-2 hover:underline">
                    <code className="font-mono text-[0.9em] break-all">
                        {part.code}
                    </code>
                    <span className="sr-only"> (opens in a new tab)</span>
                </a>
            ) : (
                <code
                    key={i}
                    className={cn(
                        "bg-card-lv2 text-text-primary rounded px-1 py-0.5 font-mono text-[0.9em] break-all",
                        codeClassName,
                    )}>
                    {part.code}
                </code>
            ),
        )}
    </>
);
