# MoeDict Workers Cache Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Cloudflare's new front-of-Worker Workers Cache for `moedict.tw` using `Vary: Origin` to safely cache CORS-enabled API endpoints and R2 dictionary requests.

**Architecture:** Upgrade Wrangler to `^4.107.0` and bump `compatibility_date` to `2026-07-07` in `wrangler.jsonc`. Enable `"cache": { "enabled": true }`. Add `'Vary': 'Origin'` to all CORS header helpers so that the Workers Cache correctly partitions cached API responses per request origin, preventing CORS failures. Enable cache control headers on the dictionary API endpoints.

**Tech Stack:** Cloudflare Workers, TypeScript, Bun, Vitest

## Global Constraints
- Do not use `: any` or `as any` (strictly enforce type safety).
- Ensure that the browser test suite and integration tests compile and run cleanly.

---

### Task 1: Update Toolchain and Config

**Files:**
- Modify: `../moedict.tw/package.json`
- Modify: `../moedict.tw/wrangler.jsonc`

- [ ] **Step 1: Upgrade wrangler in package.json**
Run: `bun add -d wrangler@latest` inside `../moedict.tw`.
Expected: Installs `wrangler@4.107.0` or higher.

- [ ] **Step 2: Enable cache and update compatibility_date in wrangler.jsonc**
Modify `compatibility_date` to `"2026-07-07"` and add `"cache": { "enabled": true }`.

- [ ] **Step 3: Run wrangler types to verify config**
Run: `bunx wrangler types` inside `../moedict.tw`.
Expected: Generates project types without warnings about unexpected fields.

---

### Task 2: Implement Vary: Origin on CORS Headers

**Files:**
- Modify: `../moedict.tw/worker/index.ts`
- Modify: `../moedict.tw/src/api/handleDictionaryAPI.ts`
- Modify: `../moedict.tw/src/api/handleListAPI.ts`

- [ ] **Step 1: Update corsHeaders helper in worker/index.ts**
Modify the API request CORS headers in `worker/index.ts` (around line 420) to include `'Vary': 'Origin'`.
```typescript
      const corsHeaders = {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
      };
```

- [ ] **Step 2: Update getCORSHeaders helper in src/api/handleDictionaryAPI.ts**
Modify `getCORSHeaders` in `src/api/handleDictionaryAPI.ts` (around line 309) to return `Vary: 'Origin'`.
```typescript
function getCORSHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
```

- [ ] **Step 3: Update corsHeaders helper in src/api/handleListAPI.ts**
Modify `corsHeaders` in `src/api/handleListAPI.ts` (around line 56) to return `Vary: 'Origin'`.
```typescript
function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
```

---

### Task 3: Enable Caching for Dictionary APIs

**Files:**
- Modify: `../moedict.tw/src/api/handleDictionaryAPI.ts`

- [ ] **Step 1: Add Cache-Control header to dictionary jsonResponse**
Modify `jsonResponse` in `src/api/handleDictionaryAPI.ts` (around line 318) to set `Cache-Control: public, max-age=86400, stale-while-revalidate=604800` for GET requests (status 200) so they can be cached by Workers Cache.
```typescript
function jsonResponse(request: Request, payload: unknown, status = 200, pretty = true): Response {
  const body = pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...getCORSHeaders(request),
  });
  
  if (request.method === 'GET' && status === 200) {
    headers.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  }

  return new Response(body, {
    status,
    headers,
  });
}
```

---

### Task 4: Verification

- [ ] **Step 1: Run typecheck**
Run: `bun run typecheck` inside `../moedict.tw`.
Expected: PASS

- [ ] **Step 2: Run unit and integration tests**
Run: `bun run test` inside `../moedict.tw`.
Expected: PASS
