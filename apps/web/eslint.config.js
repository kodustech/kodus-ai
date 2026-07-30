// eslint.config.js — ESLint 10 flat config.
//
// Configs flat-native são espalhadas diretamente (NÃO via FlatCompat): o
// `next/core-web-vitals` do eslint-config-next 16 é um flat config que traz o
// eslint-plugin-react com refs circulares — passá-lo pelo FlatCompat quebra o
// validador legado ("Converting circular structure to JSON"). FlatCompat fica
// só para o `standard`, que ainda é eslintrc.
import { FlatCompat } from "@eslint/eslintrc";
import globals from "globals";
import tseslint from "typescript-eslint";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import prettierRecommended from "eslint-plugin-prettier/recommended";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
    ...nextCoreWebVitals,
    ...tseslint.configs.recommended,
    ...compat.extends("standard"),
    // prettier/recommended por ÚLTIMO entre os presets: desliga as regras de
    // formatação (indent/quotes/semi) do standard que conflitam com o Prettier
    // do projeto (4 espaços, aspas duplas, ponto-e-vírgula).
    prettierRecommended,
    {
        // Fixa a versão do React em vez de deixar o eslint-plugin-react
        // auto-detectar: a detecção chama `context.getFilename()`, removido no
        // ESLint 10, o que quebra o lint. Com a versão explícita o plugin pula
        // esse caminho e roda no ESLint 10.
        settings: {
            react: {
                version: "19.2",
            },
        },
    },
    {
        files: ["**/*.{js,ts,tsx}"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            parser: tseslint.parser,
            parserOptions: {
                ecmaFeatures: {
                    jsx: true,
                },
            },
            globals: {
                ...globals.browser,
                ...globals.es2021,
                ...globals.jest,
            },
        },
        // jsx-a11y é registrado pelo next/core-web-vitals (as regras jsx-a11y
        // abaixo usam o plugin do next). O eslint-plugin-tailwindcss foi
        // deixado de fora: exige um CSS-entry (Tailwind v4 é CSS-first) que não
        // está configurado, e já estava efetivamente desligado antes
        // (recommended comentado + regra num glob que não casava src/). Religar
        // o class-order lint do tailwind é tarefa à parte (settings.cssFiles).
        rules: {
            "prettier/prettier": "error",
        },
    },
    {
        files: ["**/*.js"],
        rules: {
            // renomeada no typescript-eslint 8 (era no-var-requires)
            "@typescript-eslint/no-require-imports": "off",
        },
    },
    {
        files: ["**/*.ts", "**/*.tsx"],
        rules: {
            "@next/next/no-html-link-for-pages": "off",
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "@typescript-eslint/no-empty-function": "warn",
            // ban-types foi removida no v8; os substitutos já vêm no recommended
            "@typescript-eslint/ban-ts-comment": "warn",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    ignoreRestSiblings: true,
                    argsIgnorePattern: "^_",
                    destructuredArrayIgnorePattern: "^_",
                },
            ],
            "jsx-a11y/alt-text": [
                "warn",
                {
                    elements: ["img"],
                    img: ["Image"],
                },
            ],
            "jsx-a11y/aria-props": "warn",
            "jsx-a11y/aria-proptypes": "warn",
            "jsx-a11y/aria-unsupported-elements": "warn",
            "jsx-a11y/role-has-required-aria-props": "warn",
            "jsx-a11y/role-supports-aria-props": "warn",
        },
    },
    {
        files: ["**/ui/**/*.tsx", "**/components/**/*.tsx"],
        rules: {
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@next/next/no-html-link-for-pages": "off",
        },
    },
];
