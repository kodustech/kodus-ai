"use client";

import { mergeAttributes, Node } from "@tiptap/core";

export interface MCPMentionOptions {
    HTMLAttributes: Record<string, any>;
}

export const MCPMention = Node.create<MCPMentionOptions>({
    name: "mcpMention",

    addOptions() {
        return {
            HTMLAttributes: {},
        };
    },

    inline: true,

    group: "inline",

    atom: true,

    selectable: false,

    addAttributes() {
        return {
            app: {
                default: null,
                parseHTML: (element) => element.getAttribute("data-app"),
                renderHTML: (attributes) => {
                    if (!attributes.app) {
                        return {};
                    }
                    return {
                        "data-app": attributes.app,
                    };
                },
            },
            tool: {
                default: null,
                parseHTML: (element) => element.getAttribute("data-tool"),
                renderHTML: (attributes) => {
                    if (!attributes.tool) {
                        return {};
                    }
                    return {
                        "data-tool": attributes.tool,
                    };
                },
            },
        };
    },

    parseHTML() {
        return [
            {
                tag: 'span[data-type="mcp-mention"]',
            },
        ];
    },

    renderHTML({ HTMLAttributes, node }) {
        const app = node.attrs.app || "";
        const tool = node.attrs.tool || "";

        return [
            "span",
            mergeAttributes(
                {
                    "data-type": "mcp-mention",
                    "data-app": app,
                    "data-tool": tool,
                    "role": "button",
                    "aria-label": `MCP tool: ${app} - ${tool}. Press Delete or Backspace to remove.`,
                    "tabindex": "-1",
                    "class":
                        "group inline-flex items-center gap-1 rounded-md bg-primary/15 px-2 py-1 ring-1 ring-primary/30 whitespace-nowrap transition-all duration-150 hover:bg-primary/20 hover:ring-primary/40",
                    "style":
                        "display:inline-flex;flex-shrink:0;vertical-align:baseline;",
                    "contenteditable": "false",
                },
                this.options.HTMLAttributes,
                HTMLAttributes,
            ),
            ["span", { class: "text-text-secondary font-medium" }, "mcp"],
            ["span", { class: "text-text-secondary/70" }, "<"],
            ["span", { class: "text-primary-light font-semibold" }, app],
            ["span", { class: "text-text-secondary/70" }, "|"],
            ["span", { class: "text-accent font-bold" }, tool],
            ["span", { class: "text-text-secondary/70" }, ">"],
            [
                "button",
                {
                    "type": "button",
                    "data-remove-mention": "true",
                    "aria-label": "Remove",
                    "class":
                        "ml-0.5 -mr-0.5 rounded px-0.5 py-0 text-xs font-medium text-red-400/80 hover:text-red-400 hover:bg-red-400/20 opacity-0 group-hover:opacity-100 transition-all duration-150 active:scale-95",
                    "style":
                        "outline:none;border:none;background:transparent;cursor:pointer;",
                },
                "×",
            ],
        ];
    },

    addCommands() {
        return {
            setMCPMention: (attributes: { app: string; tool: string }) => {
                return ({ commands }: { commands: any }) => {
                    return commands.insertContent({
                        type: this.name,
                        attrs: attributes,
                    });
                };
            },
        } as any;
    },
});
