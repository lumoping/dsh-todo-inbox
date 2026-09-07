/**
 * tsdown build for dsh-todo-inbox: the host-half lib (lib/index.js, ESM node)
 * plus the browser client bundle (lib/client.js, CJS closure factory).
 *
 * The client bundle replicates the official DSH client-bundle preset:
 * - externals resolve through the loader module table at runtime (react,
 *   cordis, and the client slots contract; everything else is inlined),
 * - the artifact registers itself via `window.__ModuleLoader__.load({ id,
 *   factory })` with the (require) => exports CJS closure shape, keyed on the
 *   package name (`dsh-todo-inbox` — client-modules compose keys on the
 *   package name; keep it in sync with package.json `name`),
 * - code splitting is off so the bundle is one script.
 *
 * Types ship from lib/types (tsc -p tsconfig.build.json), not from tsdown.
 */
import type { UserConfig } from 'tsdown'

/** Module specifiers the web shell shares into the frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
]

const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  inputOptions: {
    resolve: {
      conditionNames: ['browser', 'import', 'require', 'default'],
    },
  },
  // Module-table entries stay unbundled (resolved through the loader's
  // `require` at runtime); every other import inlines into the bundle.
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('dsh-todo-inbox')}, factory: (require) => {`,
    footer: `return module.exports; } });`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    // The CJS wrapper factory's `require` only resolves module-table entries;
    // it cannot load relative chunk URLs in the browser. Keep one script.
    codeSplitting: false,
  },
}

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    // package.json `type: module` + this flag → plain lib/index.js (the
    // exports map points there; no `.mjs` surprise).
    fixedExtension: false,
    dts: false,
    // clean stays off: the build script removes lib/ wholesale before tsc,
    // so a tsdown clean here would wipe the lib/types declarations tsc just
    // emitted.
    clean: false,
  },
  clientBundle,
] satisfies UserConfig[]
