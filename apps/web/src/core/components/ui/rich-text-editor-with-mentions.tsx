"use client";

import * as React from "react";
import { Editor } from "@tiptap/react";

import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "./command";
import { Popover, PopoverAnchor, PopoverContent } from "./popover";
import { RichTextEditor } from "./rich-text-editor";

export type MentionGroupItem = {
    value: string;
    label: string;
    type?: string;
    meta?: Record<string, any>;
    children?: () => Promise<MentionGroup[]> | MentionGroup[];
};
export type MentionGroup = { groupLabel: string; items: MentionGroupItem[] };

export type RichTextEditorWithMentionsRef = {
    insertText: (text: string) => void;
    insertMCPMention: (app: string, tool: string) => void;
    getEditor: () => Editor | null;
    focus: () => void;
};

type Props = {
    value: string | object;
    onChangeAction: (next: string | object) => void;
    groups: MentionGroup[];
    className?: string;
    placeholder?: string;
    saveFormat?: "json" | "text";
    formatInsertByType?: Partial<
        Record<string, (item: MentionGroupItem) => string>
    >;
    disabled?: boolean;
    showToolbar?: boolean;
    headerSlot?: React.ReactNode;
    toolbarExtraActions?: React.ReactNode;
};

export const RichTextEditorWithMentions = React.forwardRef<
    RichTextEditorWithMentionsRef,
    Props
>(function RichTextEditorWithMentions(props, ref) {
    const {
        value,
        onChangeAction: onChange,
        className,
        placeholder,
        groups,
        saveFormat = "json",
        formatInsertByType,
        disabled,
        showToolbar,
        headerSlot,
        toolbarExtraActions,
    } = props;
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState("");
    const [triggerPos, setTriggerPos] = React.useState<number | null>(null);
    const [viewStack, setViewStack] = React.useState<MentionGroup[][]>([]);
    const [childSearchGroups, setChildSearchGroups] = React.useState<
        MentionGroup[] | null
    >(null);

    const editorRef = React.useRef<HTMLDivElement | null>(null);
    const editorInstanceRef = React.useRef<Editor | null>(null);

    React.useImperativeHandle(
        ref,
        () => ({
            insertText: (text: string) => {
                const editor = editorInstanceRef.current;
                if (editor) {
                    editor.chain().focus().insertContent(text).run();
                } else {
                    const currentValue = typeof value === "string" ? value : "";
                    onChange(`${currentValue}${text}`);
                }
            },
            insertMCPMention: (app: string, tool: string) => {
                const editor = editorInstanceRef.current;
                if (editor) {
                    editor
                        .chain()
                        .focus()
                        .insertContent({
                            type: "mcpMention",
                            attrs: { app, tool },
                        })
                        .insertContent(" ")
                        .run();
                } else {
                    const currentValue = typeof value === "string" ? value : "";
                    onChange(`${currentValue}@mcp<${app}|${tool}> `);
                }
            },
            getEditor: () => editorInstanceRef.current,
            focus: () => {
                editorInstanceRef.current?.chain().focus().run();
            },
        }),
        [value, onChange],
    );

    const groupsRef = React.useRef(groups);
    React.useEffect(() => {
        groupsRef.current = groups;
    }, [groups]);

    const handleEditorRef = React.useCallback((el: HTMLDivElement | null) => {
        editorRef.current = el;
    }, []);

    const handleEditorInstance = React.useCallback((editor: Editor | null) => {
        editorInstanceRef.current = editor;
    }, []);

    const handleTrigger = React.useCallback(
        (pos: number) => {
            // No suggestions to show → let Tiptap insert the literal `@` so
            // users can type things like `@file:owner/repo/path` inside a
            // kody rule description without the editor swallowing the key.
            // `groupsRef.current` can be `undefined` when the parent passes
            // `groups={undefined}` before the useEffect below has run, so
            // the optional-chain is needed to avoid a TypeError crash.
            if (!groupsRef.current?.length) return false;
            setTriggerPos(pos);
            setQuery("");
            setViewStack([]);
            setOpen(true);
            return true;
        },
        [],
    );

    const listRef = React.useRef<HTMLDivElement | null>(null);

    const handleListWheel = React.useCallback(
        (event: React.WheelEvent<HTMLDivElement>) => {
            if (!listRef.current) return;

            event.preventDefault();
            event.stopPropagation();

            listRef.current.scrollBy({ top: event.deltaY, behavior: "auto" });
        },
        [],
    );

    const insertToken = React.useCallback(
        (item: MentionGroupItem) => {
            const editor = editorInstanceRef.current;

            if (!editor) {
                const byType =
                    (item.type && formatInsertByType?.[item.type]) ||
                    ((it: MentionGroupItem) => `@mcp<${it.label}>`);
                const token = byType(item);
                const cur = typeof value === "string" ? value : "";
                const afterAtPos = triggerPos ?? cur.length;
                let atPos = afterAtPos - 1;
                while (atPos >= 0 && cur[atPos] !== "@") {
                    atPos--;
                }
                if (atPos < 0 || cur[atPos] !== "@") {
                    const before = cur.slice(0, afterAtPos);
                    const after = cur.slice(afterAtPos);
                    onChange(`${before}${token} `);
                } else {
                    const before = cur.slice(0, atPos);
                    const after = cur.slice(afterAtPos);
                    onChange(`${before}${token} `);
                }
                setOpen(false);
                setQuery("");
                setTriggerPos(null);
                setViewStack([]);
                setChildSearchGroups(null);
                return;
            }

            const byType =
                (item.type && formatInsertByType?.[item.type]) ||
                ((it: MentionGroupItem) => {
                    const rawApp = String(it?.meta?.appName ?? "");
                    const app = rawApp
                        .toLowerCase()
                        .replace(/\bmcp\b/g, "")
                        .replace(/[^a-z0-9]+/g, "_")
                        .replace(/^_+|_+$/g, "");
                    const tool = String(it.label).toLowerCase();
                    return { app, tool };
                });

            if (item.type === "mcp" && item.meta?.appName) {
                const rawApp = String(item.meta.appName);
                const app = rawApp
                    .toLowerCase()
                    .replace(/\bmcp\b/g, "")
                    .replace(/[^a-z0-9]+/g, "_")
                    .replace(/^_+|_+$/g, "");
                const tool = String(item.label).toLowerCase();

                const { state } = editor;
                const { selection } = state;
                let pos = selection.$from.pos;

                let foundPos = pos;
                const $pos = state.doc.resolve(pos);
                let searchPos = $pos.pos;
                let found = false;

                for (let i = 0; i < 50 && searchPos > 0; i++) {
                    const char = state.doc.textBetween(
                        searchPos - 1,
                        searchPos,
                    );
                    if (char === "@") {
                        foundPos = searchPos - 1;
                        found = true;
                        break;
                    }
                    searchPos--;
                }

                if (found) {
                    editor
                        .chain()
                        .focus()
                        .setTextSelection({ from: foundPos, to: pos })
                        .deleteSelection()
                        .insertContent({
                            type: "mcpMention",
                            attrs: { app, tool },
                        })
                        .insertContent(" ")
                        .run();
                } else {
                    editor
                        .chain()
                        .focus()
                        .insertContent({
                            type: "mcpMention",
                            attrs: { app, tool },
                        })
                        .insertContent(" ")
                        .run();
                }
            } else {
                const byTypeString =
                    (item.type && formatInsertByType?.[item.type]) ||
                    ((it: MentionGroupItem) => `@${it.label}`);
                const token = byTypeString(item);

                const { state } = editor;
                const { selection } = state;
                const pos = selection.$from.pos;
                let foundPos = pos;
                const $pos = state.doc.resolve(pos);
                let searchPos = $pos.pos;
                let found = false;
                for (let i = 0; i < 50 && searchPos > 0; i++) {
                    const char = state.doc.textBetween(
                        searchPos - 1,
                        searchPos,
                    );
                    if (char === "@") {
                        foundPos = searchPos - 1;
                        found = true;
                        break;
                    }
                    searchPos--;
                }
                const chain = editor.chain().focus();
                if (found) {
                    chain.setTextSelection({ from: foundPos, to: pos });
                }
                chain.insertContent(`${token} `).run();
            }

            setOpen(false);
            setQuery("");
            setTriggerPos(null);
            setViewStack([]);
            setChildSearchGroups(null);
        },
        [value, triggerPos, onChange, formatInsertByType],
    );

    const currentGroups = React.useMemo(() => {
        return viewStack.length ? viewStack[viewStack.length - 1] : groups;
    }, [viewStack, groups]);

    const canGoBack = viewStack.length > 0;
    const goBack = React.useCallback(() => {
        setViewStack((s) => (s.length ? s.slice(0, s.length - 1) : s));
    }, []);

    React.useEffect(() => {
        const abortController = new AbortController();
        let active = true;

        const run = async () => {
            if (viewStack.length > 0 || !query) {
                setChildSearchGroups(null);
                return;
            }

            const currentGroups = groupsRef.current;
            const searchQuery = query.toLowerCase();

            const loaders: Array<Promise<MentionGroup | null>> = [];

            for (const group of currentGroups) {
                for (const item of group.items) {
                    if (!item.children || abortController.signal.aborted)
                        continue;

                    loaders.push(
                        (async () => {
                            try {
                                const getChildren = item.children!;
                                const children = await getChildren();

                                if (abortController.signal.aborted) return null;

                                const matchedItems = children.flatMap((g) =>
                                    g.items.filter((it) =>
                                        it.label
                                            .toLowerCase()
                                            .includes(searchQuery),
                                    ),
                                );
                                if (matchedItems.length === 0) return null;
                                return {
                                    groupLabel: item.label,
                                    items: matchedItems,
                                } as MentionGroup;
                            } catch (error) {
                                return null;
                            }
                        })(),
                    );
                }
            }

            const results = await Promise.all(loaders);

            if (active && !abortController.signal.aborted) {
                const filteredResults = results.filter(
                    Boolean,
                ) as MentionGroup[];
                setChildSearchGroups(
                    filteredResults.length ? filteredResults : null,
                );
            }
        };

        const timeoutId = setTimeout(run, 120);

        return () => {
            active = false;
            abortController.abort();
            clearTimeout(timeoutId);
        };
    }, [query, viewStack.length]);

    return (
        <Popover
            open={open}
            modal={false}
            onOpenChange={(o) => {
                if (o) {
                    setOpen(true);
                } else {
                    setOpen(false);
                    setQuery("");
                    setViewStack([]);
                    setChildSearchGroups(null);
                }
            }}>
            <div className="relative flex w-full flex-col gap-2">
                {headerSlot}
                <PopoverAnchor asChild>
                    <div />
                </PopoverAnchor>
                <RichTextEditor
                    enableMentions
                    saveFormat={saveFormat}
                    editorRefAction={handleEditorRef}
                    editorInstanceAction={handleEditorInstance}
                    value={value}
                    onChangeAction={onChange}
                    onTriggerAction={handleTrigger}
                    className={className}
                    placeholder={placeholder}
                    disabled={disabled}
                    showToolbar={showToolbar}
                    toolbarExtraActions={toolbarExtraActions}
                />
            </div>
            <PopoverContent
                className="flex max-h-[min(60vh,28rem)] w-80 flex-col overflow-hidden p-0"
                align="start"
                sideOffset={8}>
                <Command className="flex h-full flex-col overflow-hidden">
                    {viewStack.length > 0 && (
                        <div className="text-text-secondary flex shrink-0 items-center gap-2 px-3 py-2 text-xs">
                            <span>Root</span>
                            {viewStack.map((g, idx) => (
                                <React.Fragment key={idx}>
                                    <span>/</span>
                                    <span>{g[0]?.groupLabel ?? ""}</span>
                                </React.Fragment>
                            ))}
                        </div>
                    )}
                    <CommandInput
                        value={query}
                        onValueChange={setQuery}
                        placeholder="Type to filter…"
                        classNames={{
                            inputContainer: "shrink-0 border-b",
                            root: "h-11",
                        }}
                    />
                    <CommandList
                        className="min-h-0 flex-1 overflow-y-auto"
                        style={{ maxHeight: "18rem" }}
                        ref={(node) => {
                            listRef.current = node;
                        }}
                        onWheel={handleListWheel}>
                        <CommandEmpty>No results.</CommandEmpty>
                        {React.useMemo(() => {
                            const groupsToRender =
                                childSearchGroups ?? currentGroups;
                            return groupsToRender
                                .map((g) => {
                                    const filteredItems = g.items.filter((it) =>
                                        it.label
                                            .toLowerCase()
                                            .includes(query.toLowerCase()),
                                    );
                                    if (filteredItems.length === 0) return null;

                                    return (
                                        <CommandGroup
                                            key={g.groupLabel}
                                            heading={g.groupLabel}>
                                            {filteredItems.map((it) => (
                                                <CommandItem
                                                    key={it.value}
                                                    value={it.label}
                                                    onSelect={async () => {
                                                        if (it.children) {
                                                            const next =
                                                                await it.children();
                                                            setViewStack(
                                                                (s) => [
                                                                    ...s,
                                                                    next,
                                                                ],
                                                            );
                                                            setQuery("");
                                                        } else {
                                                            insertToken(it);
                                                        }
                                                    }}>
                                                    <span className="truncate">
                                                        {it.label}
                                                    </span>
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    );
                                })
                                .filter(Boolean);
                        }, [
                            childSearchGroups,
                            currentGroups,
                            query,
                            insertToken,
                        ])}
                    </CommandList>
                </Command>
                {canGoBack && (
                    <div className="bg-card-lv1/40 flex shrink-0 items-center justify-end border-t px-3 py-2">
                        <button
                            type="button"
                            className="text-text-secondary text-xs hover:underline"
                            onClick={goBack}>
                            ← Back
                        </button>
                    </div>
                )}
            </PopoverContent>
        </Popover>
    );
});
