/**
 * Shared MaterialPluginBase helpers. Every ground/foliage plugin hits the
 * same Babylon gotcha: `getCustomCode` runs from the MaterialPluginBase
 * constructor BEFORE subclass fields exist, so configuration must live in a
 * material-keyed registry populated before construction. This module holds
 * that registry pattern once, plus the activation rule that cost hours to
 * find (custom code injects ONLY for active plugins: pass `enable=true` as
 * the 6th constructor arg).
 */
import type { Material } from "@babylonjs/core";

/** Material-keyed config store. Populate via `attach` before `new Plugin(material)`. */
export class PluginRegistry<Cfg> {
  private readonly map = new WeakMap<Material, Cfg>();

  /** Store config for a material. Call before constructing the plugin. */
  attach(material: Material, cfg: Cfg): void {
    this.map.set(material, cfg);
  }

  /** Read config inside getCustomCode/bindForSubMesh. Null when unattached. */
  get(material: Material): Cfg | undefined {
    return this.map.get(material);
  }
}
