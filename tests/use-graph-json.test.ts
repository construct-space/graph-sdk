import { afterEach, describe, expect, test } from 'bun:test'
import { clearRegistry, configure, defineModel, field, useGraph, type DataRecord } from '../src'

interface Note extends DataRecord {
  title: string
  labels: string[]
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  clearRegistry()
})

describe('useGraph json fields', () => {
  test('stringifies json values on write and parses json strings on read', async () => {
    const NoteModel = defineModel('note', {
      title: field.string(),
      labels: field.json(),
    })
    configure({
      url: 'https://graph.test',
      spaceId: 'notes',
      getAccessToken: async () => 'cst_live_test',
    })

    let capturedBody: any
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        data: {
          createNote: {
            id: 'note-1',
            title: 'hello',
            labels: '["bug","sdk"]',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const notes = useGraph<Note>(NoteModel)
    const created = await notes.create({ title: 'hello', labels: ['bug', 'sdk'] })

    expect(capturedBody.variables.input.labels).toBe('["bug","sdk"]')
    expect(created.labels).toEqual(['bug', 'sdk'])
  })
})
