import type { TsdownPlugin, UserConfig } from 'tsdown'

const PACKAGE_ID = 'dsh-codex-shared-pool'

const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
] as const

function isPlatformModule(id: string): boolean {
  return PLATFORM_MODULES.includes(id as typeof PLATFORM_MODULES[number])
}

function inlineClientCss(): TsdownPlugin {
  return {
    name: 'dsh-codex-shared-pool:inline-client-css',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const style = bundle['style.css']
        const client = bundle['client.js']
        if (style?.type !== 'asset') throw new Error('client style.css asset was not emitted')
        if (client?.type !== 'chunk') throw new Error('client.js chunk was not emitted')

        const css = typeof style.source === 'string'
          ? style.source
          : Buffer.from(style.source).toString('utf8')
        const factoryStart = 'factory: (require) => {'
        const insertionPoint = client.code.indexOf(factoryStart)
        if (insertionPoint < 0) throw new Error('client module-loader factory banner was not emitted')

        const styleBootstrap = `
          const pluginStyleId = ${JSON.stringify(PACKAGE_ID)};
          let pluginStyle = document.head.querySelector('style[data-dsh-plugin-style="' + pluginStyleId + '"]');
          if (pluginStyle === null) {
            pluginStyle = document.createElement('style');
            pluginStyle.setAttribute('data-dsh-plugin-style', pluginStyleId);
            document.head.append(pluginStyle);
          }
          pluginStyle.textContent = ${JSON.stringify(css)};
        `
        const afterFactoryStart = insertionPoint + factoryStart.length
        client.code = `${client.code.slice(0, afterFactoryStart)}${styleBootstrap}${client.code.slice(afterFactoryStart)}`
      },
    },
  }
}

const host: UserConfig = {
  name: PACKAGE_ID,
  entry: {
    index: 'src/index.ts',
    invariant: 'src/invariant.ts',
    bin: 'src/bin.ts',
    'team-broker-bin': 'src/team-broker-bin.ts',
    'team-migrate-bin': 'src/team-migrate-bin.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
}

const client: UserConfig = {
  name: `${PACKAGE_ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  plugins: [inlineClientCss()],
  deps: {
    neverBundle: [...PLATFORM_MODULES],
    alwaysBundle: (id: string) => !isPlatformModule(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
