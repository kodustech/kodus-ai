/**
 * Opções para análise de arquivo de código
 */
export interface ParserOptions {
  /** Caminho do arquivo a ser analisado */
  readonly filePath: string;
  /** Caminho normalizado do arquivo */
  readonly normalizedPath: string;
  /** Conteúdo do arquivo */
  readonly content: string;
}

/**
 * Resultado da análise de um arquivo
 */
export interface AnalysisResult {
  /** Análise do arquivo contendo definições, chamadas e importações */
  fileAnalysis: {
    defines: string[];
    calls: string[];
    imports: string[];
  };
  /** Mapa de funções analisadas */
  functions: Record<string, any> | Map<string, any>;
  /** Mapa de tipos analisados */
  types: Record<string, any> | Map<string, any>;
}
