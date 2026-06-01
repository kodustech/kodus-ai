"use client";

import * as React from "react";
import Placeholder from "@tiptap/extension-placeholder";
import { Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { cn } from "src/core/utils/components";

import { CodeBlock } from "./code-block-extension";
import { MCPMention } from "./mcp-mention-extension";
import { MentionTrigger } from "./mention-trigger-extension";
import { RichTextEditorSearch } from "./rich-text-editor-search";
import { RichTextEditorToolbar } from "./rich-text-editor-toolbar";
import { SearchReplace } from "./search-replace-extension";

type RichTextEditorProps = {
    value: string | object;
    onChangeAction: (next: string | object) => void;
    className?: string;
    placeholder?: string;
    disabled?: boolean;
    maxLength?: number;
    enableMentions?: boolean;
    saveFormat?: "json" | "text";
    /**
     * Called when the user types `@`. Return `true` if the consumer is going
     * to open a mention popup (the `@` will be swallowed); return `false`/void
     * to let Tiptap insert the literal `@` character.
     */
    onTriggerAction?: (pos: number) => boolean | void;
    editorRefAction?: (el: HTMLDivElement | null) => void;
    editorInstanceAction?: (editor: Editor | null) => void;
    showToolbar?: boolean;
    toolbarClassName?: string;
    toolbarExtraActions?: React.ReactNode;
};

const TOKEN_REGEX = /@?mcp\s*<([a-z0-9_-]+)\s*\|\s*([a-z0-9_-]+)>/gi;

function parseValueToTiptapContent(
    value: string | object,
    enableMentions: boolean,
) {
    if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "doc"
    ) {
        return value;
    }

    const text = typeof value === "string" ? value : "";

    if (!enableMentions) {
        return {
            type: "doc",
            content: [
                {
                    type: "paragraph",
                    content: [{ type: "text", text: text || "" }],
                },
            ],
        };
    }

    const nodes: any[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    TOKEN_REGEX.lastIndex = 0;
    while ((match = TOKEN_REGEX.exec(text)) !== null) {
        const before = text.slice(lastIndex, match.index);
        if (before) {
            nodes.push({
                type: "text",
                text: before,
            });
        }

        const app = match[1];
        const tool = match[2];
        nodes.push({
            type: "mcpMention",
            attrs: {
                app,
                tool,
            },
        });

        lastIndex = match.index + match[0].length;
    }

    const remaining = text.slice(lastIndex);
    if (remaining) {
        nodes.push({
            type: "text",
            text: remaining,
        });
    }

    return {
        type: "doc",
        content: [
            {
                type: "paragraph",
                content:
                    nodes.length > 0 ? nodes : [{ type: "text", text: "" }],
            },
        ],
    };
}

function serializeTiptapContent(editor: any, enableMentions: boolean): string {
    if (!enableMentions) {
        return editor.state.doc.textContent || "";
    }

    const { state } = editor;
    const { doc } = state;
    let text = "";

    doc.descendants((node: any, pos: number) => {
        if (node.type.name === "mcpMention") {
            text += `@mcp<${node.attrs.app}|${node.attrs.tool}>`;
            return false;
        } else if (node.isText) {
            text += node.text || "";
        }
        return true;
    });

    return text;
}

export function getTextLengthFromTiptapJSON(json: any): number {
    if (!json || typeof json !== "object") return 0;

    let length = 0;
    function traverse(node: any) {
        if (node.type === "text") {
            length += (node.text || "").length;
        } else if (node.type === "mcpMention") {
            // Count mention as @mcp<app|tool>
            length += `@mcp<${node.attrs?.app || ""}|${node.attrs?.tool || ""}>`
                .length;
        } else if (node.content && Array.isArray(node.content)) {
            node.content.forEach(traverse);
        }
    }
    traverse(json);
    return length;
}

export function getWordCountFromTiptapJSON(json: any): number {
    if (!json || typeof json !== "object") return 0;

    let text = "";
    function traverse(node: any) {
        if (node.type === "text") {
            text += node.text || "";
        } else if (node.type === "mcpMention") {
            // Count mention as @mcp<app|tool>
            text += `@mcp<${node.attrs?.app || ""}|${node.attrs?.tool || ""}>`;
        } else if (node.content && Array.isArray(node.content)) {
            node.content.forEach(traverse);
        }
    }
    traverse(json);

    // Split by whitespace and filter empty strings
    const words = text
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0);
    return words.length;
}

export type TextStats = {
    characters: number;
    words: number;
    mentions: number;
};

export function getTextStatsFromTiptapJSON(json: any): TextStats {
    if (!json || typeof json !== "object") {
        return { characters: 0, words: 0, mentions: 0 };
    }

    let text = "";
    let mentions = 0;
    function traverse(node: any) {
        if (node.type === "text") {
            text += node.text || "";
        } else if (node.type === "mcpMention") {
            mentions++;
            text += `@mcp<${node.attrs?.app || ""}|${node.attrs?.tool || ""}>`;
        } else if (node.content && Array.isArray(node.content)) {
            node.content.forEach(traverse);
        }
    }
    traverse(json);

    const words = text
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0).length;

    return {
        characters: text.length,
        words,
        mentions,
    };
}

export function RichTextEditor(props: RichTextEditorProps) {
    const {
        value,
        onChangeAction: onChange,
        placeholder,
        className,
        disabled,
        maxLength,
        enableMentions = false,
        saveFormat = "json",
        onTriggerAction: onTrigger,
        editorRefAction: externalRefCallback,
        editorInstanceAction,
        showToolbar = true,
        toolbarClassName,
        toolbarExtraActions,
    } = props;

    // Use ref to avoid recreating editor when onTrigger changes
    const onTriggerRef = React.useRef(onTrigger);
    const editorInstanceRef = React.useRef<Editor | null>(null);

    React.useEffect(() => {
        onTriggerRef.current = onTrigger;
    }, [onTrigger]);

    const handleTriggerMemoized = React.useCallback((pos: number) => {
        const result = onTriggerRef.current?.(pos);
        return result === true;
    }, []);

    const extensions = React.useMemo(() => {
        const base: any[] = [
            StarterKit.configure({
                paragraph: {
                    HTMLAttributes: {
                        class: "m-0",
                    },
                },
                codeBlock: false,
                heading: {
                    levels: [1, 2, 3],
                },
            }),
            CodeBlock.configure({
                HTMLAttributes: {
                    class: "code-block",
                },
            }),
            SearchReplace.configure({
                searchTerm: "",
                caseSensitive: false,
            }),
            Placeholder.configure({
                placeholder: placeholder || "",
            }),
        ];

        if (enableMentions) {
            base.push(
                MCPMention,
                MentionTrigger.configure({
                    onTrigger: handleTriggerMemoized,
                }),
            );
        }

        return base;
    }, [enableMentions, handleTriggerMemoized, placeholder]);

    // Use refs to prevent editor recreation when callbacks change
    const onChangeRef = React.useRef(onChange);
    const saveFormatRef = React.useRef(saveFormat);
    const maxLengthRef = React.useRef(maxLength);
    const enableMentionsRef = React.useRef(enableMentions);

    React.useEffect(() => {
        onChangeRef.current = onChange;
        saveFormatRef.current = saveFormat;
        maxLengthRef.current = maxLength;
        enableMentionsRef.current = enableMentions;
    }, [onChange, saveFormat, maxLength, enableMentions]);

    const editor = useEditor({
        extensions,
        content: parseValueToTiptapContent(value || "", enableMentions) as any,
        editable: !disabled,
        immediatelyRender: false,
        onUpdate: ({ editor }) => {
            const currentSaveFormat = saveFormatRef.current;
            const currentMaxLength = maxLengthRef.current;
            const currentEnableMentions = enableMentionsRef.current;

            if (currentSaveFormat === "json") {
                const json = editor.getJSON();
                onChangeRef.current?.(json);
            } else {
                const text = serializeTiptapContent(
                    editor,
                    currentEnableMentions,
                );
                const final =
                    currentMaxLength && text.length > currentMaxLength
                        ? text.slice(0, currentMaxLength)
                        : text;
                onChangeRef.current?.(final);
            }
        },
        editorProps: {
            attributes: {
                class: cn(
                    "min-h-20 w-full rounded-xl px-6 py-4 text-sm ring-1",
                    "bg-card-lv2 ring-card-lv3",
                    "outline-hidden transition-all duration-200",
                    "prose prose-sm max-w-none",
                    "focus-within:ring-primary/30 focus-within:ring-2 focus-within:bg-card-lv3/50",
                    "hover:ring-card-lv3/80",
                    "[&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0",
                    "[&_code]:bg-card-lv3 [&_code]:text-primary-light [&_code]:rounded [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
                    "[&_strong]:font-semibold [&_strong]:text-text-primary",
                    "[&_em]:italic",
                    "[&_.is-empty:first-child::before]:content-[attr(data-placeholder)] [&_.is-empty:first-child::before]:float-left [&_.is-empty:first-child::before]:text-text-placeholder/50 [&_.is-empty:first-child::before]:pointer-events-none [&_.is-empty:first-child::before]:h-0",
                    disabled && "opacity-50 pointer-events-none",
                    className,
                ),
            },
        },
    });

    // Keep editable state in sync when disabled prop changes after creation
    React.useEffect(() => {
        if (editor && !editor.isDestroyed) {
            editor.setEditable(!disabled);
        }
    }, [editor, disabled]);

    React.useEffect(() => {
        if (editor) {
            editorInstanceRef.current = editor;
            if (externalRefCallback) {
                const element = editor.view.dom as HTMLDivElement;
                externalRefCallback(element);
            }
            if (editorInstanceAction) {
                editorInstanceAction(editor);
            }

            const handleRemoveClick = (event: MouseEvent) => {
                const target = event.target as HTMLElement;

                const removeButton = target.closest(
                    '[data-remove-mention="true"]',
                ) as HTMLElement;

                if (!removeButton) {
                    if (target.getAttribute("data-remove-mention") !== "true") {
                        return;
                    }
                }

                const button = removeButton || target;
                event.preventDefault();
                event.stopPropagation();

                const mention = button.closest(
                    '[data-type="mcp-mention"]',
                ) as HTMLElement;
                if (!mention) {
                    console.error("Mention element not found");
                    return;
                }

                try {
                    let pos: number | null = null;

                    try {
                        pos = editor.view.posAtDOM(mention, 0);
                    } catch {
                        try {
                            pos = editor.view.posAtDOM(mention, 1);
                        } catch {
                            const firstChild = mention.firstChild;
                            if (firstChild) {
                                try {
                                    pos = editor.view.posAtDOM(firstChild, 0);
                                } catch {}
                            }
                        }
                    }

                    if (pos !== null && pos !== undefined) {
                        const { state } = editor.view;
                        const $pos = state.doc.resolve(pos);

                        let found = false;
                        for (let depth = $pos.depth; depth >= 0; depth--) {
                            const node = $pos.node(depth);
                            if (node && node.type.name === "mcpMention") {
                                const from = $pos.before(depth);
                                const to = $pos.after(depth);

                                editor
                                    .chain()
                                    .focus()
                                    .setTextSelection({ from, to })
                                    .deleteSelection()
                                    .run();
                                found = true;
                                break;
                            }
                        }

                        if (!found) {
                            const app = mention.getAttribute("data-app");
                            const tool = mention.getAttribute("data-tool");

                            if (app && tool) {
                                let mentionFrom: number | null = null;
                                let mentionTo: number | null = null;

                                state.doc.nodesBetween(
                                    0,
                                    state.doc.content.size,
                                    (node, nodePos) => {
                                        if (
                                            node.type.name === "mcpMention" &&
                                            node.attrs.app === app &&
                                            node.attrs.tool === tool
                                        ) {
                                            mentionFrom = nodePos;
                                            mentionTo = nodePos + node.nodeSize;
                                            return false;
                                        }
                                    },
                                );

                                if (
                                    mentionFrom !== null &&
                                    mentionTo !== null
                                ) {
                                    editor
                                        .chain()
                                        .focus()
                                        .setTextSelection({
                                            from: mentionFrom,
                                            to: mentionTo,
                                        })
                                        .deleteSelection()
                                        .run();
                                }
                            }
                        }
                    } else {
                        const app = mention.getAttribute("data-app");
                        const tool = mention.getAttribute("data-tool");

                        if (app && tool) {
                            const { state } = editor.view;
                            let mentionFrom: number | null = null;
                            let mentionTo: number | null = null;

                            state.doc.nodesBetween(
                                0,
                                state.doc.content.size,
                                (node, nodePos) => {
                                    if (
                                        node.type.name === "mcpMention" &&
                                        node.attrs.app === app &&
                                        node.attrs.tool === tool
                                    ) {
                                        mentionFrom = nodePos;
                                        mentionTo = nodePos + node.nodeSize;
                                        return false;
                                    }
                                },
                            );

                            if (mentionFrom !== null && mentionTo !== null) {
                                editor
                                    .chain()
                                    .focus()
                                    .setTextSelection({
                                        from: mentionFrom,
                                        to: mentionTo,
                                    })
                                    .deleteSelection()
                                    .run();
                            }
                        }
                    }
                } catch (error) {
                    console.error("Error removing mention:", error);
                }
            };

            const editorDOM = editor.view.dom;
            editorDOM.addEventListener("click", handleRemoveClick, true);

            return () => {
                editorDOM.removeEventListener("click", handleRemoveClick, true);
            };
        } else {
            editorInstanceRef.current = null;
            if (editorInstanceAction) {
                editorInstanceAction(null);
            }
        }
    }, [editor, externalRefCallback, editorInstanceAction]);

    const valueKey = React.useMemo(() => {
        if (typeof value === "object" && value !== null) {
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        }
        return value || "";
    }, [value]);

    React.useEffect(() => {
        if (!editor) {
            return;
        }

        const currentContent =
            saveFormat === "json"
                ? editor.getJSON()
                : serializeTiptapContent(editor, enableMentions);
        const currentKey =
            typeof currentContent === "object"
                ? JSON.stringify(currentContent)
                : currentContent;

        if (valueKey !== currentKey) {
            editor.commands.setContent(
                parseValueToTiptapContent(value || "", enableMentions) as any,
            );
        }
    }, [valueKey, editor, enableMentions, saveFormat, value]);

    if (!editor) {
        return null;
    }

    return (
        <div className="flex flex-col gap-2">
            {showToolbar && (
                <RichTextEditorToolbar
                    editor={editor}
                    className={toolbarClassName}
                    extraActions={toolbarExtraActions}
                />
            )}
            <RichTextEditorSearch editor={editor} />
            <EditorContent editor={editor} />
        </div>
    );
}
