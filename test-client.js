/**
 * Test client for the FHIR Auto-Fixer MCP server v2.0
 * Run: node test-client.js
 * Make sure HAPI FHIR is running on localhost:8080 first.
 */

import { spawn } from "child_process";

const brokenPatient = {
  resourceType: "Patient",
  id: "example-broken",
  name: [{ use: "primary", family: "Smith", given: ["John"] }],
  gender: "male_patient",
  birthDate: "01/15/1985",
};

const brokenObservation = {
  resourceType: "Observation",
  id: "obs-001",
  status: "final_result",
  code: { text: "Blood pressure" },
  subject: { reference: "Patient/example-broken" },
};

const testBundle = {
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { resource: brokenPatient },
    { resource: brokenObservation },
  ],
};

let msgId = 1;
function makeRequest(method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id: msgId++, method, params }) + "\n";
}

const server = spawn("node", ["index.js"], {
  cwd: new URL(".", import.meta.url).pathname,
  env: { ...process.env },
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const pending = new Map();

server.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* ignore non-JSON */ }
  }
});

function send(method, params) {
  return new Promise((resolve) => {
    const id = msgId;
    pending.set(id, resolve);
    server.stdin.write(makeRequest(method, params));
  });
}

function parse(result) {
  const text = result?.result?.content?.[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function run() {
  console.log("=== FHIR Auto-Fixer MCP Test Client v2.0 ===\n");

  // Initialize
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "2.0.0" },
  });
  console.log("1. Server:", init.result?.serverInfo?.name, "v" + init.result?.serverInfo?.version);

  // List tools
  const toolsResult = await send("tools/list", {});
  const tools = toolsResult.result?.tools?.map((t) => t.name) ?? [];
  console.log("2. Tools:", tools.join(", "));

  // -----------------------------------------------------------------------
  // Test 1: validate_and_fix — single broken Patient (base FHIR)
  // -----------------------------------------------------------------------
  console.log("\n--- Test 1: validate_and_fix (base FHIR) ---");
  const fix1 = parse(await send("tools/call", {
    name: "validate_and_fix",
    arguments: { resource: JSON.stringify(brokenPatient) },
  }));

  if (fix1) {
    console.log("Success:", fix1.success);
    if (!fix1.success) console.log("Error:", fix1.error);
    console.log("Fixed passes validation:", fix1.fixed_passes_validation);
    console.log("Average confidence:", fix1.average_confidence + "%");

    console.log("\nFixes with confidence scores:");
    for (const f of fix1.fixes ?? []) {
      console.log(`  [${f.confidence}%] ${f.field}: "${f.original_value}" → "${f.corrected_value}"`);
      console.log(`         Technical: ${f.explanation}`);
      if (f.clinical_explanation) {
        console.log(`         Clinical:  ${f.clinical_explanation}`);
      }
      if (f.confidence < 75) {
        console.log(`         ⚠ LOW CONFIDENCE: ${f.confidence_reason}`);
      }
    }

    console.log("\nBefore/after diff:");
    for (const d of fix1.diff ?? []) {
      console.log(`  ${d.field}: "${d.before}" → "${d.after}"`);
    }

    // NEW: Report card
    if (fix1.report_card) {
      console.log("\n📊 Report Card:");
      console.log(`   Before: ${fix1.report_card.before.grade} (score: ${fix1.report_card.before.score}) — ${fix1.report_card.before.summary}`);
      console.log(`   After:  ${fix1.report_card.after.grade} (score: ${fix1.report_card.after.score}) — ${fix1.report_card.after.summary}`);
      console.log(`   Improvement: ${fix1.report_card.improvement}`);
    } else {
      console.log("\n⚠ No report card in response — check index.js is returning report_card field");
    }

    // NEW: Auto-detected profile
    if (fix1.profile_auto_detected) {
      console.log("\n🎯 Auto-detected profile:", fix1.profile_detection_note);
    }

    console.log("\nFixed resource:");
    console.log(JSON.stringify(fix1.fixed_resource, null, 4));
  }

  // -----------------------------------------------------------------------
  // Test 2: validate_and_fix — US Core profile
  // -----------------------------------------------------------------------
  console.log("\n--- Test 2: validate_and_fix (US Core) ---");
  const fix2 = parse(await send("tools/call", {
    name: "validate_and_fix",
    arguments: {
      resource: JSON.stringify(brokenPatient),
      use_us_core: true,
    },
  }));

  if (fix2) {
    console.log("Validated against:", fix2.validated_against_profile ?? "base FHIR");
    console.log("Success:", fix2.success);
    console.log("Fixed passes validation:", fix2.fixed_passes_validation);

    // NEW: Report card for US Core
    if (fix2.report_card) {
      console.log(`\n📊 Report Card: ${fix2.report_card.before.grade} → ${fix2.report_card.after.grade}`);
      console.log(`   Improvement: ${fix2.report_card.improvement}`);
    }

    // NEW: Auto-detected profile
    if (fix2.profile_auto_detected) {
      console.log("🎯 Profile auto-detected:", fix2.profile_detection_note);
    }

    if (fix2.low_confidence_fixes?.length) {
      console.log("⚠ Low confidence fixes:", fix2.low_confidence_fixes.length);
    }
  }

  // -----------------------------------------------------------------------
  // Test 3: Bundle validation and fixing
  // -----------------------------------------------------------------------
  console.log("\n--- Test 3: Bundle validate_and_fix ---");
  const fix3 = parse(await send("tools/call", {
    name: "validate_and_fix",
    arguments: { resource: JSON.stringify(testBundle) },
  }));

  if (fix3) {
    console.log("Is Bundle:", fix3.is_bundle);
    console.log(`Total entries: ${fix3.total_entries} | Fixed: ${fix3.total_fixed} | Already valid: ${fix3.total_already_valid} | Failed: ${fix3.total_failed}`);
    for (const r of fix3.entry_results ?? []) {
      const status = r.already_valid ? "✓ already valid" : r.success ? "✓ fixed" : "✗ failed";
      console.log(`  [${r.index}] ${r.resourceType} ${r.id}: ${status}`);
      if (r.fixes?.length) {
        for (const f of r.fixes) {
          console.log(`       [${f.confidence}%] ${f.field}: "${f.original_value}" → "${f.corrected_value}"`);
          if (f.clinical_explanation) {
            console.log(`       Clinical: ${f.clinical_explanation}`);
          }
        }
      }
      if (r.report_card) {
        console.log(`       📊 ${r.report_card.before.grade} → ${r.report_card.after.grade}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Test 4: batch_validate_and_fix
  // -----------------------------------------------------------------------
  console.log("\n--- Test 4: batch_validate_and_fix ---");
  const batch = parse(await send("tools/call", {
    name: "batch_validate_and_fix",
    arguments: {
      resources: [
        JSON.stringify(brokenPatient),
        JSON.stringify(brokenObservation),
        JSON.stringify({ resourceType: "Patient", id: "already-good", gender: "female", birthDate: "1990-06-15" }),
      ],
    },
  }));

  if (batch) {
    const s = batch.summary;
    console.log(`Summary: ${s.total} total | ${s.fixed} fixed | ${s.already_valid} already valid | ${s.failed} failed`);
    if (s.resources_with_low_confidence_fixes > 0) {
      console.log(`⚠ ${s.resources_with_low_confidence_fixes} resource(s) had low-confidence fixes — review manually`);
    }
    for (const r of batch.results ?? []) {
      const status = r.already_valid ? "✓ already valid" : r.success ? "✓ fixed" : "✗ " + r.error;
      console.log(`  [${r.index}] ${r.resourceType} ${r.id}: ${status} (avg confidence: ${r.average_confidence ?? "n/a"}%)`);
      if (r.report_card) {
        console.log(`       📊 ${r.report_card.before.grade} → ${r.report_card.after.grade}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Test 5: explain_error
  // -----------------------------------------------------------------------
  console.log("\n--- Test 5: explain_error ---");
  const explain = parse(await send("tools/call", {
    name: "explain_error",
    arguments: {
      error_message: "The value provided ('male_patient') was not found in the value set 'AdministrativeGender'",
      resource_type: "Patient",
    },
  }));

  if (explain) {
    console.log("Plain English:", explain.plain_english);
    console.log("Root Cause:", explain.root_cause);
    console.log("Fix Example:", explain.fix_example);
  }

  // -----------------------------------------------------------------------
  // Test 6: list_profiles
  // -----------------------------------------------------------------------
  console.log("\n--- Test 6: list_profiles ---");
  const profiles = parse(await send("tools/call", { name: "list_profiles", arguments: {} }));
  if (profiles) {
    console.log("FHIR version:", profiles.fhir_version);
    console.log("Software:", profiles.software, profiles.software_version);
    console.log("Server profiles:", profiles.total_server_profiles);
    console.log("US Core profiles built-in:", profiles.us_core_profiles_available?.length);
  }

  // -----------------------------------------------------------------------
  // Test 7: NEW — test auto-detection with Observation
  // -----------------------------------------------------------------------
  console.log("\n--- Test 7: Auto-detection with Observation ---");
  const fix7 = parse(await send("tools/call", {
    name: "validate_and_fix",
    arguments: {
      resource: JSON.stringify(brokenObservation),
      use_us_core: true,
    },
  }));

  if (fix7) {
    console.log("Success:", fix7.success);
    console.log("Validated against:", fix7.validated_against_profile ?? "base FHIR");
    if (fix7.profile_auto_detected) {
      console.log("🎯 Auto-detected:", fix7.profile_detection_note);
    }
    if (fix7.report_card) {
      console.log(`📊 Report Card: ${fix7.report_card.before.grade} → ${fix7.report_card.after.grade}`);
      console.log(`   Before: ${fix7.report_card.before.summary}`);
      console.log(`   After:  ${fix7.report_card.after.summary}`);
    }
    console.log("\nFixes:");
    for (const f of fix7.fixes ?? []) {
      console.log(`  [${f.confidence}%] ${f.field}: "${f.original_value}" → "${f.corrected_value}"`);
      if (f.clinical_explanation) {
        console.log(`  Clinical: ${f.clinical_explanation}`);
      }
    }
  }

  console.log("\n=== All tests complete ===");
  server.kill();
  process.exit(0);
}

run().catch((err) => {
  console.error("Test failed:", err);
  server.kill();
  process.exit(1);
});