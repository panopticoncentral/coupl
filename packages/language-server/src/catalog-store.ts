import { readFile } from "node:fs/promises";
import { fetchNodeCatalog, readNodeSchema } from "coupl";
import type { Catalog } from "./language.js";

export interface CatalogSettings { serverUrl: string; catalogPath: string; token?: string }
export interface CatalogResult { catalog?: Catalog; message?: string }

function validate(value: unknown): Catalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Catalog must be a JSON object.");
  const catalog = value as Catalog;
  if (!Object.values(catalog).some(raw => { try { readNodeSchema(raw); return true; } catch { return false; } })) {
    throw new Error("Catalog contains no supported node schemas.");
  }
  return catalog;
}

/** Per-configuration memory cache. Failures retain the last good catalog until refresh. */
export class CatalogStore {
  private entries = new Map<string, Promise<CatalogResult>>();
  private good = new Map<string, Catalog>();
  private generation = 0;

  refresh(): void { this.generation++; this.entries.clear(); }
  clear(): void { this.refresh(); this.good.clear(); }

  get(settings: CatalogSettings): Promise<CatalogResult> {
    // Tokens are intentionally excluded from keys/logs. The caller invalidates on configuration changes.
    const key = JSON.stringify([settings.serverUrl, settings.catalogPath]);
    let result = this.entries.get(key);
    if (!result) {
      const generation = this.generation;
      result = this.load(settings, this.good.get(key)).then(result => {
        if (result.catalog && generation === this.generation) this.good.set(key, result.catalog);
        return result;
      });
      this.entries.set(key, result);
    }
    return result;
  }

  private async load(settings: CatalogSettings, cached?: Catalog): Promise<CatalogResult> {
    const errors: string[] = [];
    if (settings.serverUrl) {
      try {
        return { catalog: validate(await fetchNodeCatalog(settings.serverUrl, {
          ...(settings.token ? { headers: { Authorization: `Bearer ${settings.token}` } } : {}),
        })) };
      } catch (error) { errors.push(error instanceof Error ? error.message : "Could not load server catalog."); }
      if (cached) return { catalog: cached, message: `${errors.join(" ")} Using the last successful catalog; refresh to retry.` };
    }
    if (settings.catalogPath) {
      try {
        return { catalog: validate(JSON.parse(await readFile(settings.catalogPath, "utf8"))),
          ...(errors.length ? { message: `${errors.join(" ")} Using the saved catalog; refresh to retry.` } : {}) };
      } catch { errors.push("Could not read a valid saved catalog. Check coupl.catalogPath and the JSON file."); }
    }
    if (cached) return { catalog: cached, message: `${errors.join(" ")} Using the last successful catalog; refresh to retry.` };
    return { message: errors.length ? `${errors.join(" ")} Syntax checking remains available; refresh to retry.`
      : "Set coupl.serverUrl or coupl.catalogPath to enable node validation and catalog completion. Syntax checking remains available." };
  }
}
