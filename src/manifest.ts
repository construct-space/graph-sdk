/**
 * Manifest extractor — generates data.manifest.json from registered models
 * Used by `construct publish` to extract model definitions and provision schemas
 */

import { getRegisteredModels } from './define.js'
import type { DataManifest, ImportSpec } from './types.js'

/**
 * Options that a space can attach to its manifest when it belongs to a
 * publisher bundle (kanban + kanban-admin share ownership) or when it reads
 * models from sibling spaces via imports.
 */
export interface ManifestOptions {
  bundleId?: string
  imports?: readonly ImportSpec[]
}

/** Extract the data manifest from all registered models (returns frozen copy) */
export function extractManifest(options: ManifestOptions = {}): Readonly<DataManifest> {
  const manifest: DataManifest = {
    version: 1,
    models: Object.freeze(getRegisteredModels()),
  }
  if (options.bundleId) manifest.bundle_id = options.bundleId
  if (options.imports && options.imports.length > 0) {
    manifest.imports = Object.freeze(options.imports.map((i) => Object.freeze({ ...i })))
  }
  return Object.freeze(manifest)
}

/** Serialize manifest to JSON string */
export function manifestToJSON(options: ManifestOptions = {}): string {
  return JSON.stringify(extractManifest(options), null, 2)
}
