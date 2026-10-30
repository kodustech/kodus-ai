import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { atomDark } from "react-syntax-highlighter/dist/cjs/styles/prism";
import type { ProgrammingLanguage } from "src/core/enums/programming-language";
import type { LiteralUnion } from "src/core/types";
import { cn } from "src/core/utils/components";

export const SyntaxHighlight: React.FC<{
    children: string | undefined;
    className?: string;
    language: LiteralUnion<keyof typeof ProgrammingLanguage>;
    contentStyle?: React.CSSProperties;
    /**
     * Soft-wrap long lines (default). Pass `false` for indentation-sensitive
     * snippets: lines keep their shape and the block scrolls sideways
     * instead of folding a statement onto a new, differently-indented line.
     */
    wrap?: boolean;
}> = (props) => {
    const wrap = props.wrap !== false;
    const customStyle: React.CSSProperties = {
        borderRadius: "0.75rem",
        paddingLeft: "1.5rem",
        paddingRight: "1.5rem",
        paddingTop: "1rem",
        paddingBottom: "1rem",
        ...(wrap ? {} : { overflowX: "auto", tabSize: 4 }),
        ...props.contentStyle,
    };

    const appLanguageToSyntaxHighlighterLanguage = {
        jsts: "typescript",
        python: "python",
        java: "java",
        csharp: "csharp",
        dart: "dart",
        ruby: "ruby",
        go: "go",
        php: "php",
        kotlin: "kotlin",
        rust: "rust",
    } satisfies Record<keyof typeof ProgrammingLanguage, string>;

    const language =
        appLanguageToSyntaxHighlighterLanguage[
            props.language as keyof typeof appLanguageToSyntaxHighlighterLanguage
        ] ?? props.language;

    return (
        <div className={cn("text-sm", props.className)}>
            <SyntaxHighlighter
                style={atomDark}
                language={language}
                customStyle={customStyle}
                codeTagProps={{
                    className: "**:font-mono",
                    style: { whiteSpace: wrap ? "break-spaces" : "pre" },
                }}>
                {props.children?.replace(/\n$/, "") ?? ""}
            </SyntaxHighlighter>
        </div>
    );
};
