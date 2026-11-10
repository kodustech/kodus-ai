import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const coreFiles = ['index.ts', 'test-planner.agent.ts', 'code-search.ts', 'file-window.ts', 'plan-without-model.ts', 'repo-reader.ts'];

describe('planner core dependency boundary', () => {
    it('is available independently of the product API and model credentials', () => {
        expect(coreFiles.filter(file => !existsSync(join(__dirname, file)))).toEqual([]);
        for (const file of coreFiles) {
            const tree = ts.createSourceFile(file, readFileSync(join(__dirname, file), 'utf8'), ts.ScriptTarget.Latest, true);
            const imports: string[] = [];
            const visit = (node: ts.Node) => {
                if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                    imports.push(node.moduleSpecifier.text);
                }
                if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
                    imports.push(...node.arguments.filter(ts.isStringLiteral).map(arg => arg.text));
                }
                ts.forEachChild(node, visit);
            };
            visit(tree);
            const forbidden = imports.filter(path => /(?:^|\/)api(?:\/|$)|recipe-author|git-repo|byok|@libs\/llm|@nestjs|(?:node:)?(?:fs(?:\/promises)?|child_process)$/.test(path));
            expect({ file, forbidden }).toEqual({ file, forbidden: [] });
        }
    });
});
