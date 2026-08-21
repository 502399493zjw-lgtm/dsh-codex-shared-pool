import { describe, expect, it } from 'vitest'
import {
  CLIENT_INJECT,
  QUOTA_CLIENT_INJECT,
} from '../src/client/runtime-contract.ts'

describe('published DSH browser runtime contract', () => {
  it('does not hard-wait on the optional Settings navigation service', () => {
    expect(CLIENT_INJECT).toEqual(['slots', 'locale', 'sessions', 'modelDirectories'])
    expect(QUOTA_CLIENT_INJECT).toEqual(['slots', 'locale'])
  })
})
