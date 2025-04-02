import { isFileMatchingGlob } from '@/shared/utils/glob-utils';
import * as globalPathsJsonFile from '@/shared/utils/codeBase/ignorePaths/generated/paths.json';

describe('ignorePaths', () => {
    const globalFilePaths = globalPathsJsonFile.paths;
    let errors: string[] = [];

    beforeEach(() => {
        errors = [];
    });

    const errorHelper = (
        testFiles: string[],
        expected: boolean = true,
        patterns: string[] = globalFilePaths,
    ) => {
        testFiles.forEach((file) => {
            try {
                expect(isFileMatchingGlob(file, patterns)).toBe(expected);
            } catch {
                errors.push(`The file ${file} did not pass the test.`);
            }
        });

        try {
            expect(errors.length).toBe(0);
        } catch {
            throw new Error(
                `The following errors occurred:\n${errors.join('\n')}`,
            );
        }
    };

    it('should not skip language files', () => {
        const testFiles = [
            'test.js',
            'test.jsx',
            'test.ts',
            'test.tsx',
            'test.svelte',
            'test.vue',
            'test.angular',
            'test.py',
            'test.java',
            'test.rb',
            'test.php',
            'test.go',
            'test.swift',
            'test.c',
            'test.cpp',
            'test.cs',
            'test.rs',
            'test.kt',
            'test.html',
            'test.css',
            'test.sh',
            'test.bash',
            'test.pl',
            'test.r',
            'test.lua',
            'test.dart',
            'test.vb',
            'test.zig',
            'test.asm',
            'test.m',
            'test.ml',
            'test.clj',
            'test.elm',
            'test.scala',
            'test.groovy',
            'test.f90',
            'test.f95',
        ];

        errorHelper(testFiles, false);
    });

    it('should skip version managment files', () => {
        const testFiles = [
            'package.json',
            'yarn.lock',
            'Pipfile',
            'requirements.txt',
            'pyproject.toml',
            'environment',
            'Gemfile',
            'gemspec',
            'csproj',
            'sln',
            'pom.xml',
            'build.gradle',
            'gradle',
            'lock',
            'setup.py',
            'environment.yml',
            'terraform',
            'ansible',
            'bazel',
            'helm',
            'xcodeproj',
            'vscode',
            'xcworkspace',
            'docker-compose.yml',
            'terraform.tfstate',
            'terraform.tfvars',
            'lockfile',
            'version',
        ];

        errorHelper(testFiles);
    });

    it('should skip binaries and executable files', () => {
        const testFiles = [
            'app.exe',
            'install.bin',
            'setup.pkg',
            'setup.msi',
            'setup.app',
            'setup.dmg',
            'setup.deb',
            'setup.rpm',
            'setup.ipa',
            'setup.apk',
            'app.jar',
        ];

        errorHelper(testFiles);
    });

    it('should skip logs and temp files', () => {
        const testFiles = [
            'temp',
            'tempfile',
            'cache',
            'logfile.log',
            'test.tmp',
            'test.temp',
            'test.bak',
            'test.old',
            'test.swp',
            'test.swo',
        ];

        errorHelper(testFiles);
    });

    it('should skip media files', () => {
        const testFiles = [
            'test.jpg',
            'test.jpeg',
            'test.png',
            'test.gif',
            'test.svg',
            'test.webp',
            'test.ico',
            'test.tiff',
            'test.tif',
            'test.bmp',
            'test.heif',
            'test.heic',
            'test.raw',
            'test.exif',

            'test.mp4',
            'test.webm',
            'test.mkv',
            'test.avi',
            'test.wmv',
            'test.mov',
            'test.mpg',
            'test.mpeg',
            'test.m4v',
            'test.3gp',
            'test.3g2',
            'test.dash',
            'test.m4p',
            'test.f4v',
            'test.ogv',
            'test.asf',
            'test.mts',
            'test.m2ts',

            'test.mp3',
            'test.wav',
            'test.wma',
            'test.ogg',
            'test.flac',
            'test.aac',
            'test.m4a',
            'test.opus',
            'test.aiff',
            'test.aif',
            'test.caf',
            'test.dsd',
            'test.midi',
            'test.mid',
            'test.spx',
            'test.wv',
            'test.ape',
            'test.mka',
        ];

        errorHelper(testFiles);
    });

    it('should skip font files', () => {
        const testFiles = [
            'test.ttf',
            'test.otf',
            'test.woff',
            'test.woff2',
            'test.eot',
            'test.sfn',
            'test.pfb',
            'test.pfa',
            'test.fnt',
            'test.bdf',
            'test.fon',
        ];

        errorHelper(testFiles);
    });

    it('should skip archive files', () => {
        const testFiles = [
            'test.zip',
            'test.rar',
            'test.tar',
            'test.gz',
            'test.bz2',
            'test.xz',
            'test.7z',
            'test.iso',
            'test.tar.gz',
            'test.tar.bz2',
            'test.tar.xz',
            'test.lz',
            'test.lzma',
            'test.z',
            'test.zipx',
            'test.cpio',
            'test.ace',
            'test.arj',
            'test.lha',
            'test.sit',
            'test.sitx',
        ];

        errorHelper(testFiles);
    });

    it('should skip database files', () => {
        const testFiles = [
            'test.db',
            'test.sqlite',
            'test.sql',
            'test.mdb',
            'test.accdb',
            'test.frm',
            'test.ibd',
            'test.ndf',
            'test.ldf',
            'test.bak',
            'test.dbf',
            'test.fdb',
            'test.pdb',
            'test.odb',
            'test.sqlite3',
            'test.dmp',
            'test.sq3',
        ];

        errorHelper(testFiles);
    });

    it('should skip files in certain directories', () => {
        const testFiles = [
            '.vscode/settings.json',
            '.vscode/launch.json',
            '.idea/misc.xml',
            '.idea/modules.xml',
            'vendor/autoload.php',
            'vendor/composer.json',
            'dist/app.js',
            'dist/style.css',
            'build/output.exe',
            'build/log.txt',
            'log/error.log',
            'log/access.log',
            'tmp/tempfile.tmp',
            'tmp/session.tmp',
            'temp/cache.dat',
            'node_modules/package.json',
            'node_modules/.bin/some-executable',
            'bin/executable',
            'obj/output.obj',
            'out/result.txt',
            'coverage/coverage.info',
            'public/index.html',
            'private/secret.txt',
            'cache/cachefile',
            'docs/readme.md',
            'test/test_file.js',
            'tests/test_suite.py',
            'migrations/20230101_create_table.sql',
            'assets/image.png',
            'uploads/file.jpg',
            'downloads/file.zip',
            'backup/backup.tar.gz',
            'archive/old_project.zip',
            'deploy/deploy.sh',
            'release/version.txt',
            'staging/config.yaml',
            'prod/config.prod.json',
            'bin/executable',
        ];

        errorHelper(testFiles);
    });

    it('should skip files with catchall patterns', () => {
        const newPaths = globalFilePaths.concat([
            '**/test.*',
            '**/test/*',
            '**/test/**',
            '**/test',
            '*/*.test',
        ]);

        const testFiles = [
            'a/dir/test.js',
            'a/dir/test/test.js',
            'a/dir/test/test/test.js',
            'a/dir/test',
            'a/test.js',
            'a/test',
            'test.js',
            'test',
            'test.test',
            'test/test.test',
        ];

        errorHelper(testFiles, true, newPaths);
    });
});
