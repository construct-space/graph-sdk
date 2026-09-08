/**
 * Data model type definitions
 */

export type FieldType = 'string' | 'int' | 'number' | 'boolean' | 'date' | 'enum' | 'json'
export type RelationType = 'belongsTo' | 'hasMany'
export type OnDeleteAction = 'cascade' | 'set_null' | 'restrict'

export interface FieldDef {
  name: string
  type: FieldType | 'relation'
  required?: boolean
  unique?: boolean
  index?: boolean
  default?: unknown
  validation?: 'email' | 'url'
  values?: string[] // for enum type
  min?: number
  max?: number
  // Relation fields
  relation?: RelationType
  target?: string
  onDelete?: OnDeleteAction
  nullable?: boolean
}

export type AccessLevel =
  | 'public'
  | 'authenticated'
  | 'owner'
  | 'member'
  | 'admin'
  | 'publisher_admin'
  | 'none'

export interface AccessRules {
  read: AccessLevel
  create: AccessLevel
  update: AccessLevel
  delete: AccessLevel
}

export interface ModelOptions {
  /**
   * Tenancy boundary for this model — who owns each row. This is the
   * canonical field: it matches the space manifest's `scopes` and is what
   * `construct graph push` registers and the graph service reads.
   *
   *   'app' -> per-user bucket
   *   'org' -> shared across the active organization
   *
   * List both to support either install mode; the host picks the matching
   * value at runtime. A model declared `scopes: ['app', 'org']` writes to
   * per-user buckets when installed personally, to per-org buckets in an org.
   *
   * If omitted here, the CLI stamps the space-level `scopes` from
   * space.manifest.json at push time, so you don't have to repeat it on
   * every model.
   */
  scopes?: Array<'app' | 'org'>
  /**
   * @deprecated Alias for `scopes`, accepted for back-compat. Prefer
   * `scopes` — it matches the manifest and is the field that actually
   * registers. `isolation` is unknown to the graph service.
   */
  isolation?: Array<'app' | 'org'>
  access?: AccessRules
  /**
   * ABAC binding. When set, `useAccess<T>()` from the SDK reads grants
   * from `model` and treats this resource as shareable per-row.
   *
   * Convention: empty member set = open to org. Adding rows restricts
   * the resource to listed users; clearing all rows opens it again.
   *
   * Only user-keyed principals in v1 — no team/role/public columns.
   * Spaces that need richer principals can add extra columns to their
   * ACL model and extend the composable themselves.
   */
  acl?: AclBinding
}

export interface AclBinding {
  /**
   * The ACL model — itself a ModelDef created with defineModel().
   * Must have at minimum: <resourceKey>, user_id, role.
   */
  model: ModelDef
  /**
   * Foreign-key field on the ACL model that points at this resource's id.
   * Convention: `<resource_name>_id` (e.g. 'folder_id').
   */
  resourceKey: string
  /**
   * Role ladder for this resource type. The first entry is the lowest
   * privilege; the last is the highest. useAccess.hasRoleAtLeast()
   * compares against this ordering.
   */
  roles: readonly string[]
  /**
   * Optional custom rules per action. When omitted for an action,
   * useAccess falls back to membership presence: `can(action, r)` is
   * true if the actor has any member row on `r`.
   */
  rules?: Record<string, (actor: ActorContext, resource: any) => boolean>
  /**
   * Optional field names on the ACL model. Defaults inferred.
   */
  userField?: string                    // default 'user_id'
  roleField?: string                    // default 'role'
  inviterField?: string                 // default 'invited_by' (optional column)
  invitedAtField?: string               // default 'invited_at' (optional column)
}

/**
 * Actor context handed to ACL rule predicates. Spaces can call helpers
 * to make rules read like English.
 */
export interface ActorContext {
  id: string
  roles: string[]
  hasRole(name: string): boolean
  hasAccess(resource: any, role?: string): boolean
  hasRoleAtLeast(resource: any, role: string): boolean
}

export interface ModelDef {
  readonly name: string
  readonly fields: readonly FieldDef[]
  readonly options?: ModelOptions
}

/**
 * ImportSpec declares that this space re-uses models from another space in
 * the same publisher bundle. The source space must be in the same bundle;
 * cross-bundle imports are rejected at publish time.
 */
export interface ImportSpec {
  from: string
  models: string[]
}

export interface DataManifest {
  version: number
  models: readonly ModelDef[]
  /**
   * Publisher bundle id. Groups related spaces (e.g. kanban + kanban-admin)
   * under one ownership umbrella. Required when the manifest declares imports.
   * Omit for standalone spaces.
   */
  bundle_id?: string
  /**
   * Cross-space imports. Each import references a sibling space in the same
   * bundle and lists which of its models to re-use. Access rules for imported
   * models live on this space's manifest (re-declare the model in `models` to
   * override access); the underlying tables stay in the source space's schema.
   */
  imports?: readonly ImportSpec[]
}

/** Field builder for chaining */
export interface FieldBuilder {
  readonly _def: FieldDef
  required(): FieldBuilder
  unique(): FieldBuilder
  index(): FieldBuilder
  default(value: unknown): FieldBuilder
  email(): FieldBuilder
  url(): FieldBuilder
  min(value: number): FieldBuilder
  max(value: number): FieldBuilder
}

/** Relation builder */
export interface RelationBuilder {
  readonly _def: FieldDef
}

/** Record with auto-generated fields */
export interface DataRecord {
  id: string
  created_at: string
  updated_at: string
  created_by?: string
  [key: string]: unknown
}

/** Configuration for the Graph client */
export interface GraphConfig {
  /**
   * Base URL of the graph service. Optional — defaults to the URL the
   * Construct host injects on `globalThis.construct.config.graphUrl`
   * (so consumers running inside a Construct space don't need to pass
   * one), falling back to the production gateway when no host is
   * present. Pass a full URL only when overriding (tests, local dev).
   */
  url?: string
  spaceId: string
  projectId?: string
  /**
   * @deprecated No longer read by the Graph client. Company/org scope is
   * resolved server-side from the authenticated session. Kept for
   * back-compat with existing callers that still pass it.
   */
  companyId?: string
  getAccessToken?: () => Promise<string | null>
}
