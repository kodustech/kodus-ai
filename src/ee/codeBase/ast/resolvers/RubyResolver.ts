import { AliasConfig, LanguageResolver } from '../contracts/LanguageResolver';
import * as fs from 'fs';
import * as path from 'path';

interface GemSpec {
    name?: string;
    require_paths?: string[];
}

export class RubyResolver implements LanguageResolver {
    private projectRoot: string;
    private moduleDirectories: string[] = ['lib', 'vendor/bundle'];
    private aliases: Record<string, AliasConfig> = {};
    private loadPaths: string[] = [];

    async canHandle(projectRoot: string): Promise<boolean> {
        this.projectRoot = projectRoot;
        try {
            console.log('RubyResolver.canHandle - Checking directory:', projectRoot);
            
            // Verifica se o diretório existe
            if (!fs.existsSync(projectRoot)) {
                console.log('RubyResolver.canHandle - Directory does not exist');
                return false;
            }

            const files = await fs.promises.readdir(projectRoot);
            console.log('RubyResolver.canHandle - Files found:', files);
            
            const hasRubyFiles = files.some(file => 
                ['Gemfile', '.gemspec', 'lib'].includes(file)
            );
            console.log('RubyResolver.canHandle - Has Ruby files:', hasRubyFiles);

            if (hasRubyFiles) {
                await this.readProjectConfig();
                return true;
            }
            return false;
        } catch (error) {
            console.error('RubyResolver.canHandle - Error:', error);
            return false;
        }
    }

    private async readProjectConfig(): Promise<void> {
        try {
            // Adiciona lib/ ao LOAD_PATH
            const libDir = path.join(this.projectRoot, 'lib');
            if (fs.existsSync(libDir)) {
                this.loadPaths.push(libDir);
            }

            // Procura por .gemspec
            const files = await fs.promises.readdir(this.projectRoot);
            const gemspecFile = files.find(f => f.endsWith('.gemspec'));
            if (gemspecFile) {
                const content = await fs.promises.readFile(
                    path.join(this.projectRoot, gemspecFile),
                    'utf8'
                );

                // Extrai require_paths do .gemspec
                // Note: Isso é uma simplificação, idealmente precisaríamos de um parser Ruby
                const requirePaths = content.match(/require_paths\s*=\s*\[(.*?)\]/)?.[1]
                    ?.split(',')
                    ?.map(p => p.trim().replace(/['"]/g, ''))
                    ?? ['lib'];

                requirePaths.forEach(p => {
                    const fullPath = path.join(this.projectRoot, p);
                    if (fs.existsSync(fullPath)) {
                        this.loadPaths.push(fullPath);
                    }
                });
            }

            // Configura aliases básicos
            const projectName = path.basename(this.projectRoot);
            this.aliases[projectName] = {
                pattern: projectName,
                target: path.join(this.projectRoot, 'lib')
            };

        } catch (error) {
            console.error('Error reading Ruby project configuration:', error);
        }
    }

    async readAliasConfig(projectRoot: string): Promise<Record<string, AliasConfig>> {
        return this.aliases;
    }

    getPriority(): number {
        return 60;
    }

    isExternalModule(importPath: string): boolean {
        // Se é um caminho relativo
        if (importPath.startsWith('.') || importPath.startsWith('/')) {
            return false;
        }

        // Se existe em algum dos LOAD_PATH
        const exists = this.loadPaths.some(dir => {
            const possiblePath = path.join(dir, `${importPath}.rb`);
            return fs.existsSync(possiblePath);
        });

        return !exists;
    }

    private async tryResolveFile(basePath: string): Promise<string | null> {
        // Ruby usa .rb como extensão padrão
        const extensions = ['.rb'];
        
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

        // Se é um caminho relativo
        if (importPath.startsWith('.')) {
            const fromDir = path.dirname(fromFile);
            const resolvedPath = path.resolve(fromDir, importPath);
            const resolved = await this.tryResolveFile(resolvedPath);
            if (resolved) {
                return resolved;
            }
            return resolvedPath;
        }

        // Procura em todos os LOAD_PATH
        for (const loadPath of this.loadPaths) {
            const possiblePath = path.join(loadPath, importPath);
            const resolved = await this.tryResolveFile(possiblePath);
            if (resolved) {
                return resolved;
            }
        }

        // Se não encontrou, retorna o caminho original
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
