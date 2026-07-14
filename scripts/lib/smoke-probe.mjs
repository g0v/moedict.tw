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
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_VERSION_OVERRIDE_RETRY_ATTEMPTS = 7;
const DEFAULT_VERSION_OVERRIDE_RETRY_INTERVAL_MS = 10000;
const DEFAULT_PROPAGATION_GRACE_MS = 60000;
const DEFAULT_PROPAGATION_RETRY_INTERVAL_MS = 10000;
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

function validatePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer: ${JSON.stringify(value)}`);
  }
}

function validateNonNegativeInteger(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer: ${JSON.stringify(value)}`);
  }
}

function releaseMismatchError(probeLabel, route, releaseTag, observed) {
  return new Error(
    `${probeLabel} failed for route ${route}: ${RELEASE_HEADER} mismatch ` +
      `(expected ${JSON.stringify(releaseTag)}, got ${JSON.stringify(observed)})`,
  );
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
 * Issue a single cache-busted probe request, bounded by a per-request
 * timeout (default 10s) via `AbortController`. A hang (network stall, dead
 * Worker) aborts and throws naming the route rather than hanging the
 * orchestrator forever. `setTimeoutFn`/`clearTimeoutFn` are injected so
 * tests can fire the timeout deterministically without a real wait; the
 * timer is always cleared, on both the success and failure paths.
 * @param {string} baseUrl
 * @param {string} route
 * @param {{ fetch?: FetchFn; headers?: Record<string, string>; timeoutMs?: number; setTimeoutFn?: typeof setTimeout; clearTimeoutFn?: typeof clearTimeout }} [opts]
 * @returns {Promise<Response>}
 */
export async function probeOnce(baseUrl, route, opts = {}) {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  validatePositiveInteger("timeoutMs", timeoutMs);
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
  const url = buildProbeUrl(baseUrl, route);
  const controller = new AbortController();
  const timer = setTimeoutFn(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      headers: opts.headers ?? {},
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Probe timed out for route ${route} after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeoutFn(timer);
  }
}

/**
 * Probe every route, requiring HTTP 200 AND an exact `X-Moedict-Release`
 * header match on each. Throws immediately (aborts) naming the failing
 * route on the first non-200 status or header mismatch.
 * @param {string} baseUrl
 * @param {string[]} routes
 * @param {string} releaseTag
 * @param {Record<string, string>} headers
 * @param {{ fetch?: FetchFn; timeoutMs?: number; setTimeoutFn?: typeof setTimeout; clearTimeoutFn?: typeof clearTimeout }} opts
 * @param {string} probeLabel
 */
async function probeRoutes(baseUrl, routes, releaseTag, headers, opts, probeLabel) {
  validateBaseUrl(baseUrl);
  validateRoutes(routes);
  if (!nonEmptyString(releaseTag)) throw new Error("releaseTag must be a non-empty string");

  const results = [];
  for (const route of routes) {
    const response = await probeOnce(baseUrl, route, {
      fetch: opts.fetch,
      headers,
      timeoutMs: opts.timeoutMs,
      setTimeoutFn: opts.setTimeoutFn,
      clearTimeoutFn: opts.clearTimeoutFn,
    });
    if (response.status !== 200) {
      throw new Error(
        `${probeLabel} failed for route ${route}: expected 200, got ${response.status}`,
      );
    }
    const releaseHeader = response.headers.get(RELEASE_HEADER);
    if (releaseHeader !== releaseTag) {
      throw releaseMismatchError(probeLabel, route, releaseTag, releaseHeader);
    }
    results.push({ route, status: response.status });
  }
  return { ok: true, results };
}

/**
 * Version-override-only route probe. Unlike the ordinary final/continuous
 * probes, this can see a transient old release while Cloudflare propagates
 * the new gradual deployment split to every edge. Retry ONLY that exact,
 * caller-identified prior release; every other failure remains fail-closed.
 * @param {string} baseUrl
 * @param {string[]} routes
 * @param {string} releaseTag
 * @param {string} priorReleaseTag
 * @param {Record<string, string>} headers
 * @param {{ fetch?: FetchFn; timeoutMs?: number; setTimeoutFn?: typeof setTimeout; clearTimeoutFn?: typeof clearTimeout; sleep?: (ms: number) => Promise<void>; overrideRetryAttempts?: number; overrideRetryIntervalMs?: number; log?: (message: string) => void }} opts
 */
async function probeRoutesWithVersionOverridePropagationRetry(
  baseUrl,
  routes,
  releaseTag,
  priorReleaseTag,
  headers,
  opts,
) {
  validateBaseUrl(baseUrl);
  validateRoutes(routes);
  if (!nonEmptyString(releaseTag)) throw new Error("releaseTag must be a non-empty string");
  if (!nonEmptyString(priorReleaseTag)) {
    throw new Error("priorReleaseTag must be a non-empty string");
  }
  if (priorReleaseTag === releaseTag) {
    throw new Error("priorReleaseTag must differ from releaseTag");
  }

  const attempts = opts.overrideRetryAttempts ?? DEFAULT_VERSION_OVERRIDE_RETRY_ATTEMPTS;
  const intervalMs = opts.overrideRetryIntervalMs ?? DEFAULT_VERSION_OVERRIDE_RETRY_INTERVAL_MS;
  validatePositiveInteger("overrideRetryAttempts", attempts);
  validatePositiveInteger("overrideRetryIntervalMs", intervalMs);
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? ((message) => console.warn(message));

  const results = [];
  for (const route of routes) {
    let lastOldReleaseErr;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await probeOnce(baseUrl, route, {
        fetch: opts.fetch,
        headers,
        timeoutMs: opts.timeoutMs,
        setTimeoutFn: opts.setTimeoutFn,
        clearTimeoutFn: opts.clearTimeoutFn,
      });
      if (response.status !== 200) {
        throw new Error(
          `Version-override smoke probe failed for route ${route}: expected 200, got ${response.status}`,
        );
      }
      const releaseHeader = response.headers.get(RELEASE_HEADER);
      if (releaseHeader === releaseTag) {
        results.push({ route, status: response.status, attempts: attempt });
        lastOldReleaseErr = undefined;
        break;
      }
      if (releaseHeader !== priorReleaseTag) {
        throw releaseMismatchError(
          "Version-override smoke probe",
          route,
          releaseTag,
          releaseHeader,
        );
      }

      lastOldReleaseErr = releaseMismatchError(
        "Version-override smoke probe",
        route,
        releaseTag,
        releaseHeader,
      );
      if (attempt < attempts) {
        log(
          `Version-override smoke probe route ${route} attempt ${attempt}/${attempts} still saw prior release ${JSON.stringify(releaseHeader)}; retrying after ${intervalMs}ms`,
        );
        await sleep(intervalMs);
      }
    }
    if (lastOldReleaseErr) throw lastOldReleaseErr;
  }
  return { ok: true, results };
}

/**
 * Smoke-test a newly-uploaded version at 0% traffic using the exact
 * `Cloudflare-Workers-Version-Overrides: <workerName>="<versionUuid>"`
 * header syntax (key = exact Worker name, value = new version UUID). The
 * caller must pass `priorReleaseTag` so propagation polling retries only a
 * known-safe old release, never arbitrary mismatches.
 * @param {string} baseUrl
 * @param {string} workerName
 * @param {string} versionUuid
 * @param {string[]} routes
 * @param {string} releaseTag
 * @param {{ fetch?: FetchFn; priorReleaseTag?: string; sleep?: (ms: number) => Promise<void>; overrideRetryAttempts?: number; overrideRetryIntervalMs?: number; log?: (message: string) => void }} [opts]
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
  if (opts.priorReleaseTag !== undefined) {
    return probeRoutesWithVersionOverridePropagationRetry(
      baseUrl,
      routes,
      releaseTag,
      opts.priorReleaseTag,
      headers,
      opts,
    );
  }
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
 * healthy cycle. If `priorReleaseTag` is provided, the exact known prior
 * release may appear only during one bounded settling grace window; every
 * sighting resets the healthy soak so the final success still represents an
 * uninterrupted `durationMs` on the new release after the last old response.
 * `sleep` is injected and drives elapsed-time bookkeeping — no wall-clock
 * `Date.now` is read, so tests are fully deterministic.
 * @param {string} baseUrl
 * @param {string[]} routes
 * @param {string} releaseTag
 * @param {{ fetch?: FetchFn; sleep?: (ms: number) => Promise<void>; intervalMs?: number; durationMs?: number; timeoutMs?: number; setTimeoutFn?: typeof setTimeout; clearTimeoutFn?: typeof clearTimeout; priorReleaseTag?: string; propagationGraceMs?: number; propagationRetryIntervalMs?: number; log?: (message: string) => void }} [opts]
 * @returns {Promise<{ ok: true; cycles: number; elapsedMs: number }>}
 */
export async function continuousProbe(baseUrl, routes, releaseTag, opts = {}) {
  validateBaseUrl(baseUrl);
  validateRoutes(routes);
  if (!nonEmptyString(releaseTag)) throw new Error("releaseTag must be a non-empty string");

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS;
  validatePositiveInteger("intervalMs", intervalMs);
  validatePositiveInteger("durationMs", durationMs);
  const hasPriorRelease = opts.priorReleaseTag !== undefined;
  if (hasPriorRelease) {
    if (!nonEmptyString(opts.priorReleaseTag)) {
      throw new Error("priorReleaseTag must be a non-empty string");
    }
    if (opts.priorReleaseTag === releaseTag) {
      throw new Error("priorReleaseTag must differ from releaseTag");
    }
  }
  const priorReleaseTag = opts.priorReleaseTag;
  const propagationGraceMs = hasPriorRelease
    ? (opts.propagationGraceMs ?? DEFAULT_PROPAGATION_GRACE_MS)
    : 0;
  validateNonNegativeInteger("propagationGraceMs", propagationGraceMs);
  const propagationRetryIntervalMs =
    opts.propagationRetryIntervalMs ?? DEFAULT_PROPAGATION_RETRY_INTERVAL_MS;
  validatePositiveInteger("propagationRetryIntervalMs", propagationRetryIntervalMs);
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? ((message) => console.warn(message));
  let elapsedMs = 0;
  let cycles = 0;
  let settlingElapsedMs = 0;

  const recordSleep = async (ms) => {
    const settlingRemainingMs = propagationGraceMs - settlingElapsedMs;
    const sleepMs =
      hasPriorRelease && settlingRemainingMs > 0 ? Math.min(ms, settlingRemainingMs) : ms;
    await sleep(sleepMs);
    if (hasPriorRelease) {
      settlingElapsedMs = Math.min(propagationGraceMs, settlingElapsedMs + sleepMs);
    }
    return sleepMs;
  };

  const oldReleaseFailure = (route, observed) =>
    new Error(
      `continuousProbe failed for route ${route}: ${RELEASE_HEADER} still served prior release ` +
        `(expected ${JSON.stringify(releaseTag)}, got ${JSON.stringify(observed)}, ` +
        `settling grace ${settlingElapsedMs}/${propagationGraceMs}ms)`,
    );

  for (;;) {
    let sawPriorReleaseThisCycle = false;
    for (const route of routes) {
      for (;;) {
        const response = await probeOnce(baseUrl, route, {
          fetch: opts.fetch,
          timeoutMs: opts.timeoutMs,
          setTimeoutFn: opts.setTimeoutFn,
          clearTimeoutFn: opts.clearTimeoutFn,
        });
        if (response.status !== 200) {
          throw new Error(
            `continuousProbe failed for route ${route}: expected 200, got ${response.status} (cycle ${cycles + 1})`,
          );
        }
        const releaseHeader = response.headers.get(RELEASE_HEADER);
        if (releaseHeader === releaseTag) break;
        if (!hasPriorRelease || releaseHeader !== priorReleaseTag) {
          throw new Error(
            `continuousProbe failed for route ${route}: ${RELEASE_HEADER} mismatch ` +
              `(expected ${JSON.stringify(releaseTag)}, got ${JSON.stringify(releaseHeader)}) (cycle ${cycles + 1})`,
          );
        }
        elapsedMs = 0;
        cycles = 0;
        sawPriorReleaseThisCycle = true;
        log(
          `continuousProbe route ${route} saw prior release ${JSON.stringify(releaseHeader)} ` +
            `after ${settlingElapsedMs}/${propagationGraceMs}ms settling grace; resetting healthy soak`,
        );
        if (settlingElapsedMs >= propagationGraceMs) {
          throw oldReleaseFailure(route, releaseHeader);
        }
        await recordSleep(propagationRetryIntervalMs);
      }
      if (sawPriorReleaseThisCycle) break;
    }
    if (sawPriorReleaseThisCycle) continue;
    cycles += 1;
    if (elapsedMs >= durationMs) {
      return { ok: true, cycles, elapsedMs };
    }
    elapsedMs += await recordSleep(intervalMs);
  }
}
