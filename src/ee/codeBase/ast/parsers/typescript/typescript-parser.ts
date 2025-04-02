import { BaseParser } from '../base/parser-base';
import { AnalysisResult } from '../base/types';

/**
 * Parser para arquivos TypeScript
 */
export class TypeScriptParser extends BaseParser {
  /**
   * Configura o parser para TypeScript
   */
  protected setupParser(): any {
    const treeSitter = require('tree-sitter');
    const parser = new treeSitter();
    parser.setLanguage(require('tree-sitter-typescript').typescript);
    return parser;
  }
  
  /**
   * Processa a árvore sintática de um arquivo TypeScript
   */
  protected processTree(
    tree: any, 
    content: string, 
    filePath: string, 
    normalizedPath: string
  ): AnalysisResult {
    // Implementação específica para TypeScript
    // Aqui precisaríamos migrar a lógica do método analyzeSourceFile
    
    // Contexto para análise
    const context = {
      fileDefines: new Set<string>(),
      fileImports: new Set<string>(),
      fileClassNames: new Set<string>(),
      fileCalls: new Set<string>(),
      // Outros elementos conforme necessário
    };
    
    // Processamento da árvore
    // Versão simplificada do processamento - a implementação completa
    // requereria migrar toda a lógica do método analyzeSourceFile
    const rootNode = tree.rootNode;
    
    // Verificar por importações
    const importNodes = this.findNodesByType(rootNode, ['import_statement', 'import_declaration']);
    for (const node of importNodes) {
      const importText = node.text;
      if (importText) {
        context.fileImports.add(importText.trim());
      }
    }
    
    // Verificar por classes
    const classNodes = this.findNodesByType(rootNode, ['class_declaration']);
    for (const node of classNodes) {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const className = nameNode.text;
        context.fileDefines.add(className);
        context.fileClassNames.add(className);
      }
    }
    
    // Verificar por funções
    const functionNodes = this.findNodesByType(rootNode, [
      'function_declaration',
      'method_definition',
      'arrow_function'
    ]);
    
    for (const node of functionNodes) {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        context.fileDefines.add(nameNode.text);
      }
    }
    
    // Retorno dos resultados
    return {
      fileAnalysis: {
        defines: Array.from(context.fileDefines),
        calls: Array.from(context.fileCalls),
        imports: Array.from(context.fileImports)
      },
      functions: new Map(),
      types: new Map()
    };
  }
  
  /**
   * Encontra nós pelo tipo
   * @param rootNode Nó raiz
   * @param nodeTypes Tipos de nó a serem encontrados
   * @returns Lista de nós encontrados
   */
  private findNodesByType(rootNode: any, nodeTypes: string[]): any[] {
    const result: any[] = [];
    const cursor = rootNode.walk();
    
    const visitNode = () => {
      const node = cursor.currentNode();
      if (nodeTypes.includes(node.type)) {
        result.push(node);
      }
      
      if (cursor.gotoFirstChild()) {
        do {
          visitNode();
        } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };
    
    visitNode();
    return result;
  }
}
