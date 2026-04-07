const { EventSource: _namedES, default: _defaultES } = await import("eventsource");
const EventSourceCtor = _namedES ?? _defaultES?.EventSource ?? _defaultES;

const BASE_URL = process.env.BASE_URL ?? "https://851756db-af63-44b5-92d4-a0fe75d55d29-00-2e1p61w3w197g.spock.replit.dev";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 120000);

const brokenPatient = {
  resourceType: "Patient",
  id: "example-broken",
  name: [{ use: "primary", family: "Smith", given: ["John"] }],
  gender: "male_patient",
  birthDate: "01/15/1985",
};

let sessionId = null;
let finished = false;
let timeoutHandle = null;

function safeExit(es, code = 0) {
  if (finished) return;
  finished = true;
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (es && typeof es.close === "function") es.close();
  process.exit(code);
}

async function getFetch() {
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  const mod = await import("node-fetch");
  return (mod.default ?? mod).bind(globalThis);
}

async function post(fetchImpl, body) {
  if (!sessionId) throw new Error("No sessionId yet");
  const response = await fetchImpl(`${BASE_URL}/messages?sessionId=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  console.log(`POST ${body.method ?? body.jsonrpc} -> ${response.status}: ${text.substring(0, 100)}`);
  if (!response.ok) throw new Error(`POST failed (${response.status}): ${text}`);
}

async function run() {
  const fetchImpl = await getFetch();

  const healthRes = await fetchImpl(`${BASE_URL}/`);
  const health = await healthRes.json();
  console.log("Health:", health.hapi_endpoint);

  const es = new EventSourceCtor(`${BASE_URL}/sse`);

  timeoutHandle = setTimeout(() => {
    console.error("Timeout — no response received");
    safeExit(es, 1);
  }, REQUEST_TIMEOUT_MS);

  es.onopen = () => console.log("SSE connected");

  es.onmessage = async (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.id === 1 && !initialized) {
        initialized = true;
        await post(fetchImpl, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        await post(fetchImpl, {
          jsonrpc: "2.0", id: 2, method: "tools/call",
          params: { name: "validate_and_fix", arguments: { resource: JSON.stringify(brokenPatient) } },
        });
        console.log("Sent tools/call — waiting for result...");
        return;
      }
      if (msg.id === 2) {
        const text = msg?.result?.content?.[0]?.text;
        if (text) {
          const result = JSON.parse(text);
          console.log("\n=== RESULT ===");
          console.log("Success:", result.success);
          console.log("Fixed passes validation:", result.fixed_passes_validation);
          console.log("Report card:", result.report_card?.improvement);
          console.log("Confidence:", result.average_confidence + "%");
          console.log("Fixes:");
          for (const f of result.fixes ?? []) {
            console.log(`  [${f.confidence}%] ${f.field}: "${f.original_value}" -> "${f.corrected_value}"`);
            if (f.clinical_explanation) console.log(`  Clinical: ${f.clinical_explanation}`);
          }
        }
        safeExit(es, 0);
      }
    } catch (err) {
      console.error("Parse error:", err.message);
    }
  };

  es.addEventListener("endpoint", async (e) => {
    try {
      const endpointUrl = new URL(e.data, BASE_URL);
      sessionId = endpointUrl.searchParams.get("sessionId");
      console.log("Session:", sessionId);

      await post(fetchImpl, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-render", version: "1.1" },
        },
      });

      await new Promise(r => setTimeout(r, 2000));

      await post(fetchImpl, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      });

      await post(fetchImpl, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "validate_and_fix",
          arguments: { resource: JSON.stringify(brokenPatient) },
        },
      });

      console.log("All requests sent — waiting for SSE responses...");
    } catch (err) {
      console.error("Error:", err.message);
      safeExit(es, 1);
    }
  });

  es.onerror = (err) => {
    console.error("SSE error:", err?.message ?? err?.type ?? "unknown");
  };
}

run().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});