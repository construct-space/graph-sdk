/**
 * Model definition API — defineModel, field, relation
 *
 * Usage:
 *   const Employee = defineModel('employee', {
 *     name: field.string().required(),
 *     email: field.string().email().unique(),
 *     salary: field.number(),
 *     active: field.boolean().default(true),
 *     department: relation.belongsTo(Department),
 *   })
 */

import type { FieldDef, FieldBuilder, RelationBuilder, ModelDef, ModelOptions, FieldType, AccessLevel } from './types.js'

const VALID_ACCESS_LEVELS: readonly AccessLevel[] = ['public', 'authenticated', 'owner', 'member', 'admin', 'none']

// Tenancy values a model may declare. Always passed as an array.
const VALID_SCOPES = ['app', 'org'] as const

function validateModelOptions(options: ModelOptions): void {
  // `scopes` is the canonical field (it matches the space manifest and is
  // what the graph service reads); `isolation` is a deprecated alias kept
  // for back-compat. Validate whichever the caller supplied — both have the
  // same shape; merging happens later if both are present.
  const tenancy = options.scopes ?? options.isolation
  if (tenancy) {
    if (!Array.isArray(tenancy) || tenancy.length === 0) {
      throw new Error('scopes must be a non-empty array of "app" | "org"')
    }
    for (const v of tenancy) {
      if (!VALID_SCOPES.includes(v as any)) {
        throw new Error(`Invalid scope "${v}": must be one of ${VALID_SCOPES.join(', ')}`)
      }
    }
  }
  if (options.access) {
    for (const op of ['read', 'create', 'update', 'delete'] as const) {
      const level = options.access[op]
      if (!VALID_ACCESS_LEVELS.includes(level)) {
        throw new Error(`Invalid access level "${level}" for ${op}: must be one of ${VALID_ACCESS_LEVELS.join(', ')}`)
      }
    }
  }
}

/** Helper object for building access rules */
export const access = {
  public: () => 'public' as AccessLevel,
  authenticated: () => 'authenticated' as AccessLevel,
  owner: () => 'owner' as AccessLevel,
  member: () => 'member' as AccessLevel,
  admin: () => 'admin' as AccessLevel,
  none: () => 'none' as AccessLevel,
}

// Strict name validation — alphanumeric + underscores, must start with letter
const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*$/

function validateName(name: string, context: string): void {
  if (!name || !NAME_REGEX.test(name)) {
    throw new Error(`Invalid ${context} name "${name}": must be alphanumeric (underscores allowed), starting with a letter`)
  }
}

// Internal registry of all models (used to extract manifest)
const _models: Map<string, ModelDef> = new Map()

/** Define a data model for Graph storage */
export function defineModel(name: string, fields: Record<string, FieldBuilder | RelationBuilder>, options?: ModelOptions): ModelDef {
  validateName(name, 'model')

  if (options) {
    validateModelOptions(options)
  }

  // Check for duplicate field names
  const fieldNames = new Set<string>()
  const fieldDefs: FieldDef[] = Object.entries(fields).map(([key, builder]) => {
    validateName(key, 'field')
    if (fieldNames.has(key)) {
      throw new Error(`Duplicate field name "${key}" in model "${name}"`)
    }
    fieldNames.add(key)

    return { ...builder._def, name: key }
  })

  // Normalize options: `scopes` is canonical. If a caller passed only the
  // deprecated `isolation` alias, mirror it onto `scopes`. We set both so
  // any code still reading `isolation` keeps working, but `scopes` is the
  // field the CLI registers and the graph service reads.
  let normalizedOptions: ModelOptions | undefined = options
  if (options && (options.scopes || options.isolation)) {
    const tenancy = options.scopes ?? options.isolation
    normalizedOptions = { ...options, scopes: tenancy, isolation: tenancy }
  }

  // Freeze fields to prevent mutation
  const model: ModelDef = Object.freeze({
    name,
    fields: Object.freeze(fieldDefs),
    ...(normalizedOptions ? { options: Object.freeze(normalizedOptions) } : {}),
  })
  _models.set(name, model)
  return model
}

/** Get all registered models (returns deep-cloned copies to prevent mutation) */
export function getRegisteredModels(): ModelDef[] {
  return Array.from(_models.values()).map(m => ({
    name: m.name,
    fields: m.fields.map(f => ({ ...f })),
    ...(m.options ? { options: { ...m.options } } : {}),
  }))
}

/** Clear the model registry (useful for testing / hot-reload) */
export function clearRegistry(): void {
  _models.clear()
}

/** Create a field builder */
function createFieldBuilder(type: FieldType): FieldBuilder {
  const def: FieldDef = { name: '', type }

  const builder: FieldBuilder = {
    _def: def,
    required() { def.required = true; return builder },
    unique() { def.unique = true; return builder },
    index() { def.index = true; return builder },
    default(value: unknown) { def.default = value; return builder },
    email() { def.validation = 'email'; return builder },
    url() { def.validation = 'url'; return builder },
    min(value: number) { def.min = value; return builder },
    max(value: number) { def.max = value; return builder },
  }

  return builder
}

/** Field type constructors */
export const field = {
  string: () => createFieldBuilder('string'),
  int: () => createFieldBuilder('int'),
  number: () => createFieldBuilder('number'),
  boolean: () => createFieldBuilder('boolean'),
  date: () => createFieldBuilder('date'),
  json: () => createFieldBuilder('json'),
  enum: (values: string[]) => {
    if (!values.length) throw new Error('Enum field requires at least one value')
    for (const v of values) {
      if (typeof v !== 'string' || !v) throw new Error(`Invalid enum value: ${v}`)
    }
    const builder = createFieldBuilder('enum')
    builder._def.values = [...values] // clone to prevent external mutation
    return builder
  },
}

/** Relation constructors */
export const relation = {
  belongsTo(target: ModelDef, opts?: { nullable?: boolean; onDelete?: 'cascade' | 'set_null' | 'restrict' }): RelationBuilder {
    return {
      _def: {
        name: '',
        type: 'relation',
        relation: 'belongsTo',
        target: target.name,
        nullable: opts?.nullable,
        onDelete: opts?.onDelete,
      },
    }
  },
  hasMany(target: ModelDef): RelationBuilder {
    return {
      _def: {
        name: '',
        type: 'relation',
        relation: 'hasMany',
        target: target.name,
      },
    }
  },
}
