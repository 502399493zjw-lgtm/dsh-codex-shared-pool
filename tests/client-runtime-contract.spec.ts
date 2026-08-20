import { describe, expect, it } from 'vitest'
import {
  CLIENT_INJECT,
  QUOTA_CLIENT_INJECT,
} from '../src/client/runtime-contract.ts'

describe('published DSH browser runtime contract', () => {
  it('injects Settings navigation only into the quota Browser child plugin', () => {
    expect(CLIENT_INJECT).toEqual(['slots', 'locale', 'sessions'])
    expect(QUOTA_CLIENT_INJECT).toEqual(['slots', 'locale', 'settingsNavigation'])
  })
})
