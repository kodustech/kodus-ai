"use client";

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface SearchReplaceOptions {
    searchTerm: string;
    caseSensitive?: boolean;
}

const SearchReplacePluginKey = new PluginKey("searchReplace");

export const SearchReplace = Extension.create<SearchReplaceOptions>({
    name: "searchReplace",

    addOptions() {
        return {
            searchTerm: "",
            caseSensitive: false,
        };
    },

    addProseMirrorPlugins() {
        const extension = this;
        return [
            new Plugin({
                key: SearchReplacePluginKey,
                state: {
                    init() {
                        return DecorationSet.empty;
                    },
                    apply(tr, value, oldState, newState) {
                        const meta = tr.getMeta(SearchReplacePluginKey);
                        const searchTerm =
                            meta?.searchTerm ?? extension.options.searchTerm;
                        const caseSensitive =
                            meta?.caseSensitive ??
                            extension.options.caseSensitive;

                        if (!searchTerm || searchTerm.length === 0) {
                            return DecorationSet.empty;
                        }

                        const decorations: Decoration[] = [];
                        const regex = new RegExp(
                            searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                            caseSensitive ? "g" : "gi",
                        );

                        newState.doc.descendants((node, pos) => {
                            if (node.isText) {
                                const text = node.text || "";
                                let match;
                                const regexCopy = new RegExp(
                                    regex.source,
                                    regex.flags,
                                );

                                while (
                                    (match = regexCopy.exec(text)) !== null
                                ) {
                                    const from = pos + match.index;
                                    const to = from + match[0].length;
                                    decorations.push(
                                        Decoration.inline(from, to, {
                                            class: "bg-yellow-400/30 ring-1 ring-yellow-400/50 rounded px-0.5",
                                        }),
                                    );
                                }
                            }
                        });

                        return DecorationSet.create(newState.doc, decorations);
                    },
                },
                props: {
                    decorations(state) {
                        return this.getState(state);
                    },
                },
            }),
        ];
    },

    addCommands() {
        return {
            setSearchTerm:
                (searchTerm: string, caseSensitive = false) =>
                ({ tr, dispatch }) => {
                    if (dispatch) {
                        const newTr = tr.setMeta(SearchReplacePluginKey, {
                            searchTerm,
                            caseSensitive,
                        });
                        dispatch(newTr);
                    }
                    return true;
                },
            clearSearch:
                () =>
                ({ tr, dispatch }) => {
                    if (dispatch) {
                        const newTr = tr.setMeta(SearchReplacePluginKey, {
                            searchTerm: "",
                            caseSensitive: false,
                        });
                        dispatch(newTr);
                    }
                    return true;
                },
        };
    },
});
