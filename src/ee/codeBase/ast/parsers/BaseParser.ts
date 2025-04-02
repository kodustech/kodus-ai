import { Injectable } from '@nestjs/common';
import * as Parser from 'tree-sitter';
import { SyntaxNode } from 'tree-sitter';

@Injectable()
export abstract class BaseParser {
    protected parser: Parser;
    protected language: Parser.Language;

    constructor(language: Parser.Language) {
        this.parser = new Parser();
        this.language = language;
        this.parser.setLanguage(language);
    }

    public parse(code: string): SyntaxNode {
        const tree = this.parser.parse(code);
        return this.convertToASTNode(tree.rootNode);
    }

    protected convertToASTNode(node: SyntaxNode): SyntaxNode {
        return node;
    }

    public abstract getLanguageName(): string;

    protected findNodes(root: SyntaxNode, type: string): SyntaxNode[] {
        const nodes: SyntaxNode[] = [];
        this.traverse(root, (node) => {
            if (node.type === type) {
                nodes.push(node);
            }
        });
        return nodes;
    }

    protected traverse(node: SyntaxNode, callback: (node: SyntaxNode) => void): void {
        if (!node) return;

        callback(node);

        if (Array.isArray(node.children)) {
            node.children.forEach((child) => this.traverse(child, callback));
        }
    }
}
