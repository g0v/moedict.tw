/** Helpers for integration tests that call the running Miniflare server. */

export function getBaseUrl(): string {
  const url = process.env.TEST_SERVER_URL;
  if (!url) throw new Error("TEST_SERVER_URL not set — globalSetup did not run?");
  return url.replace(/\/+$/, "");
}

export async function fetchFromServer(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${getBaseUrl()}${path}`, init);
}

export async function fetchJson<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetchFromServer(path, init);
  const text = await res.text();
  let body: T;
  try {
    body = text ? (JSON.parse(text) as T) : (null as T);
  } catch {
    throw new Error(
      `Expected JSON from ${path} but got (status=${res.status}): ${text.slice(0, 200)}`,
    );
  }
  return { status: res.status, body, headers: res.headers };
}
