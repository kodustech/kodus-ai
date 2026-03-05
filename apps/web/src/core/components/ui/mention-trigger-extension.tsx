"use client";

import { Extension } from "@tiptap/core";

export interface MentionTriggerOptions {
    onTrigger: (pos: number) => void;
}

export const MentionTrigger = Extension.create<MentionTriggerOptions>({
    name: "mentionTrigger",

    addOptions() {
        return {
            onTrigger: () => {},
        };
    },

    addKeyboardShortcuts() {
        return {
            "@": ({ editor }) => {
                const { state } = editor;
                const { selection } = state;
                const pos = selection.$from.pos;
                this.options.onTrigger(pos);
                return true;
            },
        };
    },
});
