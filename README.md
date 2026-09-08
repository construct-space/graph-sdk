# @construct-space/graph

GraphQL database SDK for [Construct](https://construct.space) spaces. Define models, publish your space, get a database + GraphQL API automatically.

## Install

```bash
bun add @construct-space/graph
```

Or use the CLI:

```bash
construct graph init
```

## Define Models

```typescript
import { defineModel, field, relation } from '@construct-space/graph'

export const Department = defineModel('department', {
  name: field.string().required(),
  description: field.string(),
})

export const Employee = defineModel('employee', {
  first_name: field.string().required(),
  last_name: field.string().required(),
  email: field.string().email().unique(),
  salary: field.number(),
  active: field.boolean().default(true),
  department: relation.belongsTo(Department, { onDelete: 'cascade' }),
})
```

## Use Data

```vue
<script setup>
import { useGraph } from '@construct-space/graph'
import { Employee } from '../models/Employee'

const employees = useGraph(Employee)

// Find with filters
const active = await employees.find({
  where: { active: true },
  orderBy: { created_at: 'desc' },
  limit: 20,
})

// Create
const emp = await employees.create({
  first_name: 'Jane',
  email: 'jane@company.com',
  department_id: 'dept-uuid',
})

// Update
await employees.update(emp.id, { position: 'Senior' })

// Delete
await employees.remove(emp.id)

// Count
const total = await employees.count({ where: { active: true } })

// Realtime changes
const stop = employees.subscribe({
  where: { active: true },
  onEvent(event) {
    if (event.action === 'created') {
      console.log('new employee', event.record)
    }
  },
})

// Later, stop listening
stop()
</script>

<template>
  <div v-for="emp in active" :key="emp.id">
    {{ emp.first_name }} {{ emp.last_name }}
  </div>
</template>
```

## Realtime Lists

For screens that need a loaded list plus local CRUD helpers and live updates:

```typescript
import { useGraphList } from '@construct-space/graph'

const messages = useGraphList(Message, {
  where: { room_id: roomId },
  orderBy: { created_at: 'asc' },
  realtime: true,
})

await messages.load()

await messages.create({ room_id: roomId, body: 'hello' })
await messages.update(messageId, { body: 'edited' })
await messages.remove(messageId)

// Stop the realtime stream when the view unmounts.
messages.stop()
```

Typing indicators are ephemeral presence, not durable CRUD. Use a short-lived
presence channel for `typing:start` / `typing:stop` style events; do not write
every keypress into a Graph table unless you specifically want an audit trail.

## Field Types

| Type | Builder | Database |
|------|---------|----------|
| String | `field.string()` | TEXT |
| Integer | `field.int()` | INTEGER |
| Number | `field.number()` | NUMERIC |
| Boolean | `field.boolean()` | BOOLEAN |
| Date | `field.date()` | TIMESTAMPTZ |
| JSON | `field.json()` | JSONB |
| Enum | `field.enum(['a', 'b', 'c'])` | TEXT + CHECK |

## Modifiers

```typescript
field.string().required()        // NOT NULL
field.string().unique()          // UNIQUE constraint
field.string().index()           // database index
field.string().default('hello')  // default value
field.string().email()           // email validation
field.string().url()             // URL validation
field.int().min(0).max(100)      // range validation
```

## Relations

### belongsTo

Creates a foreign key column. Resolved via SQL `LEFT JOIN` (no N+1).

```typescript
relation.belongsTo(User)                              // FK with SET NULL on delete
relation.belongsTo(User, { onDelete: 'cascade' })     // cascade delete
relation.belongsTo(User, { onDelete: 'set_null' })    // set null on delete
relation.belongsTo(User, { onDelete: 'restrict' })    // prevent parent deletion
relation.belongsTo(User, { nullable: true })           // optional relation
```

### hasMany

Virtual inverse — no column. Resolved via batch `WHERE IN` query (no N+1).

```typescript
relation.hasMany(Post)
```

### Querying Relations

Relations are resolved when you request nested fields in GraphQL:

```typescript
// Via raw GraphQL
const data = await employees.query(`{
  employees(limit: 10) {
    id
    first_name
    department {
      id
      name
    }
  }
}`)

// Via include (returns { id } only)
const emps = await employees.find({ include: ['department'] })
```

## Filters

```typescript
await employees.find({
  where: {
    salary: { $gt: 50000 },               // greater than
    role: { $in: ['engineer', 'lead'] },   // in set
    email: { $like: '%@company.com' },     // pattern match
    deleted_at: { $null: true },           // is null
    age: { $gte: 21, $lte: 65 },          // range
    status: { $ne: 'archived' },           // not equal
  }
})
```

## Access Control

```typescript
defineModel('task', {
  title: field.string().required(),
}, {
  access: {
    read: 'owner',           // only see your own
    create: 'authenticated', // any logged-in user
    update: 'owner',         // only edit your own
    delete: 'admin',         // only admins can delete
  }
})
```

Levels: `public`, `authenticated`, `owner`, `member`, `admin`, `publisher_admin`, `none`

- `publisher_admin` — restricted to members of the space's publisher org. Bypasses tenant row filters. Intended for publisher-only admin spaces (see [Space Bundles](#space-bundles)).

## Space Bundles

A **bundle** groups related spaces published by the same org under one identity. For example, a "Kanban Suite" bundle containing `kanban` (the app tenants install) and `kanban-admin` (the publisher-only admin UI).

Create the bundle once, then attach spaces to it via manifest:

```bash
# publisher creates bundle
curl -X POST https://graph.construct.space/api/space-bundles \
  -H "Authorization: Bearer cat_..." \
  -H "X-Auth-Org-ID: org-flak" \
  -d '{"id":"kanban-suite","name":"Kanban Suite"}'
```

Each space's `data.manifest.json` declares its `bundle_id`:

```json
{
  "version": 1,
  "bundle_id": "kanban-suite",
  "models": [ ... ]
}
```

### Cross-Space Imports

A space in the bundle can re-use another sibling's models:

```json
{
  "version": 1,
  "bundle_id": "kanban-suite",
  "imports": [{ "from": "kanban", "models": ["board", "card"] }],
  "models": [
    {
      "name": "board",
      "fields": [],
      "options": { "access": { "read": "publisher_admin" } }
    }
  ]
}
```

Here `kanban-admin` reads `board` from `kanban`'s tables, but overrides the access rule so only the publisher org sees rows — across all tenants that installed `kanban`.

Rules:
- Cross-bundle imports are rejected at publish time.
- Imported models use the source space's physical schema; re-declaring the model in `models` lets you override access rules without moving tables.
- Row-level tenant filters (e.g. `org_id = caller.orgID`) only skip when access level is `publisher_admin`.

## Distribution + Installs

Each space has a `distribution` mode (default `public`):

- `public` — any org can install.
- `org_allowlist` — only orgs in the space's allowlist may install.
- `private` — only the publisher org may install (useful for admin spaces).

Tenants install a space before they can query it:

```bash
curl -X POST https://graph.construct.space/api/spaces/kanban/install \
  -H "Authorization: Bearer cat_..." \
  -H "X-Auth-Org-ID: org-basecode"
```

Publishers can read the install list for their own spaces:

```bash
curl https://graph.construct.space/api/spaces/kanban/installs \
  -H "Authorization: Bearer cat_..." \
  -H "X-Auth-Org-ID: org-flak"
```

Or query it via GraphQL from a publisher-admin space using the built-in `_installs` query:

```graphql
query { _installs(spaceId: "kanban") { orgId spaceId } }
```

`_installs` is gated by `publisher_admin` — only the bundle's owning org can reach it.

## Model Scoping

```typescript
// Project scope (default) — isolated per project
defineModel('task', { ... })

// Company scope — shared across projects
defineModel('setting', { ... }, { scope: 'company' })
```

## Configure

Inside Construct, configuration is automatic. For standalone use:

```typescript
import { configure } from '@construct-space/graph'

configure({
  url: 'https://graph.construct.space',
  spaceId: 'my-space',
  projectId: 'default',
  getAccessToken: () => Promise.resolve('your-token'),
})
```

## API Reference

### useGraph(model)

Returns a `GraphClient` with:

| Method | Description |
|--------|-------------|
| `find(options?)` | List records with filters, ordering, pagination |
| `findOne(id)` | Get single record by ID |
| `create(input)` | Create a record |
| `update(id, input)` | Update a record |
| `remove(id)` | Delete a record |
| `count(options?)` | Count matching records |
| `subscribe(options)` | Listen to realtime create/update/delete events |
| `query(gql, vars?)` | Raw GraphQL query |
| `mutate(gql, vars?)` | Raw GraphQL mutation |

### useGraphList(model, options?)

Returns a `GraphList` with a stable `items` array, loading/error state, CRUD
helpers, `load()`, `refresh()`, `start()`, `stop()`, and `applyEvent()`.

### SubscribeOptions

```typescript
interface SubscribeOptions<T> {
  where?: WhereClause
  cursor?: number
  signal?: AbortSignal
  retryMs?: number
  onEvent: (event: GraphChangeEvent<T>) => void
  onError?: (error: unknown) => void
}
```

### FindOptions

```typescript
interface FindOptions {
  where?: WhereClause      // filter conditions
  orderBy?: OrderByClause  // { field: 'asc' | 'desc' }
  limit?: number           // max records (default: 100)
  offset?: number          // skip records
  include?: string[]       // relation names to include
}
```

### Auto-Generated Fields

Every record includes:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | UUID primary key |
| `created_at` | string | ISO timestamp |
| `updated_at` | string | ISO timestamp |
| `created_by` | string | Creator's user ID |

## CLI

```bash
construct graph init                                  # add to space
construct graph g User name:string email:string       # generate model
construct graph g Post title:string author:belongsTo:User  # with relation
construct graph push                                  # register with Graph
```

## License

MIT
