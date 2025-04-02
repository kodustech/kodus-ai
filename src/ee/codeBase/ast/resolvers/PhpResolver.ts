import { AliasConfig, LanguageResolver } from '../contracts/LanguageResolver';
import * as fs from 'fs';
import * as path from 'path';

interface ComposerJson {
    name?: string;
    autoload?: {
        'psr-4'?: Record<string, string | string[]>;
        'psr-0'?: Record<string, string | string[]>;
        classmap?: string[];
    };
}

export class PhpResolver implements LanguageResolver {
    private projectRoot: string;
    private moduleDirectories: string[] = ['vendor'];
    private aliases: Record<string, AliasConfig> = {};
    private psr4Map: Record<string, string[]> = {};

    async canHandle(projectRoot: string): Promise<boolean> {
        this.projectRoot = projectRoot;
        try {
            const composerPath = path.join(projectRoot, 'composer.json');
            await fs.promises.access(composerPath, fs.constants.R_OK);
            await this.readComposerJson(composerPath);
            return true;
        } catch {
            return false;
        }
    }

    private async readComposerJson(composerPath: string): Promise<void> {
        try {
            const content = await fs.promises.readFile(composerPath, 'utf8');
            const composer: ComposerJson = JSON.parse(content);

            // Processa PSR-4 autoload
            if (composer.autoload?.['psr-4']) {
                Object.entries(composer.autoload['psr-4']).forEach(([namespace, paths]) => {
                    const targetPaths = Array.isArray(paths) ? paths : [paths];
                    this.psr4Map[namespace] = targetPaths.map(p => 
                        path.join(this.projectRoot, p)
                    );

                    // Adiciona como alias também
                    const cleanNamespace = namespace.replace(/\\$/, '');
                    this.aliases[cleanNamespace] = {
                        pattern: cleanNamespace,
                        target: path.join(this.projectRoot, Array.isArray(paths) ? paths[0] : paths)
                    };
                });
            }

            // Processa PSR-0 autoload (legado)
            if (composer.autoload?.['psr-0']) {
                Object.entries(composer.autoload['psr-0']).forEach(([namespace, paths]) => {
                    const targetPaths = Array.isArray(paths) ? paths : [paths];
                    const cleanNamespace = namespace.replace(/\\$/, '');
                    this.aliases[cleanNamespace] = {
                        pattern: cleanNamespace,
                        target: path.join(this.projectRoot, Array.isArray(paths) ? paths[0] : paths)
                    };
                });
            }

        } catch (error) {
            console.error('Error reading/parsing composer.json:', error);
            this.aliases = {};
            this.psr4Map = {};
        }
    }

    async readAliasConfig(projectRoot: string): Promise<Record<string, AliasConfig>> {
        return this.aliases;
    }

    getPriority(): number {
        return 70;
    }

    isExternalModule(importPath: string): boolean {
        // Se começa com namespace conhecido do PSR-4
        const namespace = Object.keys(this.psr4Map).find(ns => 
            importPath.startsWith(ns.replace(/\\$/, ''))
        );
        if (namespace) {
            return false;
        }

        // Se é um caminho relativo
        if (importPath.startsWith('.') || importPath.startsWith('/')) {
            return false;
        }

        return true;
    }

    private async tryResolveFile(basePath: string): Promise<string | null> {
        const extensions = ['.php'];
        
        // Primeiro tenta o caminho exato
        if (fs.existsSync(basePath)) {
            const stats = fs.statSync(basePath);
            if (stats.isFile()) {
                return basePath;
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

    async resolveModulePath(importPath: string, fromFile: string): Promise<string> {
        if (this.isExternalModule(importPath)) {
            return importPath;
        }

        // Se é um namespace PSR-4
        const namespace = Object.keys(this.psr4Map).find(ns => 
            importPath.startsWith(ns.replace(/\\$/, ''))
        );

        if (namespace) {
            // Remove o namespace do início e converte para path
            const relativePath = importPath
                .slice(namespace.length)
                .replace(/\\/g, '/');

            // Tenta cada diretório base do namespace
            for (const baseDir of this.psr4Map[namespace]) {
                const fullPath = path.join(baseDir, relativePath);
                const resolved = await this.tryResolveFile(fullPath);
                if (resolved) {
                    return resolved;
                }
            }
        }

        // Se é um caminho relativo
        if (importPath.startsWith('.')) {
            const resolvedPath = path.resolve(path.dirname(fromFile), importPath);
            const resolved = await this.tryResolveFile(resolvedPath);
            if (resolved) {
                return resolved;
            }
            return resolvedPath;
        }

        // Se não conseguiu resolver, retorna o caminho original
        return importPath;
    }

    getModuleDirectories(): string[] {
        return this.moduleDirectories;
    }

    getAliasMap(): Record<string, string> {
        return Object.fromEntries(
            Object.entries(this.aliases).map(([pattern, config]) => [pattern, config.target])
        );
    }
}
