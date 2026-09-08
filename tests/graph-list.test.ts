import { describe, expect, test } from 'bun:test'
import { createGraphList, type GraphChangeEvent, type GraphClient, type DataRecord, type FindOptions, type SubscribeOptions } from '../src'

interface Message extends DataRecord {
  room_id: string
  body: string
}

function fakeClient(rows: Message[] = []): GraphClient<Message> {
  let stored = [...rows]
  return {
    async find(_options?: FindOptions) {
      return [...stored]
    },
    async findOne(id: string) {
      return stored.find(row => row.id === id) || null
    },
    async create(input: Partial<Message>) {
      const row = {
        id: input.id || `msg-${stored.length + 1}`,
        created_at: input.created_at || new Date(0).toISOString(),
        updated_at: input.updated_at || new Date(0).toISOString(),
        ...input,
      } as Message
      stored = [row, ...stored]
      return row
    },
    async update(id: string, input: Partial<Message>) {
      const idx = stored.findIndex(row => row.id === id)
      if (idx < 0) throw new Error('not found')
      stored[idx] = { ...stored[idx], ...input }
      return stored[idx]
    },
    async remove(id: string) {
      stored = stored.filter(row => row.id !== id)
      return true
    },
    async count() {
      return stored.length
    },
    subscribe(options: SubscribeOptions<Message>) {
      void options
      return () => {}
    },
    async query() {
      return {}
    },
    async mutate() {
      return {}
    },
  }
}

describe('createGraphList', () => {
  test('loads rows into a stable items array', async () => {
    const client = fakeClient([
      { id: '1', room_id: 'general', body: 'hello', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    ])
    const list = createGraphList(client)
    const itemsRef = list.items

    const rows = await list.load()

    expect(rows).toHaveLength(1)
    expect(list.items).toBe(itemsRef)
    expect(list.items[0].body).toBe('hello')
    expect(list.loading).toBe(false)
    expect(list.error).toBeNull()
  })

  test('applies realtime CRUD events against the configured filter', () => {
    const list = createGraphList(fakeClient(), { where: { room_id: 'general' }, orderBy: { created_at: 'asc' } })

    list.applyEvent(event('created', { id: '1', room_id: 'general', body: 'hello', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }))
    list.applyEvent(event('created', { id: '2', room_id: 'random', body: 'skip', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }))

    expect(list.items.map(row => row.id)).toEqual(['1'])

    list.applyEvent(event(
      'updated',
      { id: '1', room_id: 'random', body: 'moved', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-03T00:00:00Z' },
      { id: '1', room_id: 'general', body: 'hello', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    ))

    expect(list.items).toEqual([])
  })

  test('create update and remove keep local items in sync', async () => {
    const list = createGraphList(fakeClient(), { where: { room_id: 'general' } })

    const created = await list.create({ room_id: 'general', body: 'hello' })
    expect(list.items.map(row => row.id)).toEqual([created.id])

    await list.update(created.id, { body: 'edited' })
    expect(list.items[0].body).toBe('edited')

    await list.remove(created.id)
    expect(list.items).toEqual([])
  })

  test('start subscribes with the configured filter and returns a stop function', () => {
    let subscribed: SubscribeOptions<Message> | undefined
    let stopped = false
    const client: GraphClient<Message> = {
      ...fakeClient(),
      subscribe(options: SubscribeOptions<Message>) {
        subscribed = options
        return () => {
          stopped = true
        }
      },
    }
    const list = createGraphList(client, { where: { room_id: 'general' } })

    const stop = list.start()
    subscribed?.onEvent(event('created', { id: '1', room_id: 'general', body: 'hello', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }))

    expect(subscribed?.where).toEqual({ room_id: 'general' })
    expect(list.items.map(row => row.id)).toEqual(['1'])

    stop()
    expect(stopped).toBe(true)
  })
})

function event(action: GraphChangeEvent<Message>['action'], record: Message, previousRecord?: Message): GraphChangeEvent<Message> {
  return {
    id: Date.now(),
    action,
    model: 'message',
    record,
    previousRecord,
  }
}
