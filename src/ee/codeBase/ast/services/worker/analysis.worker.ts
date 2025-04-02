// src/workers/analysis.worker.ts
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

// Evitar erros de execução verificando se workerData existe
if (parentPort && workerData && typeof workerData === 'object') {
    const { filePath, normalizedPath } = workerData;

    // Verificar parâmetros de entrada
    if (!filePath || typeof filePath !== 'string') {
        parentPort.postMessage({
            error: 'Parâmetro filePath inválido ou ausente',
            fileAnalysis: { defines: [], calls: [], imports: [] },
            functions: {},
            types: {}
        });
    } else {
        // Ler o conteúdo do arquivo
        fs.readFile(filePath, 'utf8', (err, content) => {
            if (err) {
                parentPort.postMessage({
                    error: `Erro ao ler arquivo: ${err.message}`,
                    fileAnalysis: { defines: [], calls: [], imports: [] },
                    functions: {},
                    types: {}
                });
                return;
            }

            try {
                // Importar o parser adequado baseado na extensão do arquivo
                const extension = path.extname(filePath).toLowerCase();
                let parser;
                
                if (extension === '.ts' || extension === '.tsx') {
                    const treeSitter = require('tree-sitter');
                    parser = new treeSitter();
                    parser.setLanguage(require('tree-sitter-typescript').typescript);
                } else if (extension === '.js' || extension === '.jsx') {
                    const treeSitter = require('tree-sitter');
                    parser = new treeSitter();
                    parser.setLanguage(require('tree-sitter-javascript'));
                } else {
                    // Fallback para TypeScript
                    const treeSitter = require('tree-sitter');
                    parser = new treeSitter();
                    parser.setLanguage(require('tree-sitter-typescript').typescript);
                }

                // Fazer o parsing
                const syntaxTree = parser.parse(content);
                
                // Analisar a árvore - implementação simplificada
                const context = {
                    fileDefines: new Set(),
                    fileImports: new Set(),
                    fileClassNames: new Set(),
                    fileCalls: new Set()
                };

                // Processamento básico da árvore
                const rootNode = syntaxTree.rootNode;
                processNode(rootNode, context);
                
                // Retornar resultado para o thread principal
                parentPort.postMessage({
                    fileAnalysis: {
                        defines: Array.from(context.fileDefines),
                        calls: Array.from(context.fileCalls),
                        imports: Array.from(context.fileImports)
                    },
                    functions: {},
                    types: {}
                });
            } catch (error) {
                parentPort.postMessage({
                    error: `Erro na análise: ${error.message}`,
                    fileAnalysis: { defines: [], calls: [], imports: [] },
                    functions: {},
                    types: {}
                });
            }
        });
    }
} else {
    console.error('Worker iniciado sem dados válidos ou parentPort');
}

/**
 * Processa um nó da árvore sintática
 * @param node Nó da árvore
 * @param context Contexto de análise
 */
function processNode(node, context) {
    // Verificar o tipo do nó
    switch (node.type) {
        case 'import_statement':
        case 'import_declaration':
            context.fileImports.add(node.text.trim());
            break;
        case 'class_declaration':
            const classNameNode = node.childForFieldName('name');
            if (classNameNode) {
                const className = classNameNode.text;
                context.fileDefines.add(className);
                context.fileClassNames.add(className);
            }
            break;
        case 'function_declaration':
        case 'method_definition':
            const funcNameNode = node.childForFieldName('name');
            if (funcNameNode) {
                context.fileDefines.add(funcNameNode.text);
            }
            break;
        case 'call_expression':
            const calleeNode = node.childForFieldName('function');
            if (calleeNode) {
                context.fileCalls.add(calleeNode.text);
            }
            break;
    }

    // Processar nós filhos
    for (let i = 0; i < node.childCount; i++) {
        processNode(node.child(i), context);
    }
}
