import { AliasConfig, LanguageResolver } from '../contracts/LanguageResolver';
import * as fs from 'fs';
import * as path from 'path';

interface PyProjectConfig {
    tool?: {
        poetry?: {
            name?: string;
            packages?: string[];
        };
    };
    project?: {
        name?: string;
    };
}

export class PythonResolver implements LanguageResolver {
    private projectRoot: string;
    private moduleDirectories: string[] = ['site-packages', 'dist-packages'];
    private aliases: Record<string, AliasConfig> = {};
    private pythonPath: string[] = [];

    async canHandle(projectRoot: string): Promise<boolean> {
        this.projectRoot = projectRoot;
        try {
            const files = await fs.promises.readdir(projectRoot);
            const hasConfig = files.some(file => 
                ['setup.py', 'pyproject.toml', 'requirements.txt'].includes(file)
            );

            if (hasConfig) {
                await this.readProjectConfig();
                return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    private async readProjectConfig(): Promise<void> {
        try {
            // Tenta ler pyproject.toml primeiro
            const pyprojectPath = path.join(this.projectRoot, 'pyproject.toml');
            if (fs.existsSync(pyprojectPath)) {
                const content = await fs.promises.readFile(pyprojectPath, 'utf8');
                // TODO: Usar biblioteca TOML para parse adequado
                // Por enquanto, procura por padrões comuns
                const packageDirs = content.match(/packages\s*=\s*\[(.*?)\]/)?.[1]
                    ?.split(',')
                    ?.map(dir => dir.trim().replace(/['"]/g, ''))
                    ?? ['src'];

                packageDirs.forEach(dir => {
                    const fullPath = path.join(this.projectRoot, dir);
                    if (fs.existsSync(fullPath)) {
                        this.pythonPath.push(fullPath);
                    }
                });
            }

            // Procura por src/ ou nome_do_projeto/
            const srcDir = path.join(this.projectRoot, 'src');
            if (fs.existsSync(srcDir)) {
                this.pythonPath.push(srcDir);
            }

            // Adiciona o diretório raiz do projeto
            this.pythonPath.push(this.projectRoot);

            // Configura aliases básicos
            const projectName = path.basename(this.projectRoot);
            this.aliases[projectName] = {
                pattern: projectName,
                target: this.projectRoot
            };

        } catch (error) {
            console.error('Error reading Python project configuration:', error);
        }
    }

    async readAliasConfig(projectRoot: string): Promise<Record<string, AliasConfig>> {
        return this.aliases;
    }

    getPriority(): number {
        return 80;
    }

    isExternalModule(importPath: string): boolean {
        // Módulos da stdlib Python
        const stdlibModules = ['os', 'sys', 'json', 'datetime', 'pathlib', 'typing'];
        const firstPart = importPath.split('.')[0];

        // Se é um módulo da stdlib
        if (stdlibModules.includes(firstPart)) {
            return true;
        }

        // Se é um caminho relativo
        if (importPath.startsWith('.')) {
            return false;
        }

        // Verifica se existe no PYTHONPATH
        return !this.pythonPath.some(dir => {
            const possiblePath = path.join(dir, ...importPath.split('.'));
            return fs.existsSync(possiblePath) || fs.existsSync(possiblePath + '.py');
        });
    }

    private async tryResolveFile(basePath: string): Promise<string | null> {
        // Python permite imports sem extensão e como diretórios com __init__.py
        
        // Tenta o arquivo diretamente
        const pyFile = basePath + '.py';
        if (fs.existsSync(pyFile)) {
            return pyFile;
        }

        // Tenta como pacote (diretório com __init__.py)
        if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
            const initFile = path.join(basePath, '__init__.py');
            if (fs.existsSync(initFile)) {
                return initFile;
            }
        }

        return null;
    }

    async resolveModulePath(importPath: string, fromFile: string): Promise<string> {
        if (this.isExternalModule(importPath)) {
            return importPath;
        }

        // Se é um import relativo
        if (importPath.startsWith('.')) {
            const fromDir = path.dirname(fromFile);
            const normalizedPath = importPath.replace(/^\.+/, (dots) => {
                // Sobe um nível para cada ponto depois do primeiro
                const levels = dots.length - 1;
                return '../'.repeat(levels);
            });
            
            const absolutePath = path.resolve(fromDir, normalizedPath);
            const resolved = await this.tryResolveFile(absolutePath);
            if (resolved) {
                return resolved;
            }
            return absolutePath;
        }

        // Procura em todos os caminhos do PYTHONPATH
        for (const baseDir of this.pythonPath) {
            const possiblePath = path.join(baseDir, ...importPath.split('.'));
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
