/**
 * Version-override smoke probe + continuous post-promotion probe.
 *
 * `smokeWithVersionOverride` probes every critical route at 0% real traffic
 * using the `Cloudflare-Workers-Version-Overrides` request header — it never
 * affects live users. `finalSmoke` runs the identical route/status/header
 * check WITHOUT the override header, against whatever is actually serving
 * live traffic (used once after finalize). `continuousProbe` repeats the
 * same check every 5s for a soak window after promotion, aborting on the
 * first failure.
 *
 * Every probe URL carries a unique cache-busting query parameter: this
 * project enables Cloudflare's edge Workers Cache (`cache.enabled: true` in
 * wrangler.jsonc), whose default cache key does not vary by the version
 * override header, so an un-busted probe could silently read a stale cached
 * response instead of actually exercising the target version.
 *
 * fetch/sleep are injected — no real network or timers in unit tests.
 */

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_DURATION_MS = 120000;
const RELEASE_HEADER = "X-Moedict-Release";
const OVERRIDE_HEADER = "Cloudflare-Workers-Version-Overrides";

/**
 * @typedef {(input: string, init?: RequestInit) => Promise<Response>} FetchFn
 */

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** @param {string} baseUrl */
function validateBaseUrl(baseUrl) {
  if (!nonEmptyString(baseUrl)) throw new Error("baseUrl must be a non-empty string");
  // Constructing a URL below validates well-formedness; this just fails closed early.
  new URL(baseUrl);
}

/** @param {string[]} routes */
function validateRoutes(routes) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error("routes must be a non-empty array");
  }
  for (const route of routes) {
    if (!nonEmptyString(route) || !route.startsWith("/")) {
      throw new Error(`Invalid route (must start with "/"): ${JSON.stringify(route)}`);
    }
  }
}

/**
 * Build a cache-busted, safely-joined probe URL — never string
 * concatenation, so a route with special characters cannot corrupt the
 * base origin.
 * @param {string} baseUrl
 * @param {string} route
 * @returns {string}
 */
function buildProbeUrl(baseUrl, route) {
  const url = new URL(route, baseUrl);
  url.searchParams.set(
    "_probe",
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  );
  return url.toString();
}

/**
 * Issue a single cache-busted probe request.
 * @param {string} baseUrl
 * @param {string} route
 * @param {{ fetch?: FetchFn; headers?: Record<string, string> }} [opts]
 * @returns {Promise<Response>}
 */
export async function probeOnce(baseUrl, route, opts = {}) {
  const fetchImpl = opts.fetch ?? fetch;
  const url = buildProbeUrl(baseUrl, route);
  return fetchImpl(url, { headers: opts.headers ?? {}, redirect: "manual" });
}

/**
 * Probe every route, requiring HTTP 200 AND an exact `X-Moedict-Release`
 * header match on each. Throws immediately (aborts) naming the failing
 * route on the first non-200 status or header mismatch.
 * @param {string} baseUrl
 * @param {string[]} routes
 * @param {string} releaseTag
 * @param {Record<string, string>} headers
 * @param {{ fetch?: FetchFn }} opts
 * @param {string} probeLabel
 */
async function probeRoutes(baseUrl, routes, releaseTag, headers, opts, probeLabel) {
  validateBaseUrl(baseUrl);
  validateRoutes(routes);
  if (!nonEmptyString(releaseTag)) throw new Error("releaseTag must be a non-empty string");

  const results = [];
  for (const route of routes) {
    const response = await probeOnce(baseUrl, route, { fetch: opts.fetch, headers });
    if (response.status !== 200) {
      throw new Error(
        `${probeLabel} failed for route ${route}: expected 200, got ${response.status}`,
      );
    }
    const releaseHeader = response.headers.get(RELEASE_HEADER);
    if (releaseHeader !== releaseTag) {
      throw new Error(
        `${probeLabel} failed for route ${route}: ${RELEASE_HEADER} mismatch ` +
          `(expected ${JSON.stringify(releaseTag)}, got ${JSON.stringify(releaseHeader)})`,
      );
    }
    results.push({ route, status: response.status });
  }
  return { ok: true, results };
}

/**
 * Smoke-test a newly-uploaded version at 0% traffic using the exact
 * `Cloudflare-Workers-Version-Overrides: <workerName>="<versionUuid>"`
 * header syntax (key = exact Worker name, value = new version UUID).
 * @param {string} baseUrl
 * @param {string} workerName
 * @param {string} versionUuid
 * @param {string[]} routes
 * @param {string} releaseTag
 * @param {{ fetch?: FetchFn }} [opts]
 */
export async function smokeWithVersionOverride(
  baseUrl,
  workerName,
  versionUuid,
  routes,
  releaseTag,
  opts = {},
) {
  if (!nonEmptyString(workerName)) throw new Error("workerName must be a non-empty string");
  if (!nonEmptyString(versionUuid)) throw new Error("versionUuid must be a non-empty string");
  const headers = { [OVERRIDE_HEADER]: `${workerName}="${versionUuid}"` };
  return probeRoutes(baseUrl, routes, releaseTag, headers, opts, "Version-override smoke probe");
}

/**
 * Final smoke check WITHOUT the override header — exercises whatever is
 * actually serving live traffic. Still requires 200 + matching release
 * header on every route.
 * @param {string} baseUrl
 * @param {string[]} routes
 * @param {string} releaseTag
 * @param {{ fetch?: FetchFn }} [opts]
 */
export async function finalSmoke(baseUrl, routes, releaseTag, opts = {}) {
  return probeRoutes(baseUrl, routes, releaseTag, {}, opts, "Final smoke probe");
}

/**
 * Probe every route every `intervalMs` (default 5s) for at least
 * `durationMs` (default 120s), requiring 200 + matching release header each
 * cycle. Aborts (throws) on the first failing route. `sleep` is injected and
 * drives the module's own elapsed-time bookkeeping — no wall-clock `Date.now`
 * is read for timing, so tests are fully deterministic with a fake sleep
 * that resolves immediately.
 * @param {string} baseUrl
 * @param {string[]} routes
 * @param {string} releaseTag
 * @param {{ fetch?: FetchFn; sleep?: (ms: number) => Promise<void>; intervalMs?: number; durationMs?: number }} [opts]
 * @returns {Promise<{ ok: true; cycles: number; elapsedMs: number }>}
 */
export async function continuousProbe(baseUrl, routes, releaseTag, opts = {}) {
  validateBaseUrl(baseUrl);
  validateRoutes(routes);
  if (!nonEmptyString(releaseTag)) throw new Error("releaseTag must be a non-empty string");

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS;
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error(`intervalMs must be a positive integer: ${JSON.stringify(intervalMs)}`);
  }
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new Error(`durationMs must be a positive integer: ${JSON.stringify(durationMs)}`);
  }
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let elapsedMs = 0;
  let cycles = 0;
  for (;;) {
    for (const route of routes) {
      const response = await probeOnce(baseUrl, route, { fetch: opts.fetch });
      if (response.status !== 200) {
        throw new Error(
          `continuousProbe failed for route ${route}: expected 200, got ${response.status} (cycle ${cycles + 1})`,
        );
      }
      const releaseHeader = response.headers.get(RELEASE_HEADER);
      if (releaseHeader !== releaseTag) {
        throw new Error(
          `continuousProbe failed for route ${route}: ${RELEASE_HEADER} mismatch ` +
            `(expected ${JSON.stringify(releaseTag)}, got ${JSON.stringify(releaseHeader)}) (cycle ${cycles + 1})`,
        );
      }
    }
    cycles += 1;
    if (elapsedMs >= durationMs) {
      return { ok: true, cycles, elapsedMs };
    }
    await sleep(intervalMs);
    elapsedMs += intervalMs;
  }
}
