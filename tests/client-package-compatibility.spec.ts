import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

describe('published DSH client package compatibility', () => {
  it('resolves every browser DSH import against the installed release', async () => {
    const clientRoot = fileURLToPath(new URL('../src/client/', import.meta.url))
    const files = (await readdir(clientRoot, { recursive: true }))
      .filter(file => /\.tsx?$/u.test(file))
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    }
    const missing: string[] = []
    for (const file of files) {
      const path = resolve(clientRoot, file)
      const source = await readFile(path, 'utf8')
      for (const imported of ts.preProcessFile(source).importedFiles) {
        if (!imported.fileName.startsWith('@deepseek-ai/')) continue
        const result = ts.resolveModuleName(imported.fileName, path, options, ts.sys)
        if (result.resolvedModule === undefined) missing.push(`${file}: ${imported.fileName}`)
      }
    }

    expect(missing).toEqual([])
  })
})
