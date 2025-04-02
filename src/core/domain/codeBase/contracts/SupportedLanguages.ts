export type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'java' | 'go' | 'ruby' | 'php';

export interface LanguageConfig {
    name: SupportedLanguage;
    extensions: string[];
    defaultExtension: string;
}

export const SUPPORTED_LANGUAGES: Record<SupportedLanguage, LanguageConfig> = {
    typescript: {
        name: 'typescript',
        extensions: ['.ts', '.tsx'],
        defaultExtension: '.ts'
    },
    javascript: {
        name: 'javascript',
        extensions: ['.js', '.jsx'],
        defaultExtension: '.js'
    },
    python: {
        name: 'python',
        extensions: ['.py'],
        defaultExtension: '.py'
    },
    java: {
        name: 'java',
        extensions: ['.java'],
        defaultExtension: '.java'
    },
    go: {
        name: 'go',
        extensions: ['.go'],
        defaultExtension: '.go'
    },
    ruby: {
        name: 'ruby',
        extensions: ['.rb'],
        defaultExtension: '.rb'
    },
    php: {
        name: 'php',
        extensions: ['.php'],
        defaultExtension: '.php'
    }
};
