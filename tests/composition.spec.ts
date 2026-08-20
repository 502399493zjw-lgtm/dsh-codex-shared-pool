import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import WebRuntime from '@deepseek-ai/dsh-web'
import { afterEach, describe, expect, it } from 'vitest'
import * as CodexPlugin from '../src/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('standalone plugin composition', () => {
  it('mounts the published LLM service and registers openai-codex', async () => {
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(WebRuntime)
    const codexFiber = await context.plugin(CodexPlugin)

    expect(context.llm.listProviders()).toContainEqual(expect.objectContaining({
      id: 'openai-codex',
      name: 'OpenAI Codex',
    }))
    await expect(context.llm.listModels('openai-codex')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'gpt-5.4' })]),
    )

    await codexFiber.dispose()
    expect(context.llm.listProviders()).not.toContainEqual(expect.objectContaining({ id: 'openai-codex' }))
  })
})
