"use client";

import { CodeBlock as TiptapCodeBlock } from "@tiptap/extension-code-block";

export const CodeBlock = TiptapCodeBlock.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
            language: {
                default: null,
                parseHTML: (element) => {
                    const lang = element.getAttribute("data-language") || null;
                    if (!lang) {
                        return null;
                    }
                    return lang.replace(/[^a-zA-Z0-9-]/g, "");
                },
                renderHTML: (attributes) => {
                    if (!attributes.language) {
                        return {};
                    }
                    return {
                        "data-language": attributes.language,
                    };
                },
            },
        };
    },

    renderHTML({ node, HTMLAttributes }) {
        const lang = node.attrs.language || "text";
        return [
            "pre",
            {
                ...HTMLAttributes,
                class: "relative my-4 rounded-lg overflow-hidden bg-[#27272a] ring-1 ring-card-lv3",
            },
            [
                "code",
                {
                    "class": `block p-4 text-sm font-mono text-white whitespace-pre overflow-x-auto language-${lang}`,
                    "data-language": lang,
                },
                0,
            ],
        ];
    },
});
