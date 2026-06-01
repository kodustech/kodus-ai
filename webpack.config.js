const fs = require('fs');
const path = require('path');
const nodeExternals = require('webpack-node-externals');
const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin');
const { RunScriptWebpackPlugin } = require('run-script-webpack-plugin');
const { sourceMapsEnabled } = require('process');

const copyDir = (sourceDir, targetDir, options = {}) => {
    const { skip } = options;
    if (!fs.existsSync(sourceDir)) {
        return;
    }

    fs.mkdirSync(targetDir, { recursive: true });

    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);

        if (entry.isDirectory()) {
            copyDir(sourcePath, targetPath, options);
        } else {
            if (skip && skip(entry.name)) continue;
            fs.copyFileSync(sourcePath, targetPath);
        }
    }
};

class CopyDictionariesPlugin {
    apply(compiler) {
        compiler.hooks.afterEmit.tap('CopyDictionariesPlugin', () => {
            const sourceDir = path.resolve(
                __dirname,
                'libs/common/utils/translations/dictionaries',
            );
            const targetDir = path.resolve(__dirname, 'dist', 'dictionaries');

            copyDir(sourceDir, targetDir);
        });
    }
}

// SkillLoaderService reads SKILL.md (and reference files alongside it)
// from `libs/agents/skills/<slug>/`. In runtime, `__dirname` resolves to
// `dist/libs/agents/skills/`, so the .md assets need to live there too.
// Webpack only emits .js for TS sources, so without this plugin every
// non-TS asset (SKILL.md, references/, etc.) is missing in the runtime
// image and the loader fails with `could not resolve file 'SKILL.md'`.
// `nest-cli.json -> assets` is ignored when `builder: webpack`, which is
// why the dictionaries (above) and now skills both go through afterEmit.
class CopySkillsPlugin {
    apply(compiler) {
        compiler.hooks.afterEmit.tap('CopySkillsPlugin', () => {
            const sourceDir = path.resolve(__dirname, 'libs/agents/skills');
            const targetDir = path.resolve(
                __dirname,
                'dist',
                'libs/agents/skills',
            );

            // Skip TypeScript sources — webpack already compiled the
            // ones we need into the bundle. Anything else (.md, .json,
            // references/) is a runtime asset and must be copied.
            copyDir(sourceDir, targetDir, {
                skip: (name) => name.endsWith('.ts') || name.endsWith('.tsx'),
            });
        });
    }
}

module.exports = function (options, webpack) {
    // Detect watch mode from BOTH the options field (set by `nest start
    // --watch`) and the CLI argv (set by `nest build --watch`). Nest CLI
    // doesn't populate options.watch in the build path, so we'd silently
    // skip the dev plugin block if we relied on it alone.
    const isWatchMode =
        Boolean(options.watch) || process.argv.includes('--watch');
    const isNestCliStart = process.env.NEST_CLI_START === 'true';
    const isProduction = process.env.NODE_ENV === 'production';
    const debugPort = process.env.DEBUG_PORT || 9229;
    const debugBreak = process.env.DEBUG_BREAK === 'true';
    const inspectArg = debugBreak ? '--inspect-brk' : '--inspect';
    const devtool = isWatchMode
        ? 'eval-source-map'
        : isProduction
          ? 'hidden-source-map'
          : 'source-map';

    const plugins = [...options.plugins];
    plugins.push(new CopyDictionariesPlugin());
    plugins.push(new CopySkillsPlugin());

    // Only run the compiled output (and enable HMR) in watch mode.
    // In CI/Docker builds we only want to compile, not start the app.
    if (isWatchMode) {
        plugins.push(
            new webpack.HotModuleReplacementPlugin(),
            new webpack.WatchIgnorePlugin({
                paths: [/\.js$/, /\.d\.ts$/],
            }),
        );

        if (!isNestCliStart) {
            // `name` must match the webpack entrypoint name. Nest CLI's
            // monorepo build sets the entrypoint name to the
            // path-prefixed output filename (e.g. "apps/api/main.js"),
            // NOT webpack's usual default of "main". options.output
            // .filename happens to be that same string per-project,
            // which makes this work for api/webhooks/worker uniformly.
            plugins.push(
                new RunScriptWebpackPlugin({
                    name: options.output.filename,
                    autoRestart: false,
                    nodeArgs: [`${inspectArg}=0.0.0.0:${debugPort}`],
                }),
            );
        }
    }

    return {
        ...options,
        stats: 'errors-warnings',
        devtool,
        optimization: {
            ...options.optimization,
            moduleIds: 'named',
        },
        cache: {
            type: 'filesystem',
            version: '1',
            buildDependencies: {
                config: [__filename],
            },
        },
        externals: [
            nodeExternals({
                allowlist: [],
            }),
        ],
        output: {
            ...options.output,
            devtoolModuleFilenameTemplate: (info) => {
                return info.absoluteResourcePath.replace(/\\/g, '/');
            },
        },
        resolve: {
            plugins: [
                new TsconfigPathsPlugin({ configFile: './tsconfig.json' }),
            ],
            extensions: ['.ts', '.tsx', '.js', '.json'],
        },
        plugins,
        watchOptions: {
            aggregateTimeout: 300,
            poll: process.env.CHOKIDAR_USEPOLLING === 'true' ? 3000 : false,
            ignored: /node_modules/,
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    use: [
                        {
                            loader: 'swc-loader',
                            options: {
                                jsc: {
                                    target: 'es2022',
                                    parser: {
                                        syntax: 'typescript',
                                        decorators: true,
                                        dynamicImport: true,
                                    },
                                    transform: {
                                        legacyDecorator: true,
                                        decoratorMetadata: true,
                                    },
                                    keepClassNames: true,
                                },
                            },
                        },
                    ],
                    exclude: /node_modules/,
                },
            ],
        },
    };
};
