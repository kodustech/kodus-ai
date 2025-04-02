import { AliasConfig, LanguageResolver } from '../contracts/LanguageResolver';
import * as fs from 'fs';
import * as path from 'path';

interface PackageJson {
    imports?: Record<string, string>;
    _moduleAliases?: Record<string, string>;
    jest?: {
        moduleNameMapper?: Record<string, string>;
    };
}

export class JavaScriptResolver implements LanguageResolver {
    private projectRoot: string;
    private moduleDirectories: string[] = ['node_modules'];
    private aliases: Record<string, AliasConfig> = {};

    async canHandle(projectRoot: string): Promise<boolean> {
        this.projectRoot = projectRoot;
        try {
            const packageJsonPath = path.join(projectRoot, 'package.json');
            await fs.promises.access(packageJsonPath, fs.constants.R_OK);
            await this.readPackageJson(packageJsonPath);
            return true;
        } catch {
            return false;
        }
    }

    private async readPackageJson(packageJsonPath: string): Promise<void> {
        try {
            const content = await fs.promises.readFile(packageJsonPath, 'utf8');
            const packageJson: PackageJson = JSON.parse(content);

            // Processa imports do package.json
            if (packageJson.imports) {
                Object.entries(packageJson.imports).forEach(
                    ([pattern, target]) => {
                        this.aliases[pattern] = {
                            pattern,
                            target: path.join(this.projectRoot, target),
                        };
                    },
                );
            }

            // Processa module-alias se existir
            if (packageJson._moduleAliases) {
                Object.entries(packageJson._moduleAliases).forEach(
                    ([pattern, target]) => {
                        this.aliases[pattern] = {
                            pattern,
                            target: path.join(this.projectRoot, target),
                        };
                    },
                );
            }

            // Processa moduleNameMapper do Jest se existir
            if (packageJson.jest?.moduleNameMapper) {
                Object.entries(packageJson.jest.moduleNameMapper).forEach(
                    ([pattern, target]) => {
                        // Remove regex do padrão do Jest
                        const cleanPattern = pattern
                            .replace(/^\^/, '')
                            .replace(/\$/, '');
                        this.aliases[cleanPattern] = {
                            pattern: cleanPattern,
                            target: path.join(this.projectRoot, target),
                        };
                    },
                );
            }
        } catch (error) {
            console.error('Error reading/parsing package.json:', error);
            this.aliases = {};
        }
    }

    async readAliasConfig(
        projectRoot: string,
    ): Promise<Record<string, AliasConfig>> {
        return this.aliases;
    }

    getPriority(): number {
        return 90;
    }

    isExternalModule(importPath: string): boolean {
        // Se é caminho relativo ou absoluto, é interno
        if (importPath.startsWith('.') || importPath.startsWith('/')) {
            return false;
        }

        // Verifica se corresponde a algum alias
        if (
            Object.keys(this.aliases).some((alias) =>
                importPath.startsWith(alias),
            )
        ) {
            return false;
        }

        // Verifica se existe no projeto
        try {
            const fullPath = path.join(this.projectRoot, importPath);
            return !fs.existsSync(fullPath);
        } catch {
            return true;
        }
    }

    private async tryResolveFile(basePath: string): Promise<string | null> {
        const extensions = ['.js', '.jsx', '.mjs', '.cjs'];

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

        // Processa aliases
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
