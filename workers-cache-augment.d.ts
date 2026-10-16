/**
 * Cloudflare Workers extends the standard CacheStorage with a default
 * edge cache (`caches.default`). vite.config.ts imports src/api handlers
 * and worker/index.ts references it; the DOM lib added to
 * tsconfig.node.json provides `caches` itself but not this
 * Workers-specific property.
 *
 * Structural subset of the Workers Cache API — enough for the
 * match/put call sites in worker/index.ts. Augmentation (not global
 * redeclaration) so this file coexists with worker-configuration.d.ts
 * in any program without duplicate identifiers.
 */

declare global {
  interface CacheStorage {
    readonly default: {
      match(request: unknown): Promise<Response | undefined>;
      put(request: unknown, response: Response): Promise<unknown>;
      delete(request: unknown): Promise<boolean>;
    };
  }
}

export {};
