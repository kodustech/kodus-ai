import * as ts from 'typescript';

export interface CodeStructureResult {
    functions: number;
    functionsNeedingAttention: number;
}

const SOURCE_FILE = /\.[cm]?[jt]sx?$/i;

export function supportsCodeStructureAnalysis(path: string): boolean {
    return SOURCE_FILE.test(path) && !/\.d\.ts$/i.test(path);
}

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
    return (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
    );
}

/** A deliberately small, auditable structural check, not CodeScene Code Health. */
export function analyzeCodeStructure(
    path: string,
    content: string,
): CodeStructureResult | null {
    if (!supportsCodeStructureAnalysis(path) || content.length > 150_000) {
        return null;
    }
    const kind = /\.tsx$/i.test(path)
        ? ts.ScriptKind.TSX
        : /\.jsx$/i.test(path)
          ? ts.ScriptKind.JSX
          : /\.[cm]?ts$/i.test(path)
            ? ts.ScriptKind.TS
            : ts.ScriptKind.JS;
    const source = ts.createSourceFile(
        path,
        content,
        ts.ScriptTarget.Latest,
        true,
        kind,
    );
    const diagnostics = ts.transpileModule(content, {
        fileName: path,
        reportDiagnostics: true,
    }).diagnostics;
    if (
        diagnostics?.some(
            (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
        )
    )
        return null;

    let functions = 0;
    let functionsNeedingAttention = 0;
    const visit = (node: ts.Node) => {
        if (isFunction(node) && node.body) {
            functions += 1;
            const startLine = source.getLineAndCharacterOfPosition(
                node.body.getStart(source),
            ).line;
            const endLine = source.getLineAndCharacterOfPosition(
                node.body.getEnd(),
            ).line;
            let decisions = 0;
            let maxNesting = 0;
            const inspect = (child: ts.Node, nesting: number) => {
                if (child !== node && isFunction(child)) return;
                const branch =
                    ts.isIfStatement(child) ||
                    ts.isForStatement(child) ||
                    ts.isForInStatement(child) ||
                    ts.isForOfStatement(child) ||
                    ts.isWhileStatement(child) ||
                    ts.isDoStatement(child) ||
                    ts.isCaseClause(child) ||
                    ts.isCatchClause(child) ||
                    ts.isConditionalExpression(child);
                if (branch) {
                    decisions += 1;
                    maxNesting = Math.max(maxNesting, nesting + 1);
                }
                ts.forEachChild(child, (next) =>
                    inspect(next, nesting + Number(branch)),
                );
            };
            inspect(node.body, 0);
            if (
                endLine - startLine + 1 >= 80 ||
                decisions >= 12 ||
                maxNesting >= 4
            ) {
                functionsNeedingAttention += 1;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return { functions, functionsNeedingAttention };
}
