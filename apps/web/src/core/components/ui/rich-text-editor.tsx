"use client";

import * as React from "react";
import Placeholder from "@tiptap/extension-placeholder";
import { Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { cn } from "src/core/utils/components";

import { convertTiptapJSONToText } from "src/core/utils/tiptap-json-to-text";

import { CodeBlock } from "./code-block-extension";
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

// Legacy `@mcp<app|tool>` mentions used to render as a styled `mcpMention`
// node. That feature was removed — flatten any such node back to plain
// `@mcp<app|tool>` text so saved docs render as plain text without the
// (deleted) extension, instead of being dropped by Tiptap as an unknown node.
function flattenMcpMentionNodes(node: any): any {
    if (!node || typeof node !== "object") return node;
    if (node.type === "mcpMention") {
        const app = node.attrs?.app ?? "";
        const tool = node.attrs?.tool ?? "";
        return { type: "text", text: `@mcp<${app}|${tool}>` };
    }
    if (Array.isArray(node.content)) {
        return { ...node, content: node.content.map(flattenMcpMentionNodes) };
    }
    return node;
}

// Inverse of applyInlineMarksAsMarkdown in tiptap-json-to-text.ts: reads the
// same **bold** / *italic* / `code` / ~~strike~~ / [text](href) syntax back
// into marked text nodes so formatting survives the save/reload round-trip
// for saveFormat="text" fields. One line == one paragraph, so no block-level
// syntax (headings, lists, quotes) is recognized here.
const INLINE_MARK_PATTERN =
    /`([^`]+)`|\*\*([^*]+)\*\*|~~([^~]+)~~|\*([^*]+)\*|\[([^\]]+)\]\(([^)]*)\)/;

function parseInlineMarkdownLine(line: string): any[] {
    if (!line) return [];

    const nodes: any[] = [];
    let rest = line;

    while (rest) {
        const match = rest.match(INLINE_MARK_PATTERN);
        if (!match) {
            nodes.push({ type: "text", text: rest });
            break;
        }

        const [full, code, bold, strike, italic, linkText, linkHref] = match;
        if (match.index) {
            nodes.push({ type: "text", text: rest.slice(0, match.index) });
        }

        if (code !== undefined) {
            nodes.push({
                type: "text",
                text: code,
                marks: [{ type: "code" }],
            });
        } else if (bold !== undefined) {
            nodes.push(
                ...parseInlineMarkdownLine(bold).map((node) => ({
                    ...node,
                    marks: [...(node.marks ?? []), { type: "bold" }],
                })),
            );
        } else if (strike !== undefined) {
            nodes.push(
                ...parseInlineMarkdownLine(strike).map((node) => ({
                    ...node,
                    marks: [...(node.marks ?? []), { type: "strike" }],
                })),
            );
        } else if (italic !== undefined) {
            nodes.push(
                ...parseInlineMarkdownLine(italic).map((node) => ({
                    ...node,
                    marks: [...(node.marks ?? []), { type: "italic" }],
                })),
            );
        } else if (linkText !== undefined) {
            nodes.push(
                ...parseInlineMarkdownLine(linkText).map((node) => ({
                    ...node,
                    marks: [
                        ...(node.marks ?? []),
                        { type: "link", attrs: { href: linkHref || "" } },
                    ],
                })),
            );
        }

        rest = rest.slice(match.index! + full.length);
    }

    return nodes;
}

function parseValueToTiptapContent(
    value: string | object,
    _enableMentions: boolean,
) {
    if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "doc"
    ) {
        return flattenMcpMentionNodes(value);
    }

    const text = typeof value === "string" ? value : "";

    return { type: "doc", content: parseBlocksFromLines(text.split("\n")) };
}

const HEADING_PATTERN = /^(#{1,3})\s+(.*)$/;
const BULLET_ITEM_PATTERN = /^-\s+(.*)$/;
const ORDERED_ITEM_PATTERN = /^(\d+)\.\s+(.*)$/;

function toParagraph(line: string) {
    const content = parseInlineMarkdownLine(line);
    return { type: "paragraph", ...(content.length ? { content } : {}) };
}

function toListItem(line: string) {
    return { type: "listItem", content: [toParagraph(line)] };
}

// Groups plain lines back into heading / bulletList / orderedList blocks
// using the same markdown-ish syntax convertTiptapJSONToText serializes to
// (`# `, `- `, `1. `). Consecutive list-marker lines become one list with
// multiple items; anything else is a plain paragraph, as before.
function parseBlocksFromLines(lines: string[]): any[] {
    const blocks: any[] = [];
    let i = 0;

    while (i < lines.length) {
        const headingMatch = lines[i].match(HEADING_PATTERN);
        if (headingMatch) {
            const [, hashes, rest] = headingMatch;
            const content = parseInlineMarkdownLine(rest);
            blocks.push({
                type: "heading",
                attrs: { level: hashes.length },
                ...(content.length ? { content } : {}),
            });
            i++;
            continue;
        }

        if (BULLET_ITEM_PATTERN.test(lines[i])) {
            const items: any[] = [];
            while (i < lines.length) {
                const match = lines[i].match(BULLET_ITEM_PATTERN);
                if (!match) break;
                items.push(toListItem(match[1]));
                i++;
            }
            blocks.push({ type: "bulletList", content: items });
            continue;
        }

        const orderedMatch = lines[i].match(ORDERED_ITEM_PATTERN);
        if (orderedMatch) {
            const start = parseInt(orderedMatch[1], 10);
            const items: any[] = [];
            while (i < lines.length) {
                const match = lines[i].match(ORDERED_ITEM_PATTERN);
                if (!match) break;
                items.push(toListItem(match[2]));
                i++;
            }
            blocks.push({ type: "orderedList", attrs: { start }, content: items });
            continue;
        }

        blocks.push(toParagraph(lines[i]));
        i++;
    }

    return blocks;
}

function serializeTiptapContent(editor: any, _enableMentions: boolean): string {
    return convertTiptapJSONToText(editor.getJSON());
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
