import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Anthropic from "@anthropic-ai/sdk";
import fetch, { Headers, Request, Response } from "node-fetch";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, unlink, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import cors from "cors";

const execAsync = promisify(exec);

if (!globalThis.fetch) {
  globalThis.fetch = fetch;
  globalThis.Headers = Headers;
  globalThis.Request = Request;
  globalThis.Response = Response;
}

const HAPI_BASE_URL = process.env.HAPI_FHIR_URL ?? "https://hapi.fhir.org/baseR4";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  fetch: fetch,
});

const JAR_PATH = join(process.cwd(), "validator_cli.jar");

async function jarAvailable() {
  try {
    await access(JAR_PATH);
    return true;
  } catch {
    return false;
  }
}

async function validateWithJar(resourceObj, profileUrl) {
  const tmpFile = join(tmpdir(), `fhir-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    await writeFile(tmpFile, JSON.stringify(resourceObj, null, 2));
    const profile = profileUrl
      ? profileUrl
      : `http://hl7.org/fhir/us/core/StructureDefinition/us-core-${resourceObj.resourceType.toLowerCase()}`;
    const cmd = [
      `java -jar "${JAR_PATH}"`,
      `"${tmpFile}"`,
      `-version 4.0.1`,
      `-ig hl7.fhir.us.core#6.1.0`,
      `-profile ${profile}`,
      `-tx https://tx.fhir.org/r4`,
      `-no-extensible-binding-messages`,
    ].join(" ");
    const { stdout, stderr } = await execAsync(cmd, { timeout: 180000 });
    const output = stdout + "\n" + stderr;
    const lines = output.split("\n");
    const errors = [];
    const warnings = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("Error @") || trimmed.match(/^\s*(error|fatal)/i)) {
        errors.push(trimmed.replace(/^Error @ /, ""));
      } else if (trimmed.startsWith("Warning @") || trimmed.match(/^\s*warning/i)) {
        warnings.push(trimmed.replace(/^Warning @ /, ""));
      }
    }
    const passed = output.includes("*SUCCESS*") || output.includes("No issues found");
    return { passed, errors, warnings, output };
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

const US_CORE_PROFILES = {
  Patient: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient",
  Observation: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-observation-lab",
  Condition: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-condition-encounter-diagnosis",
  MedicationRequest: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-medicationrequest",
  AllergyIntolerance: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-allergyintolerance",
  Procedure: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-procedure",
  DiagnosticReport: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-diagnosticreport-lab",
  DocumentReference: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-documentreference",
  Encounter: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-encounter",
  Immunization: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-immunization",
  Location: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-location",
  Medication: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-medication",
  Organization: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-organization",
  Practitioner: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitioner",
  PractitionerRole: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitionerrole",
  CarePlan: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-careplan",
  CareTeam: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-careteam",
  Goal: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-goal",
  Device: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-implantable-device",
};

const ValidateAndFixInput = z.object({
  resource: z.string().min(1),
  profile: z.string().optional(),
  use_us_core: z.boolean().optional(),
});

const ExplainErrorInput = z.object({
  error_message: z.string().min(1),
  resource_type: z.string().optional(),
});

const BatchValidateAndFixInput = z.object({
  resources: z.array(z.string()).min(1).max(20),
  use_us_core: z.boolean().optional(),
});

async function validateWithHapi(resourceObj, profile) {
  const url = profile
    ? `${HAPI_BASE_URL}/${resourceObj.resourceType}/$validate?profile=${encodeURIComponent(profile)}`
    : `${HAPI_BASE_URL}/${resourceObj.resourceType}/$validate`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/fhir+json", Accept: "application/fhir+json" },
      body: JSON.stringify(resourceObj),
      signal: controller.signal,
    });
    return response.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error("HAPI FHIR timed out after 25s.");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function extractIssues(operationOutcome) {
  if (!operationOutcome?.issue) return [];
  return operationOutcome.issue.map((issue) => ({
    severity: issue.severity ?? "unknown",
    code: issue.code ?? "unknown",
    diagnostics: issue.diagnostics ?? issue.details?.text ?? "(no details)",
    location: issue.expression ?? issue.location ?? [],
  }));
}

function hasErrors(issues) {
  return issues.some((i) => i.severity === "error" || i.severity === "fatal");
}

function computeDiff(original, fixed, path = "") {
  const changes = [];
  const allKeys = new Set([...Object.keys(original ?? {}), ...Object.keys(fixed ?? {})]);
  for (const key of allKeys) {
    const currentPath = path ? `${path}.${key}` : key;
    const origVal = original?.[key];
    const fixedVal = fixed?.[key];
    if (JSON.stringify(origVal) === JSON.stringify(fixedVal)) continue;
    if (typeof origVal === "object" && origVal !== null && !Array.isArray(origVal) &&
        typeof fixedVal === "object" && fixedVal !== null && !Array.isArray(fixedVal)) {
      changes.push(...computeDiff(origVal, fixedVal, currentPath));
    } else {
      changes.push({
        field: currentPath,
        before: origVal !== undefined ? origVal : "(field missing in original)",
        after: fixedVal !== undefined ? fixedVal : "(field removed)",
      });
    }
  }
  return changes;
}

function severityScore(issues) {
  let score = 100;
  for (const i of issues) {
    if (i.severity === "fatal") score -= 30;
    else if (i.severity === "error") score -= 15;
    else if (i.severity === "warning") score -= 3;
  }
  return Math.max(0, score);
}

function scoreToGrade(score) {
  if (score >= 95) return "A";
  if (score >= 80) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

function gradeSummary(grade) {
  const map = {
    A: "Excellent — resource passes validation with no significant issues.",
    B: "Good — resource has minor warnings but no critical errors.",
    C: "Fair — resource has errors that affect interoperability.",
    D: "Poor — resource has multiple critical errors and may be rejected by clinical systems.",
    F: "Failing — resource has severe structural errors and cannot be processed.",
  };
  return map[grade] ?? "Unknown";
}

function generateReportCard(beforeIssues, afterIssues) {
  const beforeScore = severityScore(beforeIssues);
  const afterScore = severityScore(afterIssues);
  const beforeGrade = scoreToGrade(beforeScore);
  const afterGrade = scoreToGrade(afterScore);
  const errorsBefore = beforeIssues.filter((i) => i.severity === "error" || i.severity === "fatal").length;
  const errorsAfter = afterIssues.filter((i) => i.severity === "error" || i.severity === "fatal").length;
  const warnBefore = beforeIssues.filter((i) => i.severity === "warning").length;
  const warnAfter = afterIssues.filter((i) => i.severity === "warning").length;
  const improved = afterScore > beforeScore;
  const improvement = beforeGrade === afterGrade ? `${beforeGrade} (unchanged)` : `${beforeGrade} to ${afterGrade}`;
  return {
    before: { grade: beforeGrade, score: beforeScore, error_count: errorsBefore, warning_count: warnBefore, summary: gradeSummary(beforeGrade) },
    after: { grade: afterGrade, score: afterScore, error_count: errorsAfter, warning_count: warnAfter, summary: gradeSummary(afterGrade) },
    improvement,
    improved,
  };
}

const US_CORE_REQUIREMENTS = {
  Patient: `US Core Patient additional requirements:
  - identifier: at least one identifier. Add: "identifier": [{"system": "http://hospital.example.org/mrn", "value": "UNKNOWN-MRN"}]
  - name: at least one HumanName with family OR given present`,
  Observation: `US Core Observation additional requirements:
  - status: required (e.g. "final")
  - code: required
  - subject: required, must reference a Patient
  - category: required — must include {"system":"http://terminology.hl7.org/CodeSystem/observation-category","code":"laboratory"}`,
  Condition: `US Core Condition additional requirements:
  - clinicalStatus: required
  - verificationStatus: required
  - category: required
  - code: required
  - subject: required`,
  MedicationRequest: `US Core MedicationRequest additional requirements:
  - status: required
  - intent: required
  - medication: required
  - subject: required
  - requester: required`,
  Immunization: `US Core Immunization additional requirements:
  - status: required
  - vaccineCode: required
  - patient: required
  - occurrenceDateTime or occurrenceString: required`,
};

// ---------------------------------------------------------------------------
// SHARP context extractor — reads FHIR context headers from Prompt Opinion
// ---------------------------------------------------------------------------
function extractFhirContext(request) {
  const meta = request?.params?._meta ?? {};
  return {
    fhirServerUrl: meta["X-FHIR-Server-URL"] ?? null,
    fhirAccessToken: meta["X-FHIR-Access-Token"] ?? null,
    patientId: meta["X-Patient-ID"] ?? null,
  };
}

async function fixWithClaude(originalResource, issues, profileUrl = null, fhirContext = null) {
  const issueText = issues.map((i, idx) =>
    `Issue ${idx + 1} [${i.severity}/${i.code}]:\n  Message: ${i.diagnostics}\n` +
    (i.location.length ? `  Location: ${i.location.join(", ")}\n` : "")
  ).join("\n");

  const isUsCore = profileUrl && profileUrl.includes("us/core");
  const resourceType = originalResource.resourceType;
  const usCoreContext = isUsCore && US_CORE_REQUIREMENTS[resourceType]
    ? `\n\nIMPORTANT — US CORE PROFILE REQUIREMENTS for ${resourceType}:\n${US_CORE_REQUIREMENTS[resourceType]}\nYou MUST add all missing required fields listed above.`
    : "";

  const fhirContextNote = fhirContext?.patientId
    ? `\n\nFHIR CONTEXT: This resource belongs to Patient ID: ${fhirContext.patientId}. FHIR server: ${fhirContext.fhirServerUrl ?? "unknown"}.`
    : "";

  const systemPrompt = `You are a FHIR expert who also communicates clearly with clinical staff.
Your task is to fix broken FHIR resources so they pass HAPI FHIR validation.${usCoreContext}${fhirContextNote}

RULES:
1. Return a valid corrected FHIR resource as a JSON object.
2. Preserve all original data that is already correct.
3. For each change provide a confidence score 0-100.
4. If a required field is missing use placeholder "UNKNOWN" with low confidence.
5. Return ONLY a JSON object with:
   - "fixed_resource": the corrected FHIR resource
   - "fixes": array of objects each with: field, original_value, corrected_value, explanation, clinical_explanation, confidence, confidence_reason

Do not include any text outside the JSON. Do not wrap in markdown.`;

  const userPrompt = `Original FHIR resource:\n\`\`\`json\n${JSON.stringify(originalResource, null, 2)}\n\`\`\`\n\nValidation issues:\n${issueText}\n\nReturn the corrected resource with confidence scores.`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const jsonText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(jsonText);
  return { fixed_resource: parsed.fixed_resource, fixes: Array.isArray(parsed.fixes) ? parsed.fixes : [] };
}

async function explainErrorWithClaude(errorMessage, resourceType) {
  const systemPrompt = `You are a FHIR expert. Explain HAPI FHIR errors in plain English.
Return ONLY a JSON object with: plain_english, root_cause, fix_example. No markdown.`;
  const userPrompt = `Error${resourceType ? ` on ${resourceType}` : ""}: "${errorMessage}"\nExplain and show how to fix.`;
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const rawText = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const jsonText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(jsonText);
}

async function processOneResource(resourceObj, profile, fhirContext = null) {
  const isUsCore = profile && profile.includes("us/core");
  const hapiProfile = isUsCore ? null : (profile ?? null);

  let operationOutcome;
  try {
    operationOutcome = await validateWithHapi(resourceObj, hapiProfile);
  } catch (err) {
    return { success: false, error: `Could not reach HAPI FHIR: ${err.message}` };
  }

  const issues = extractIssues(operationOutcome);

  if (!hasErrors(issues) && !isUsCore) {
    return {
      success: true, already_valid: true,
      message: "Resource is already valid.",
      warnings: issues.filter((i) => i.severity === "warning"),
      original_resource: resourceObj,
    };
  }

  let jarUsed = false;
  if (isUsCore) {
    const hasJar = await jarAvailable();
    if (hasJar) {
      try {
        const jarResult = await validateWithJar(resourceObj, profile);
        jarUsed = true;
        for (const errMsg of jarResult.errors) {
          issues.push({ severity: "error", code: "processing", diagnostics: `[US Core JAR] ${errMsg}`, location: [] });
        }
      } catch (jarErr) {
        issues.push({ severity: "information", code: "informational", diagnostics: `JAR unavailable: ${jarErr.message}`, location: [] });
      }
    }
    if (!hasErrors(issues)) {
      issues.push({ severity: "information", code: "informational", diagnostics: `Applying US Core requirements for ${resourceObj.resourceType}.`, location: [] });
    }
  }

  const MAX_PASSES = 3;
  let currentResource = resourceObj;
  let currentIssues = issues;
  let allFixes = [];
  let revalidationIssues = [];
  let fixedHasErrors = true;
  let passCount = 0;

  while (fixedHasErrors && passCount < MAX_PASSES) {
    passCount++;
    let aiResult;
    try {
      aiResult = await fixWithClaude(currentResource, currentIssues, profile ?? null, fhirContext);
    } catch (err) {
      return { success: false, original_issues: issues, error: `AI fix failed on pass ${passCount}: ${err.message}` };
    }
    const taggedFixes = (aiResult.fixes ?? []).map((f) => ({ ...f, pass: passCount }));
    allFixes = [...allFixes, ...taggedFixes];
    currentResource = aiResult.fixed_resource;
    revalidationIssues = [];
    try {
      const revalidationOutcome = await validateWithHapi(currentResource, hapiProfile);
      revalidationIssues = extractIssues(revalidationOutcome);
    } catch { break; }
    fixedHasErrors = hasErrors(revalidationIssues);
    if (fixedHasErrors) {
      currentIssues = revalidationIssues.filter((i) => i.severity === "error" || i.severity === "fatal");
    }
  }

  const diff = computeDiff(resourceObj, currentResource);
  const avgConfidence = allFixes.length
    ? Math.round(allFixes.reduce((sum, f) => sum + (f.confidence ?? 0), 0) / allFixes.length)
    : null;
  const lowConfidenceFixes = allFixes.filter((f) => (f.confidence ?? 100) < 75);
  const reportCard = generateReportCard(issues, revalidationIssues);

  return {
    success: true,
    fixed_passes_validation: !fixedHasErrors,
    fix_passes_used: passCount,
    us_core_mode: isUsCore,
    jar_validation_used: jarUsed,
    fhir_context_received: fhirContext?.patientId ? true : false,
    patient_id: fhirContext?.patientId ?? null,
    report_card: reportCard,
    original_resource: resourceObj,
    fixed_resource: currentResource,
    fixes: allFixes,
    diff,
    average_confidence: avgConfidence,
    low_confidence_fixes: lowConfidenceFixes,
    original_issues: issues,
    revalidation_issues: revalidationIssues,
    note: fixedHasErrors
      ? `${revalidationIssues.filter((i) => i.severity === "error" || i.severity === "fatal").length} errors remain after ${passCount} passes.`
      : passCount > 1 ? `Fixed after ${passCount} passes.` : "Passes HAPI FHIR validation.",
  };
}

async function processBundle(bundleObj, useUsCore, fhirContext = null) {
  const entries = bundleObj.entry ?? [];
  const fixedBundle = JSON.parse(JSON.stringify(bundleObj));
  const results = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const resource = entry.resource;
    if (!resource || !resource.resourceType) {
      results.push({ index: i, skipped: true, reason: "No resource or resourceType" });
      continue;
    }
    const profile = useUsCore ? US_CORE_PROFILES[resource.resourceType] : undefined;
    const result = await processOneResource(resource, profile, fhirContext);
    if (result.success && !result.already_valid && result.fixed_resource) {
      fixedBundle.entry[i] = { ...entry, resource: result.fixed_resource };
    }
    results.push({ index: i, resourceType: resource.resourceType, id: resource.id ?? "(no id)", us_core_profile: profile ?? null, ...result });
  }
  return {
    success: true, is_bundle: true,
    total_entries: entries.length,
    total_fixed: results.filter((r) => r.success && !r.already_valid).length,
    total_already_valid: results.filter((r) => r.already_valid).length,
    total_failed: results.filter((r) => !r.success).length,
    fixed_bundle: fixedBundle, entry_results: results,
  };
}

async function fetchSupportedProfiles() {
  const response = await fetch(`${HAPI_BASE_URL}/metadata`, { headers: { Accept: "application/fhir+json" } });
  const cs = await response.json();
  const profiles = [];
  if (Array.isArray(cs.implementationGuide)) {
    for (const ig of cs.implementationGuide) profiles.push({ type: "ImplementationGuide", url: ig });
  }
  for (const restEntry of cs.rest ?? []) {
    for (const resource of restEntry.resource ?? []) {
      for (const p of resource.supportedProfile ?? []) profiles.push({ resourceType: resource.type, profileUrl: p });
      if (resource.profile) profiles.push({ resourceType: resource.type, profileUrl: resource.profile, isBase: true });
    }
  }
  return {
    fhir_version: cs.fhirVersion ?? "unknown",
    software: cs.software?.name ?? "HAPI FHIR",
    software_version: cs.software?.version ?? "unknown",
    us_core_profiles_available: Object.entries(US_CORE_PROFILES).map(([type, url]) => ({ resourceType: type, profileUrl: url })),
    server_profiles: profiles,
    total_server_profiles: profiles.length,
  };
}

const server = new Server(
  { name: "fhir-auto-fixer", version: "2.0.0" },
  {
    capabilities: {
      tools: {},
      extensions: {
        "ai.promptopinion/fhir-context": {}
      }
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "validate_and_fix",
      description: "Validates a FHIR resource against HAPI FHIR and uses Claude AI to auto-fix it. Returns fixed resource, confidence scores, report card grades, and clinical explanations. Supports SHARP FHIR context for patient-specific validation.",
      inputSchema: {
        type: "object",
        properties: {
          resource: { type: "string", description: "FHIR resource JSON string." },
          profile: { type: "string", description: "Optional profile URL." },
          use_us_core: { type: "boolean", description: "If true, validates against US Core profile." },
        },
        required: ["resource"],
      },
    },
    {
      name: "list_profiles",
      description: "Returns supported FHIR profiles including 19 US Core profiles.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "explain_error",
      description: "Explains a HAPI FHIR error in plain English with a fix example.",
      inputSchema: {
        type: "object",
        properties: {
          error_message: { type: "string", description: "Raw HAPI FHIR error message." },
          resource_type: { type: "string", description: "Optional resource type." },
        },
        required: ["error_message"],
      },
    },
    {
      name: "batch_validate_and_fix",
      description: "Validates and fixes up to 20 FHIR resources at once.",
      inputSchema: {
        type: "object",
        properties: {
          resources: { type: "array", items: { type: "string" }, maxItems: 20 },
          use_us_core: { type: "boolean" },
        },
        required: ["resources"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Extract FHIR context from Prompt Opinion SHARP headers
  const fhirContext = extractFhirContext(request);
  if (fhirContext.patientId) {
    console.log(`FHIR context received - Patient: ${fhirContext.patientId}, Server: ${fhirContext.fhirServerUrl}`);
  }

  try {
    if (name === "validate_and_fix") {
      const { resource, profile, use_us_core } = ValidateAndFixInput.parse(args);
      let resourceObj;
      try { resourceObj = JSON.parse(resource); } catch { return errorResponse("Invalid JSON."); }
      if (!resourceObj.resourceType) return errorResponse("Missing resourceType field.");
      if (resourceObj.resourceType === "Bundle") {
        return jsonResponse(await processBundle(resourceObj, use_us_core ?? false, fhirContext));
      }
      const autoDetectedProfile = use_us_core ? US_CORE_PROFILES[resourceObj.resourceType] : undefined;
      const resolvedProfile = profile ?? autoDetectedProfile;
      const result = await processOneResource(resourceObj, resolvedProfile, fhirContext);
      if (resolvedProfile) {
        result.validated_against_profile = resolvedProfile;
        result.profile_auto_detected = !profile && !!autoDetectedProfile;
        if (!profile && autoDetectedProfile) {
          result.profile_detection_note = `Automatically selected US Core profile for ${resourceObj.resourceType}: ${autoDetectedProfile}`;
        }
      }
      return jsonResponse(result);
    }

    if (name === "list_profiles") {
      return jsonResponse({ success: true, ...(await fetchSupportedProfiles()) });
    }

    if (name === "explain_error") {
      const { error_message, resource_type } = ExplainErrorInput.parse(args);
      const explanation = await explainErrorWithClaude(error_message, resource_type);
      return jsonResponse({ success: true, error_message, resource_type: resource_type ?? null, ...explanation });
    }

    if (name === "batch_validate_and_fix") {
      const { resources, use_us_core } = BatchValidateAndFixInput.parse(args);
      const batchResults = [];
      let totalFixed = 0, totalAlreadyValid = 0, totalFailed = 0, totalLowConfidence = 0;
      for (let i = 0; i < resources.length; i++) {
        let resourceObj;
        try { resourceObj = JSON.parse(resources[i]); } catch {
          batchResults.push({ index: i, success: false, error: "Invalid JSON." });
          totalFailed++; continue;
        }
        if (!resourceObj.resourceType) {
          batchResults.push({ index: i, success: false, error: "Missing resourceType." });
          totalFailed++; continue;
        }
        const profile = use_us_core ? US_CORE_PROFILES[resourceObj.resourceType] : undefined;
        const result = await processOneResource(resourceObj, profile, fhirContext);
        if (result.success && result.already_valid) totalAlreadyValid++;
        else if (result.success) { totalFixed++; if ((result.low_confidence_fixes ?? []).length > 0) totalLowConfidence++; }
        else totalFailed++;
        batchResults.push({ index: i, resourceType: resourceObj.resourceType, id: resourceObj.id ?? "(no id)", us_core_profile: profile ?? null, ...result });
      }
      return jsonResponse({
        success: true,
        summary: { total: resources.length, fixed: totalFixed, already_valid: totalAlreadyValid, failed: totalFailed, resources_with_low_confidence_fixes: totalLowConfidence },
        results: batchResults,
      });
    }

    return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: err instanceof z.ZodError
          ? `Invalid input: ${err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`
          : `Unexpected error: ${err.message}`,
      }) }],
      isError: true,
    };
  }
});

function jsonResponse(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function errorResponse(message) {
  return { content: [{ type: "text", text: JSON.stringify({ success: false, error: message }) }] };
}

async function startHttp(port) {
  const app = express();
  app.use(cors());

  app.get("/", (_req, res) => {
    res.json({
      name: "AI-Powered FHIR Auto-Fixer",
      version: "2.0.0",
      description: "MCP server that validates broken FHIR resources via HAPI FHIR and auto-fixes them using Claude AI. Supports SHARP FHIR context.",
      hapi_endpoint: HAPI_BASE_URL,
      mcp_endpoint: "/sse",
      tools: ["validate_and_fix", "list_profiles", "explain_error", "batch_validate_and_fix"],
    });
  });

  const transports = new Map();

  app.get("/sse", async (req, res) => {
    res.setHeader("X-Accel-Buffering", "no");
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => transports.delete(transport.sessionId));
    await server.connect(transport);
  });

  app.post("/messages", express.json(), async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  app.listen(port, () => {
    console.log(`FHIR Auto-Fixer MCP server v2.0 running on port ${port}`);
    console.log(`  SSE endpoint : http://localhost:${port}/sse`);
    console.log(`  HAPI FHIR   : ${HAPI_BASE_URL}`);
  });
}

async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("FHIR Auto-Fixer MCP server v2.0 started (stdio mode).");
}

const PORT = process.env.PORT;

if (PORT) {
  startHttp(parseInt(PORT, 10)).catch((err) => {
    console.error("Fatal error starting HTTP server:", err);
    process.exit(1);
  });
} else {
  startStdio().catch((err) => {
    console.error("Fatal error starting MCP server:", err);
    process.exit(1);
  });
}