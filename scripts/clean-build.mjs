import { rm } from 'node:fs/promises'

const buildDirectory = new URL('../lib/', import.meta.url)

await rm(buildDirectory, { force: true, recursive: true })
