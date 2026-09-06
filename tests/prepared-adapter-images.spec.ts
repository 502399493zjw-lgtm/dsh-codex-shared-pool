import { zstdDecompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, LlmRuntime, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAICodexAdapter } from '../src/adapter.ts'
import type { OpenAICodexCredentialStore } from '../src/store.ts'
import { createTeamCodexBearer } from '../src/team/client.ts'
import { TEAM_PATH_PREFIX } from '../src/team/types.ts'

let context: Context | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
})

describe('prepared Codex image requests', () => {
  it.each([true, false])('uses the stock request-image policy and exposes only mapped tool paths (mapping available: %s)', async (mapped) => {
    const ref: ImageAttachmentRef = {
      attachmentId: 'attachment-1' as never,
      mediaType: 'image/png', bytes: 4_000_000, width: 4000, height: 4000, name: 'diagram.png',
    }
    const image: RequestImageAttachment = {
      variantId: 'request-image-1' as never,
      attachment: ref, data: new Uint8Array([1, 2, 3]),
      mediaType: 'image/jpeg', bytes: 3, width: 2048, height: 2048,
      depth: 'uchar', space: 'srgb', hasAlpha: false,
    }
    const readImageRequest = vi.fn(async () => image)
    const attachments = {
      readImageRequest,
      imageHostPath: () => '/private/host-attachment-store/diagram.png',
    } as unknown as AttachmentStore
    const mapHostPath = vi.fn(() => mapped ? '/workspace/attachments/diagram.png' : undefined)
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
      error: { message: 'controlled stop' },
    }, { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => attachments,
      () => ({ useFastMode: false, useNativeCompaction: false, useWebSocketContextReuse: false }),
      {
        baseUrl: `https://pool.example.test${TEAM_PATH_PREFIX}`,
        resolveApiKey: async () => createTeamCodexBearer('dsh_team_member-secret-1234567890'),
      },
      undefined,
      (store, imageRef) => resolveImageAttachmentAccess(store, mapHostPath, imageRef),
    )
    context = new Context()
    await context.plugin(LlmRuntime)
    context.llm.registerAdapter(['openai-codex'], adapter)
    const prepared = await context.llm.prepareCall({ provider: 'openai-codex', model: 'gpt-5.6-sol' })
    for await (const _chunk of prepared.stream({
      ...prepared.config,
      messages: [createUserMessage({ content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } })],
    })) { /* consume the controlled provider rejection */ }

    expect(readImageRequest).toHaveBeenCalledExactlyOnceWith(ref, {
      maxPixels: 2048 * 2048, maxBytes: 1024 * 1024,
    }, expect.any(AbortSignal))
    expect(mapHostPath).toHaveBeenCalledWith('/private/host-attachment-store/diagram.png')
    expect(fetch).toHaveBeenCalledOnce()
    const request = JSON.parse(zstdDecompressSync(fetch.mock.calls[0]![1]!.body as Uint8Array).toString())
    const serialized = JSON.stringify(request)
    expect(serialized).toContain('data:image/jpeg;base64,AQID')
    expect(serialized).not.toContain('/private/host-attachment-store')
    if (mapped) expect(serialized).toContain('/workspace/attachments/diagram.png')
    else expect(serialized).not.toContain('/workspace/attachments')
  })
})
