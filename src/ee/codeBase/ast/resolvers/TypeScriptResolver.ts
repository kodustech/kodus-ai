import { AliasConfig, LanguageResolver } from '../contracts/LanguageResolver';
import * as fs from 'fs';
import * as path from 'path';
import * as stripJsonComments from 'strip-json-comments';

interface TsConfig {
    compilerOptions?: {
        paths?: Record<string, string[]>;
        baseUrl?: string;
    };
}

export class TypeScriptResolver implements LanguageResolver {
    private projectRoot: string;
    private moduleDirectories = ['node_modules'];
    private aliases: Record<string, AliasConfig> = {};

    async canHandle(projectRoot: string): Promise<boolean> {
        this.projectRoot = projectRoot;
        try {
            const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
            await fs.promises.access(tsconfigPath, fs.constants.R_OK);
            await this.readTsConfig(tsconfigPath);
            return true;
        } catch (error) {
            console.error('Error in canHandle:', error);
            return false;
        }
    }

    private async readTsConfig(tsconfigPath: string): Promise<void> {
        try {
            let content = await fs.promises.readFile(tsconfigPath, 'utf8');
            // Limpa o conteúdo
            content = stripJsonComments(content) as string;
            content = content
                .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
                .replace(/\s+/g, ' ') // Normaliza espaços
                .trim();

            try {
                const tsconfig: TsConfig = JSON.parse(content);

                const paths = tsconfig.compilerOptions?.paths || {};
                const baseUrl = tsconfig.compilerOptions?.baseUrl || '.';

                // Lê todos os padrões de paths do tsconfig
                for (const [pattern, targets] of Object.entries(paths)) {
                    if (targets && targets.length > 0) {
                        const cleanPattern = pattern.replace(/\/\*$/, '');
                        const target = targets[0].replace(/\/\*$/, '');
                        this.aliases[cleanPattern] = {
                            pattern,
                            target: path.join(
                                this.projectRoot,
                                baseUrl,
                                target,
                            ),
                        };
                    }
                }
            } catch (parseError) {
                console.error('Error parsing tsconfig.json:', parseError);
                console.log('Content that failed to parse:', content);
                throw parseError; // Re-throw para ser capturado pelo catch externo
            }
        } catch (error) {
            console.error('Error reading/parsing tsconfig.json:', error);
            this.aliases = {}; // Reset aliases em caso de erro
        }
    }

    async readAliasConfig(
        projectRoot: string,
    ): Promise<Record<string, AliasConfig>> {
        return this.aliases;
    }

    getPriority(): number {
        return 100;
    }

    isExternalModule(importPath: string): boolean {
        // If it's a relative or absolute path, it's internal
        if (importPath.startsWith('.') || importPath.startsWith('/')) {
            return false;
        }

        // Check if it matches any of our aliases
        if (
            Object.keys(this.aliases).some((alias) =>
                importPath.startsWith(alias),
            )
        ) {
            return false;
        }

        // Check if it exists in our project
        try {
            const fullPath = path.join(this.projectRoot, importPath);
            return !fs.existsSync(fullPath);
        } catch {
            // If we can't resolve it, assume it's external
            return true;
        }
    }

    private async tryResolveFile(basePath: string): Promise<string | null> {
        // Extensões comuns em projetos TypeScript
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.d.ts'];

        // Primeiro tenta o caminho exato
        if (fs.existsSync(basePath)) {
            const stats = fs.statSync(basePath);
            if (stats.isFile()) {
                return basePath;
            }
            // Se for diretório, tenta index files
            if (stats.isDirectory()) {
                for (const ext of extensions) {
                    const indexPath = path.join(basePath, `index${ext}`);
                    if (fs.existsSync(indexPath)) {
                        return indexPath;
                    }
                }
            }
        }

        // Tenta com cada extensão
        for (const ext of extensions) {
            const pathWithExt = `${basePath}${ext}`;
            if (fs.existsSync(pathWithExt)) {
                return pathWithExt;
            }
        }

        return null;
    }

    async resolveModulePath(
        importPath: string,
        fromFile: string,
    ): Promise<string> {
        if (this.isExternalModule(importPath)) {
            return importPath;
        }

        // Handle aliases
        const matchingAlias = Object.entries(this.aliases).find(([pattern]) =>
            importPath.startsWith(pattern),
        );

        let resolvedPath: string;
        if (matchingAlias) {
            const [pattern, config] = matchingAlias;
            const relativePath = importPath.slice(pattern.length);
            resolvedPath = path.join(config.target, relativePath);
        } else {
            resolvedPath = path.resolve(path.dirname(fromFile), importPath);
        }

        // Tenta resolver com extensões
        const fullPath = await this.tryResolveFile(resolvedPath);
        if (fullPath) {
            return fullPath;
        }

        return resolvedPath;
    }

    getModuleDirectories(): string[] {
        return this.moduleDirectories;
    }

    getAliasMap(): Record<string, string> {
        return Object.fromEntries(
            Object.entries(this.aliases).map(([pattern, config]) => [
                pattern,
                config.target,
            ]),
        );
    }
}
