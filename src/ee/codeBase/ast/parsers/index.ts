import { BaseParser } from './base/parser-base';
import { TypeScriptParser } from './typescript/typescript-parser';
import { JavaScriptParser } from './javascript/javascript-parser';
import * as path from 'path';

/**
 * Mapa de parsers por extensão de arquivo
 */
export const parsersByExtension: Record<string, BaseParser> = {
  '.ts': new TypeScriptParser(),
  '.tsx': new TypeScriptParser(),
  '.js': new JavaScriptParser(),
  '.jsx': new JavaScriptParser(),
  // Adicionar outros parsers conforme necessário
};

/**
 * Obtém o parser apropriado para um arquivo
 * @param filePath Caminho do arquivo
 * @returns Parser apropriado para o tipo de arquivo
 */
export function getParserForFile(filePath: string): BaseParser {
  const extension = path.extname(filePath).toLowerCase();
  return parsersByExtension[extension] || parsersByExtension['.ts']; // TypeScript como fallback
}
