import { AnalysisResult, ParserOptions } from './types';

/**
 * Classe base para parsers de linguagens
 */
export abstract class BaseParser {
  /**
   * Configura o parser especu00edfico da linguagem
   */
  protected abstract setupParser(): any;
  
  /**
   * Analisa um arquivo de cu00f3digo
   * @param options Opu00e7u00f5es de anu00e1lise
   * @returns Resultado da anu00e1lise
   */
  public analyze(options: ParserOptions): AnalysisResult {
    const { content, filePath, normalizedPath } = options;
    
    // Configura o parser especu00edfico da linguagem
    const parser = this.setupParser();
    
    // Faz o parsing
    const syntaxTree = parser.parse(content);
    
    // Processa a u00e1rvore - implementado por cada parser especu00edfico
    return this.processTree(syntaxTree, content, filePath, normalizedPath);
  }
  
  /**
   * Processa a u00e1rvore sintu00e1tica
   * @param tree u00c1rvore sintu00e1tica
   * @param content Conteu00fado do arquivo
   * @param filePath Caminho do arquivo
   * @param normalizedPath Caminho normalizado
   * @returns Resultado da anu00e1lise
   */
  protected abstract processTree(
    tree: any, 
    content: string, 
    filePath: string, 
    normalizedPath: string
  ): AnalysisResult;
}
