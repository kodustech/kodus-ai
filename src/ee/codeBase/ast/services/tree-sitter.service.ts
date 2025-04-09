import { Injectable } from '@nestjs/common';
import * as Parser from 'tree-sitter';
import { SyntaxNode, Tree } from 'tree-sitter';
import { SupportedLanguage } from '@/core/domain/codeBase/contracts/SupportedLanguages';

// Importar parsers para cada linguagem suportada
import * as typescript from 'tree-sitter-typescript/typescript';
import * as javascript from 'tree-sitter-javascript';
import * as python from 'tree-sitter-python';
import * as java from 'tree-sitter-java';
import * as go from 'tree-sitter-go';
import * as ruby from 'tree-sitter-ruby';
// @ts-ignore
import * as php from 'tree-sitter-php/php';

export interface QueryMatch {
    pattern: number;
    captures: Array<{
        name: string;
        node: SyntaxNode;
    }>;
}

@Injectable()
export class TreeSitterService {
    private readonly parsers: Map<string, Parser>
    private readonly languageMap: Map<string, any>;

    constructor() {
        this.parsers = new Map();
        this.languageMap = new Map([
            ['typescript', typescript],
            ['javascript', javascript],
            ['python', python],
            ['java', java],
            ['go', go],
            ['ruby', ruby],
            ['php', php]
        ]);
        this.initializeParsers();
    }

    private initializeParsers(): void {
        try {
            for (const [lang, grammar] of this.languageMap) {
                const parser = new Parser();
                parser.setLanguage(grammar);
                this.parsers.set(lang, parser);
            }
        } catch (error) {
            throw new Error(`Failed to initialize parsers: ${error.message}`);
        }
    }

    public parse(code: string, language: SupportedLanguage): Tree {
        const parser = this.parsers.get(language);

        if (!parser) {
            throw new Error(`No parser available for language: ${language}`);
        }

        const tree = parser.parse(code);
        if (!tree) {
            throw new Error('Failed to parse code');
        }

        return tree;
    }


    public getParser(language: string): Parser | undefined {
        return this.parsers.get(language);
    }

    /**
     * Retorna o texto de um nó da árvore de sintaxe
     * @param node O nó do qual obter o texto
     * @returns O texto do nó
     */
    public getNodeText(node: SyntaxNode): string {
        if (!node) {
            throw new Error('Invalid syntax node provided');
        }
        return node.text;
    }

    /**
     * Finds nodes of a specific type in the syntax tree
     * @param root The root node to start traversal from
     * @param type The type of node to find
     * @returns Array of found nodes matching the type
     */
    public findNodes(root: SyntaxNode, type: string): SyntaxNode[] {
        if (!root) {
            throw new Error('Invalid syntax node provided');
        }

        if (!type || typeof type !== 'string') {
            throw new Error('Invalid node type specified');
        }

        const nodes: SyntaxNode[] = [];

        if (root.type === type) {
            nodes.push(root);
        }

        for (const child of root.children) {
            nodes.push(...this.findNodes(child, type));
        }

        return nodes;
    }

    /**
     * Finds nodes of a specific type within a subtree
     * @param root The root node of the subtree
     * @param type The type of node to find
     * @returns Array of found nodes matching the type
     */
    public findNodesInSubtree(root: SyntaxNode, type: string): SyntaxNode[] {
        if (!root) {
            throw new Error('Invalid syntax node provided');
        }

        if (!type || typeof type !== 'string') {
            throw new Error('Invalid node type specified');
        }

        const results: SyntaxNode[] = [];
        const traverse = (node: SyntaxNode) => {
            if (node.type === type) {
                results.push(node);
            }
            node.children.forEach(traverse);
        };
        traverse(root);
        return results;
    }

    /**
     * Finds a node at a specific position in the tree
     * @param tree The syntax tree to search in
     * @param position The position to search for
     * @returns The node at the position or null if not found
     */
    public findNodeAtPosition(tree: Tree, position: any): SyntaxNode | null {
        if (!tree || !tree.rootNode) {
            throw new Error('Invalid syntax tree provided');
        }

        if (!position || typeof position.row !== 'number' || typeof position.column !== 'number') {
            throw new Error('Invalid position specified');
        }

        try {
            return tree.rootNode.descendantForPosition(position);
        } catch (error) {
            throw new Error(`Failed to find node at position: ${error.message}`);
        }
    }

    /**
     * Provides a pretty-printed representation of the AST
     * @param root The root node to print
     * @returns A string representation of the AST
     */
    public printTree(root: SyntaxNode): string {
        if (!root) {
            throw new Error('Invalid syntax node provided');
        }

        const printNode = (node: SyntaxNode, depth = 0): string => {
            const indent = '  '.repeat(depth);
            let result = `${indent}${node.type} [${node.startPosition.row}:${node.startPosition.column} - ${node.endPosition.row}:${node.endPosition.column}]
`;
            node.children.forEach(child => {
                result += printNode(child, depth + 1);
            });
            return result;
        };

        return printNode(root);
    }

    /**
     * Executes a query on the syntax tree using tree-sitter's query language
     * @param tree The syntax tree to query
     * @param language The language of the syntax tree
     * @param queryString The query string in tree-sitter query language
     * @returns Array of query matches
     */
    public query(tree: Tree, language: SupportedLanguage, queryString: string): QueryMatch[] {
        if (!tree || !tree.rootNode) {
            throw new Error('Invalid syntax tree provided');
        }

        if (!queryString || typeof queryString !== 'string') {
            throw new Error('Invalid query string provided');
        }

        const parser = this.parsers.get(language);
        if (!parser) {
            throw new Error(`No parser available for language: ${language}`);
        }

        try {
            // Create a new query using the defined language
            const query = new Parser.Query(parser.getLanguage(), queryString);
            const matches = query.matches(tree.rootNode);

            return matches.map((match) => ({
                pattern: match.pattern,
                captures: match.captures.map((capture) => ({
                    name: capture.name,
                    node: capture.node,
                })),
            }));
        } catch (error) {
            console.error('Error executing query:', error);
            return [];
        }
    }
}
