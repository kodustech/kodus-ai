import { Injectable } from '@nestjs/common';
import { BaseParser } from './BaseParser';
import { SyntaxNode } from 'tree-sitter';
const TypeScript = require('tree-sitter-typescript');

@Injectable()
export class TypeScriptParser extends BaseParser {
    constructor() {
        super(TypeScript.typescript);
    }

    public getLanguageName(): string {
        return 'typescript';
    }

    public findImports(root: SyntaxNode): SyntaxNode[] {
        return this.findNodes(root, 'import_statement');
    }

    public findFunctions(root: SyntaxNode): SyntaxNode[] {
        return [
            ...this.findNodes(root, 'function_declaration'),
            ...this.findNodes(root, 'method_definition'),
            ...this.findNodes(root, 'arrow_function'),
        ];
    }

    public findClasses(root: SyntaxNode): SyntaxNode[] {
        return this.findNodes(root, 'class_declaration');
    }

    public findVariables(root: SyntaxNode): SyntaxNode[] {
        return this.findNodes(root, 'variable_declaration');
    }
}
