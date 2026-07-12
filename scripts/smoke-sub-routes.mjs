const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

const baseUrl = (process.argv[2] || DEFAULT_BASE_URL).replace(/\/+$/, "");

const cases = [
  {
    name: "a route",
    path: "/a/%E8%90%8C.json",
    expectStatus: 200,
    expect: (json) => typeof json === "object" && json !== null && !Array.isArray(json),
    hint: "預期回傳詞條物件",
  },
  {
    name: "t route",
    path: "/t/%E4%86%80.json",
    expectStatus: 200,
    expect: (json) => typeof json === "object" && json !== null && !Array.isArray(json),
    hint: "預期回傳詞條物件",
  },
  {
    name: "h route",
    path: "/h/%E3%90%81.json",
    expectStatus: 200,
    expect: (json) => typeof json === "object" && json !== null && !Array.isArray(json),
    hint: "預期回傳詞條物件",
  },
  {
    name: "c route",
    path: "/c/%E4%B8%8A%E8%A8%B4.json",
    expectStatus: 200,
    expect: (json) => typeof json === "object" && json !== null && !Array.isArray(json),
    hint: "預期回傳詞條物件",
  },
  {
    name: "raw route",
    path: "/raw/%E8%90%8C.json",
    expectStatus: 200,
    expect: (json) =>
      typeof json === "object" &&
      json !== null &&
      typeof json.title === "string" &&
      Array.isArray(json.heteronyms),
    hint: "預期含 title / heteronyms",
  },
  {
    name: "uni route",
    path: "/uni/%E8%90%8C.json",
    expectStatus: 200,
    expect: (json) =>
      typeof json === "object" &&
      json !== null &&
      typeof json.title === "string" &&
      Array.isArray(json.heteronyms),
    hint: "預期含 title / heteronyms",
  },
  {
    name: "pua route",
    path: "/pua/%E8%90%8C.json",
    expectStatus: 200,
    expect: (json) =>
      typeof json === "object" &&
      json !== null &&
      typeof json.title === "string" &&
      Array.isArray(json.heteronyms),
    hint: "預期含 title / heteronyms",
  },
];

function truncate(value, max = 120) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

async function runCase(testCase) {
  const url = `${baseUrl}${testCase.path}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  const contentType = response.headers.get("content-type") || "";
  const bodyText = await response.text();

  let parsed = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    throw new Error(
      `${testCase.name}: 回應不是合法 JSON, status=${response.status}, content-type=${contentType}, body=${truncate(bodyText)}`,
    );
  }

  if (response.status !== testCase.expectStatus) {
    throw new Error(
      `${testCase.name}: status 不符, expected=${testCase.expectStatus}, actual=${response.status}, body=${truncate(parsed)}`,
    );
  }

  if (!testCase.expect(parsed)) {
    throw new Error(`${testCase.name}: JSON 結構不符 (${testCase.hint}), body=${truncate(parsed)}`);
  }

  console.log(`PASS ${testCase.name} -> ${response.status} ${testCase.path}`);
}

async function main() {
  console.log(`Running sub-route smoke tests on: ${baseUrl}`);
  for (const testCase of cases) {
    await runCase(testCase);
  }
  console.log(`All ${cases.length} sub-route smoke tests passed.`);
}

main().catch((error) => {
  console.error("Smoke test failed.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
