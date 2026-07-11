import { getTableColumns } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { stores, users } from '../src/db/schema'

describe('security state schema', () => {
  it('has token version and explicit store security status', () => {
    expect(getTableColumns(users)).toHaveProperty('tokenVersion')
    expect(getTableColumns(stores)).toHaveProperty('securityStatus')
    expect(getTableColumns(stores)).not.toHaveProperty('isActive')
  })
})
