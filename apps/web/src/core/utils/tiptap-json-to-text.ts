/**
 * Backend utility: Converts Tiptap JSON content to plain text string.
 *
 * This is a pure TypeScript/JavaScript function with NO dependencies.
 * Can be copied to your backend codebase.
 *
 * Preserves MCP mentions as @mcp<app|tool> tokens in the output.
 *
 * @param content - Tiptap JSON object or JSON string, or plain string
 * @returns Plain text string with mentions converted to tokens
 *
 * @example
 * // Input: Tiptap JSON object or JSON string
 * const tiptapJson = {
 *   type: "doc",
 *   content: [
 *     {
 *       type: "paragraph",
 *       content: [
 *         { type: "text", text: "Hello " },
 *         { type: "mcpMention", attrs: { app: "kodus", tool: "kodus_list_commits" } },
 *         { type: "text", text: " world" }
 *       ]
 *     }
 *   ]
 * };
 *
 * // Output: "Hello @mcp<kodus|kodus_list_commits> world"
 * convertTiptapJSONToText(tiptapJson);
 */
// Same markdown syntax convertTiptapJSONToMarkdown uses for these marks, so
// the plain-text ("saveFormat=text") round-trip and the markdown export stay
// consistent. Applied innermost-first (marks reversed) to nest correctly,
// e.g. bold+italic -> **_text_**.
function applyInlineMarksAsMarkdown(text: string, marks?: any[]): string {
    if (!marks?.length) return text;

    return [...marks].reverse().reduce((acc, mark) => {
        switch (mark.type) {
            case "bold":
                return `**${acc}**`;
            case "italic":
                return `*${acc}*`;
            case "code":
                return `\`${acc}\``;
            case "strike":
                return `~~${acc}~~`;
            case "link": {
                const href = mark.attrs?.href || "";
                return `[${acc}](${href})`;
            }
            default:
                return acc;
        }
    }, text);
}

export function convertTiptapJSONToText(
    content: string | object | null | undefined,
): string {
    // Handle null/undefined
    if (!content) return "";

    // If it's already a plain string (not JSON), return as-is
    if (typeof content === "string") {
        // Check if it's a JSON string
        if (content.startsWith("{") && content.trim().startsWith("{")) {
            try {
                const parsed = JSON.parse(content);
                return convertTiptapJSONToText(parsed);
            } catch {
                // If JSON.parse fails, it's not valid JSON, return as plain string
                return content;
            }
        }
        return content;
    }

    // If it's an object (Tiptap JSON), traverse and extract text
    if (typeof content === "object" && content !== null) {
        try {
            let text = "";

            function traverse(node: any, listMarker?: string): void {
                if (!node || typeof node !== "object") return;

                if (node.type === "text") {
                    text += applyInlineMarksAsMarkdown(
                        node.text || "",
                        node.marks,
                    );
                    return;
                }
                if (node.type === "mcpMention") {
                    // Convert mention node to token format
                    const app = node.attrs?.app || "";
                    const tool = node.attrs?.tool || "";
                    text += `@mcp<${app}|${tool}>`;
                    return;
                }
                if (node.type === "hardBreak") {
                    text += "\n";
                    return;
                }
                if (node.type === "heading") {
                    const level = Math.min(
                        Math.max(node.attrs?.level || 1, 1),
                        6,
                    );
                    text += "#".repeat(level) + " ";
                    (node.content ?? []).forEach((c: any) => traverse(c));
                    text += "\n";
                    return;
                }
                if (node.type === "bulletList") {
                    (node.content ?? []).forEach((item: any) =>
                        traverse(item, "- "),
                    );
                    return;
                }
                if (node.type === "orderedList") {
                    let index = node.attrs?.start || 1;
                    (node.content ?? []).forEach((item: any) => {
                        traverse(item, `${index}. `);
                        index++;
                    });
                    return;
                }
                if (node.type === "listItem") {
                    text += listMarker ?? "- ";
                    // A list item's content is one or more paragraphs — flatten
                    // the first one inline instead of letting the generic
                    // paragraph handler insert its own line break before the
                    // list marker is even on the line.
                    (node.content ?? []).forEach((c: any) => {
                        if (c.type === "paragraph") {
                            (c.content ?? []).forEach((inline: any) =>
                                traverse(inline),
                            );
                        } else {
                            traverse(c);
                        }
                    });
                    text += "\n";
                    return;
                }
                if (node.content && Array.isArray(node.content)) {
                    // Recursively traverse child nodes
                    node.content.forEach((c: any) => traverse(c));
                }
                if (node.type === "paragraph") {
                    // Block boundary: separate this paragraph from the next
                    text += "\n";
                }
            }

            traverse(content);
            return text.replace(/\n$/, "");
        } catch {
            return "";
        }
    }

    return "";
}

/**
 * Converts Tiptap JSON content to Markdown format.
 *
 * Preserves formatting (bold, italic, headings, lists, code blocks, etc.) and MCP mentions.
 * This is useful when sending formatted content to LLMs that understand Markdown.
 *
 * @param content - Tiptap JSON object or JSON string
 * @returns Markdown string with formatting preserved
 *
 * @example
 * // Input: Tiptap JSON with bold text
 * const tiptapJson = {
 *   type: "doc",
 *   content: [
 *     {
 *       type: "paragraph",
 *       content: [
 *         { type: "text", text: "Hello ", marks: [] },
 *         { type: "text", text: "world", marks: [{ type: "bold" }] }
 *       ]
 *     }
 *   ]
 * };
 *
 * // Output: "Hello **world**"
 * convertTiptapJSONToMarkdown(tiptapJson);
 */
export function convertTiptapJSONToMarkdown(
    content: string | object | null | undefined,
): string {
    if (!content) return "";

    // Parse JSON string if needed
    if (typeof content === "string") {
        if (content.startsWith("{") && content.trim().startsWith("{")) {
            try {
                const parsed = JSON.parse(content);
                return convertTiptapJSONToMarkdown(parsed);
            } catch {
                return content;
            }
        }
        return content;
    }

    if (typeof content === "object" && content !== null) {
        try {
            let markdown = "";
            let listContext:
                | {
                      inList?: boolean;
                      listType?: "bullet" | "ordered";
                      listIndex?: number;
                  }
                | undefined;

            function traverse(node: any, context?: typeof listContext): void {
                if (!node || typeof node !== "object") return;

                const nodeType = node.type;

                // Handle text nodes with marks
                if (nodeType === "text") {
                    let text = node.text || "";

                    // Apply marks (bold, italic, code, etc.)
                    if (node.marks && Array.isArray(node.marks)) {
                        // Process marks in reverse order (innermost first)
                        const marks = [...node.marks].reverse();
                        for (const mark of marks) {
                            switch (mark.type) {
                                case "bold":
                                    text = `**${text}**`;
                                    break;
                                case "italic":
                                    text = `*${text}*`;
                                    break;
                                case "code":
                                    text = `\`${text}\``;
                                    break;
                                case "strike":
                                    text = `~~${text}~~`;
                                    break;
                                case "link":
                                    const href = mark.attrs?.href || "";
                                    text = `[${text}](${href})`;
                                    break;
                            }
                        }
                    }

                    markdown += text;
                    return;
                }

                // Handle MCP mentions
                if (nodeType === "mcpMention") {
                    const app = node.attrs?.app || "";
                    const tool = node.attrs?.tool || "";
                    markdown += `@mcp<${app}|${tool}>`;
                    return;
                }

                // Handle headings
                if (nodeType === "heading") {
                    const level = node.attrs?.level || 1;
                    const prefix = "#".repeat(level) + " ";

                    if (node.content && Array.isArray(node.content)) {
                        const beforeLength = markdown.length;
                        node.content.forEach((child: any) =>
                            traverse(child, context),
                        );

                        // Add heading prefix
                        if (markdown.length > beforeLength) {
                            const headingContent =
                                markdown.substring(beforeLength);
                            markdown =
                                markdown.substring(0, beforeLength) +
                                prefix +
                                headingContent;
                        }
                    }
                    markdown += "\n\n";
                    return;
                }

                // Handle paragraphs
                if (nodeType === "paragraph") {
                    if (node.content && Array.isArray(node.content)) {
                        const beforeLength = markdown.length;
                        node.content.forEach((child: any) =>
                            traverse(child, context),
                        );

                        // Add newline after paragraph if it's not in a list
                        if (
                            !context?.inList &&
                            markdown.length > beforeLength
                        ) {
                            markdown += "\n\n";
                        }
                    } else {
                        // Empty paragraph
                        if (!context?.inList) {
                            markdown += "\n\n";
                        }
                    }
                    return;
                }

                // Handle bullet lists
                if (nodeType === "bulletList") {
                    if (node.content && Array.isArray(node.content)) {
                        node.content.forEach((child: any) => {
                            traverse(child, {
                                ...context,
                                inList: true,
                                listType: "bullet",
                            });
                        });
                    }
                    if (!context?.inList) {
                        markdown += "\n";
                    }
                    return;
                }

                // Handle ordered lists
                if (nodeType === "orderedList") {
                    if (node.content && Array.isArray(node.content)) {
                        let index = node.attrs?.start || 1;
                        node.content.forEach((child: any) => {
                            traverse(child, {
                                ...context,
                                inList: true,
                                listType: "ordered",
                                listIndex: index,
                            });
                            index++;
                        });
                    }
                    if (!context?.inList) {
                        markdown += "\n";
                    }
                    return;
                }

                // Handle list items
                if (nodeType === "listItem") {
                    const prefix =
                        context?.listType === "ordered"
                            ? `${context.listIndex}. `
                            : "- ";

                    markdown += prefix;

                    if (node.content && Array.isArray(node.content)) {
                        const beforeLength = markdown.length;
                        node.content.forEach((child: any) =>
                            traverse(child, context),
                        );

                        // Ensure list item ends with newline
                        if (markdown.length > beforeLength) {
                            markdown += "\n";
                        }
                    }
                    return;
                }

                // Handle blockquotes
                if (nodeType === "blockquote") {
                    if (node.content && Array.isArray(node.content)) {
                        const beforeLength = markdown.length;
                        node.content.forEach((child: any) =>
                            traverse(child, context),
                        );

                        // Add > prefix to each line
                        if (markdown.length > beforeLength) {
                            const quoteContent =
                                markdown.substring(beforeLength);
                            const lines = quoteContent.split("\n");
                            const quotedLines = lines
                                .filter((l) => l.trim())
                                .map((line) => `> ${line}`)
                                .join("\n");
                            markdown =
                                markdown.substring(0, beforeLength) +
                                quotedLines;
                        }
                    }
                    markdown += "\n\n";
                    return;
                }

                // Handle code blocks
                if (nodeType === "codeBlock") {
                    const language = node.attrs?.language || "";
                    markdown += "```" + language + "\n";

                    if (node.content && Array.isArray(node.content)) {
                        node.content.forEach((child: any) => {
                            if (child.type === "text") {
                                markdown += child.text || "";
                            }
                        });
                    }

                    markdown += "\n```\n\n";
                    return;
                }

                // Handle horizontal rule
                if (nodeType === "horizontalRule") {
                    markdown += "---\n\n";
                    return;
                }

                // Handle any other node types by traversing their content
                if (node.content && Array.isArray(node.content)) {
                    node.content.forEach((child: any) =>
                        traverse(child, context),
                    );
                }
            }

            traverse(content);

            // Clean up extra newlines
            return markdown.replace(/\n{3,}/g, "\n\n").trim();
        } catch (error) {
            console.error("Error converting Tiptap JSON to Markdown:", error);
            return "";
        }
    }

    return "";
}
