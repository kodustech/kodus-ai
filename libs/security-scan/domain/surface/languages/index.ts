import { LanguageSurface } from '../surface.types';
import { BASH_SURFACE } from './bash.surface';
import { C_SURFACE } from './c.surface';
import { CPP_SURFACE } from './cpp.surface';
import { CSHARP_SURFACE } from './csharp.surface';
import { DART_SURFACE } from './dart.surface';
import { ELIXIR_SURFACE } from './elixir.surface';
import { GO_SURFACE } from './go.surface';
import { JAVA_SURFACE } from './java.surface';
import { KOTLIN_SURFACE } from './kotlin.surface';
import { PHP_SURFACE } from './php.surface';
import { PYTHON_SURFACE } from './python.surface';
import { RUBY_SURFACE } from './ruby.surface';
import { RUST_SURFACE } from './rust.surface';
import { SCALA_SURFACE } from './scala.surface';
import { SWIFT_SURFACE } from './swift.surface';
import { TYPESCRIPT_SURFACE } from './typescript.surface';

/** The languages kodus-graph parses (TS and JS share one family). */
export const LANGUAGE_SURFACES: LanguageSurface[] = [
    TYPESCRIPT_SURFACE,
    PYTHON_SURFACE,
    GO_SURFACE,
    JAVA_SURFACE,
    KOTLIN_SURFACE,
    RUST_SURFACE,
    CPP_SURFACE,
    C_SURFACE,
    SCALA_SURFACE,
    CSHARP_SURFACE,
    SWIFT_SURFACE,
    DART_SURFACE,
    ELIXIR_SURFACE,
    RUBY_SURFACE,
    PHP_SURFACE,
    BASH_SURFACE,
];
