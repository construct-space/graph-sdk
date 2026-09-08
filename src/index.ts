/**
 * @construct-space/graph
 *
 * Construct Graph — GraphQL database SDK for Construct spaces.
 *
 * Usage:
 *   import { useGraph } from '@construct-space/graph'
 *   import { Note } from './models/Note'
 *
 *   const notes = useGraph(Note)
 *   await notes.create({ content: 'hello', color: 'yellow' })
 *   const all = await notes.find()
 */

export { defineModel, field, relation, clearRegistry, access } from './define.js'
export { useGraph, useGraphList, createGraphList, configure, UnauthorizedError } from './composable.js'
export { extractManifest, manifestToJSON } from './manifest.js'
export type { ManifestOptions } from './manifest.js'
export type {
  GraphClient,
  WhereClause,
  OrderByClause,
  FindOptions,
  GraphChangeAction,
  GraphChangeEvent,
  SubscribeHandler,
  SubscribeOptions,
  GraphSubscription,
  GraphList,
  GraphListOptions,
} from './composable.js'
export type {
  ModelDef,
  FieldDef,
  FieldBuilder,
  RelationBuilder,
  DataManifest,
  GraphConfig,
  AccessLevel,
  AccessRules,
  ModelOptions,
  DataRecord,
  ImportSpec,
} from './types.js'
