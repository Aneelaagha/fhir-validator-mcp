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

// ---------------------------------------------------------------------------
// Polyfill fetch globals for older Node.js versions (< 18)
// ---------------------------------------------------------------------------
if (!globalThis.fetch) {
  globalThis.fetch = fetch;
  globalThis.Headers = Headers;
  globalThis.Request = Request;
  globalThis.Response = Response;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Default to the public HAPI FHIR R4 demo server when running in the cloud.
// Override with HAPI_FHIR_URL env var to point at a local or private server.
const HAPI_BASE_URL = process.env.HAPI_FHIR_URL ?? "https://hapi.fhir.org/baseR4";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  fetch: fetch,
});

// ---------------------------------------------------------------------------
// HL7 Validator JAR — true US Core validation
// Downloads: https://github.com/hapifhir/org.hl7.fhir.core/releases/latest
// Place validator_cli.jar in the project root directory.
// Falls back gracefully if the JAR is not present.
// ---------------------------------------------------------------------------
const JAR_PATH = join(process.cwd(), "validator_cli.jar");

async function jarAvailable() {
  try {
    await access(JAR_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a FHIR resource using the official HL7 Validator CLI JAR.
 * Returns { passed: boolean, errors: string[], warnings: string[], output: string }
 * Only called when validator_cli.jar is present in the project root.
 */
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

// ---------------------------------------------------------------------------
// US Core profile URL map
// Maps FHIR resource types → their official US Core profile URLs.
// Used when use_us_core: true is passed to validate_and_fix.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Zod input schemas
// ---------------------------------------------------------------------------

const ValidateAndFixInput = z.object({
  resource: z.string().min(1).describe(
    "The FHIR resource JSON string to validate and fix. Can be a single resource or a FHIR Bundle."
  ),
  profile: z.string().optional().describe(
    "Optional: a specific FHIR profile URL to validate against. Overrides use_us_core if both are set."
  ),
  use_us_core: z.boolean().optional().describe(
    "If true, validates against the matching US Core profile for the resource type instead of base FHIR. Ignored for Bundles (each entry is checked individually)."
  ),
});

const ExplainErrorInput = z.object({
  error_message: z.string().min(1).describe(
    "The raw error or diagnostic message returned by HAPI FHIR."
  ),
  resource_type: z.string().optional().describe(
    "Optional: the FHIR resource type the error relates to (e.g. Patient, Observation)."
  ),
});

const BatchValidateAndFixInput = z.object({
  resources: z.array(z.string()).min(1).max(20).describe(
    "Array of FHIR resource JSON strings to validate and fix. Maximum 20 resources per batch."
  ),
  use_us_core: z.boolean().optional().describe(
    "If true, validates all resources against their matching US Core profiles."
  ),
});

// ---------------------------------------------------------------------------
// HAPI FHIR helpers
// ---------------------------------------------------------------------------

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
    if (err.name === 'AbortError') throw new Error('HAPI FHIR timed out after 25s.');
    throw err;
  } finally { clearTimeout(timeout); }
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

// ---------------------------------------------------------------------------
// Diff helper — computes a field-by-field before/after comparison
// ---------------------------------------------------------------------------

function computeDiff(original, fixed, path = "") {
  const changes = [];
  const allKeys = new Set([
    ...Object.keys(original ?? {}),
    ...Object.keys(fixed ?? {}),
  ]);

  for (const key of allKeys) {
    const currentPath = path ? `${path}.${key}` : key;
    const origVal = original?.[key];
    const fixedVal = fixed?.[key];

    if (JSON.stringify(origVal) === JSON.stringify(fixedVal)) continue;

    if (
      typeof origVal === "object" && origVal !== null && !Array.isArray(origVal) &&
      typeof fixedVal === "object" && fixedVal !== null && !Array.isArray(fixedVal)
    ) {
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

// ---------------------------------------------------------------------------
// Validation report card — letter grade based on issues before and after fix
// ---------------------------------------------------------------------------

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

/**
 * Generates a before/after report card with letter grades.
 * @param {Array} beforeIssues - issues from original resource
 * @param {Array} afterIssues  - issues after AI fix (re-validation)
 * @returns {{ before, after, improvement, summary }}
 */
function generateReportCard(beforeIssues, afterIssues) {
  const beforeScore = severityScore(beforeIssues);
  const afterScore = severityScore(afterIssues);
  const beforeGrade = scoreToGrade(beforeScore);
  const afterGrade = scoreToGrade(afterScore);

  const errorsBefore = beforeIssues.filter((i) => i.severity === "error" || i.severity === "fatal").length;
  const errorsAfter  = afterIssues.filter((i) => i.severity === "error" || i.severity === "fatal").length;
  const warnBefore   = beforeIssues.filter((i) => i.severity === "warning").length;
  const warnAfter    = afterIssues.filter((i) => i.severity === "warning").length;

  const improved = afterScore > beforeScore;
  const improvement = beforeGrade === afterGrade
    ? `${beforeGrade} (unchanged)`
    : `${beforeGrade} → ${afterGrade}`;

  return {
    before: {
      grade: beforeGrade,
      score: beforeScore,
      error_count: errorsBefore,
      warning_count: warnBefore,
      summary: gradeSummary(beforeGrade),
    },
    after: {
      grade: afterGrade,
      score: afterScore,
      error_count: errorsAfter,
      warning_count: warnAfter,
      summary: gradeSummary(afterGrade),
    },
    improvement,
    improved,
  };
}

// ---------------------------------------------------------------------------
// Claude AI helpers
// ---------------------------------------------------------------------------

// US Core profile requirements — additional mandatory fields beyond base FHIR R4.
// These are injected into the Claude prompt when validating against a US Core profile.
const US_CORE_REQUIREMENTS = {
  Patient: `US Core Patient additional requirements (MUST be present to pass validation):
  - identifier: at least one identifier (e.g. MRN). Add: "identifier": [{"system": "http://hospital.example.org/mrn", "value": "UNKNOWN-MRN"}]
  - name: at least one HumanName with family OR given present
  - Race extension (optional but recommended): http://hl7.org/fhir/us/core/StructureDefinition/us-core-race
  - Ethnicity extension (optional but recommended): http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity
  - birthsex extension (optional): http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex`,

  Observation: `US Core Observation additional requirements:
  - status: required (e.g. "final", "preliminary", "registered", "amended")
  - code: required with at least a coding or text
  - subject: required, must reference a Patient
  - category: required for lab observations — must include {"system":"http://terminology.hl7.org/CodeSystem/observation-category","code":"laboratory"}`,

  Condition: `US Core Condition additional requirements:
  - clinicalStatus: required — e.g. {"coding":[{"system":"http://terminology.hl7.org/CodeSystem/condition-clinical","code":"active"}]}
  - verificationStatus: required — e.g. {"coding":[{"system":"http://terminology.hl7.org/CodeSystem/condition-ver-status","code":"confirmed"}]}
  - category: required — must include {"coding":[{"system":"http://terminology.hl7.org/CodeSystem/condition-category","code":"encounter-diagnosis"}]}
  - code: required
  - subject: required, must reference a Patient`,

  MedicationRequest: `US Core MedicationRequest additional requirements:
  - status: required (e.g. "active", "completed")
  - intent: required (e.g. "order")
  - medication: required — either medicationCodeableConcept or medicationReference
  - subject: required, must reference a Patient
  - requester: required`,

  Immunization: `US Core Immunization additional requirements:
  - status: required (e.g. "completed", "not-done")
  - vaccineCode: required with at least a coding
  - patient: required, must reference a Patient
  - occurrenceDateTime or occurrenceString: required`,
};

/**
 * Ask Claude to fix a FHIR resource given HAPI validation issues.
 * Accepts an optional profileUrl to inject US Core context into the prompt.
 * Returns { fixed_resource, fixes: [{ field, original_value, corrected_value,
 *   explanation, confidence, confidence_reason }] }
 */
async function fixWithClaude(originalResource, issues, profileUrl = null) {
  const issueText = issues
    .map(
      (i, idx) =>
        `Issue ${idx + 1} [${i.severity}/${i.code}]:\n` +
        `  Message: ${i.diagnostics}\n` +
        (i.location.length ? `  Location: ${i.location.join(", ")}\n` : "")
    )
    .join("\n");

  // Inject US Core-specific context if we're validating against a US Core profile
  const isUsCore = profileUrl && profileUrl.includes("us/core");
  const resourceType = originalResource.resourceType;
  const usCoreContext = isUsCore && US_CORE_REQUIREMENTS[resourceType]
    ? `\n\nIMPORTANT — US CORE PROFILE REQUIREMENTS for ${resourceType}:\n${US_CORE_REQUIREMENTS[resourceType]}\nYou MUST add all missing required fields listed above, even if HAPI didn't explicitly list them as errors. US Core has strict Must Support requirements.`
    : "";

  const systemPrompt = `You are a FHIR (Fast Healthcare Interoperability Resources) expert who also communicates clearly with clinical staff.
Your task is to fix broken FHIR resources so they pass HAPI FHIR validation.${usCoreContext}

RULES:
1. Return a valid corrected FHIR resource as a JSON object.
2. Preserve all original data that is already correct — do NOT change fields that have no issues.
3. For each change, provide a confidence score from 0-100 reflecting how certain you are the fix is correct:
   - 95-100: Deterministic fix (wrong date format, obvious code violation, missing required field with clear value)
   - 75-94: High confidence (strong contextual evidence for the correction)
   - 50-74: Moderate confidence (reasonable guess, but clinical context could change the answer)
   - Below 50: Low confidence (ambiguous — flag this explicitly)
4. If a required field is missing and you cannot determine the correct value, use a clearly marked placeholder like "UNKNOWN" and give a low confidence score.
5. Return ONLY a JSON object with two keys:
   - "fixed_resource": the corrected FHIR resource as a JSON object
   - "fixes": an array of fix objects, one per change, each with:
       - "field": the JSON path of the changed field (e.g. "Patient.gender")
       - "original_value": the original (broken) value or "(missing)" if the field was absent
       - "corrected_value": the new (fixed) value
       - "explanation": a technical sentence for developers starting with "Fixed:" or "Added:" (e.g. "Fixed: birthDate must conform to ISO 8601 YYYY-MM-DD format")
       - "clinical_explanation": a plain-English sentence written for clinical staff with NO jargon (e.g. "The patient's date of birth was in the wrong format — we corrected it so the system can read it properly")
       - "confidence": integer 0-100
       - "confidence_reason": one sentence explaining the confidence level

Do not include any text outside the JSON object. Do not wrap in markdown code fences.`;

  const userPrompt = `Here is the original FHIR resource that failed validation:

\`\`\`json
${JSON.stringify(originalResource, null, 2)}
\`\`\`

HAPI FHIR reported these validation issues:

${issueText}

Return the corrected resource with confidence scores for every change.`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const jsonText = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const parsed = JSON.parse(jsonText);
  return {
    fixed_resource: parsed.fixed_resource,
    fixes: Array.isArray(parsed.fixes) ? parsed.fixes : [],
  };
}

/**
 * Ask Claude to explain a single HAPI error in plain English.
 */
async function explainErrorWithClaude(errorMessage, resourceType) {
  const systemPrompt = `You are a FHIR expert who helps healthcare developers understand and fix validation errors.
Explain HAPI FHIR error messages in plain English so a developer new to FHIR can understand and fix them.

Return ONLY a JSON object with:
- "plain_english": a 2-3 sentence plain-English explanation of what the error means and why it occurs
- "root_cause": a one-sentence technical description of the root cause
- "fix_example": a short JSON snippet (as a string) showing the correct FHIR structure

Do not include any text outside the JSON object. Do not wrap in markdown code fences.`;

  const userPrompt = `HAPI FHIR validation error${resourceType ? ` on a ${resourceType} resource` : ""}:

"${errorMessage}"

Explain this error and show how to fix it.`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const jsonText = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  return JSON.parse(jsonText);
}

// ---------------------------------------------------------------------------
// Single resource: validate → fix → diff → re-validate
// ---------------------------------------------------------------------------

async function processOneResource(resourceObj, profile) {
  // HAPI validates base FHIR structure only — we never pass a US Core profile
  // URL to HAPI because HAPI needs the full IG installed to use it.
  // Claude handles US Core compliance via our requirements dictionary.
  const isUsCore = profile && profile.includes("us/core");
  const hapiProfile = isUsCore ? null : (profile ?? null);

  let operationOutcome;
  try {
    operationOutcome = await validateWithHapi(resourceObj, hapiProfile);
  } catch (err) {
    return {
      success: false,
      error: `Could not reach HAPI FHIR at ${HAPI_BASE_URL}. Details: ${err.message}`,
    };
  }

  const issues = extractIssues(operationOutcome);

  if (!hasErrors(issues) && !isUsCore) {
    return {
      success: true,
      already_valid: true,
      message: "Resource is already valid — no errors found.",
      warnings: issues.filter((i) => i.severity === "warning"),
      information: issues.filter((i) => i.severity === "information"),
      original_resource: resourceObj,
    };
  }

  // For US Core: run the HL7 Validator JAR in parallel if available.
  // JAR gives authoritative US Core errors that get merged into the issue list.
  let jarUsed = false;
  if (isUsCore) {
    const hasJar = await jarAvailable();
    if (hasJar) {
      try {
        const jarResult = await validateWithJar(resourceObj, profile);
        jarUsed = true;
        for (const errMsg of jarResult.errors) {
          issues.push({
            severity: "error",
            code: "processing",
            diagnostics: `[US Core JAR] ${errMsg}`,
            location: [],
          });
        }
        for (const warnMsg of jarResult.warnings) {
          issues.push({
            severity: "warning",
            code: "processing",
            diagnostics: `[US Core JAR] ${warnMsg}`,
            location: [],
          });
        }
      } catch (jarErr) {
        issues.push({
          severity: "information",
          code: "informational",
          diagnostics: `HL7 Validator JAR could not run: ${jarErr.message}. Falling back to Claude-based US Core analysis.`,
          location: [],
        });
      }
    }

    // Even if base FHIR passes and no JAR, still run Claude to apply US Core requirements
    if (!hasErrors(issues)) {
      issues.push({
        severity: "information",
        code: "informational",
        diagnostics: `Base FHIR validation passed. Applying US Core profile requirements for ${resourceObj.resourceType} — checking for missing mandatory fields (identifier, extensions, etc.).`,
        location: [],
      });
    }
  }

  // Iterative fix loop — up to 3 passes.
  // Each pass sends the current resource + remaining errors to Claude.
  // This handles cases where fixing base FHIR errors reveals additional
  // US Core profile requirements that weren't visible before.
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
      aiResult = await fixWithClaude(currentResource, currentIssues, profile ?? null);
    } catch (err) {
      return {
        success: false,
        original_issues: issues,
        error: `AI fix failed on pass ${passCount}: ${err.message}`,
      };
    }

    // Tag each fix with which pass produced it
    const taggedFixes = (aiResult.fixes ?? []).map((f) => ({ ...f, pass: passCount }));
    allFixes = [...allFixes, ...taggedFixes];
    currentResource = aiResult.fixed_resource;

    // Re-validate against base FHIR (hapiProfile, not the US Core URL)
    revalidationIssues = [];
    try {
      const revalidationOutcome = await validateWithHapi(currentResource, hapiProfile);
      revalidationIssues = extractIssues(revalidationOutcome);
    } catch {
      break; // Best-effort; stop iterating if HAPI is unreachable
    }

    fixedHasErrors = hasErrors(revalidationIssues);

    // If errors remain, feed them into the next pass
    if (fixedHasErrors) {
      currentIssues = revalidationIssues.filter(
        (i) => i.severity === "error" || i.severity === "fatal"
      );
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
      ? `After ${passCount} fix pass(es), ${revalidationIssues.filter((i) => i.severity === "error" || i.severity === "fatal").length} base FHIR error(s) remain. The resource may need manual review.`
      : isUsCore && jarUsed
      ? `Passes HAPI base FHIR validation. US Core errors from the HL7 Validator JAR were fixed by Claude. Review any UNKNOWN placeholders and replace with real clinical values.`
      : isUsCore
      ? `Base FHIR validation passes. US Core required fields added by Claude (no JAR present — place validator_cli.jar in project root for authoritative US Core validation). Review UNKNOWN placeholders.`
      : passCount > 1
      ? `Fixed after ${passCount} passes — resource now passes HAPI FHIR validation.`
      : "The fixed resource passes HAPI FHIR validation.",
  };
}

// ---------------------------------------------------------------------------
// Bundle handler — validates and fixes each entry individually
// ---------------------------------------------------------------------------

async function processBundle(bundleObj, useUsCore) {
  const entries = bundleObj.entry ?? [];
  const fixedBundle = JSON.parse(JSON.stringify(bundleObj));
  const results = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const resource = entry.resource;

    if (!resource || !resource.resourceType) {
      results.push({ index: i, skipped: true, reason: "Entry has no resource or resourceType" });
      continue;
    }

    const profile = useUsCore ? US_CORE_PROFILES[resource.resourceType] : undefined;
    const result = await processOneResource(resource, profile);

    if (result.success && !result.already_valid && result.fixed_resource) {
      fixedBundle.entry[i] = { ...entry, resource: result.fixed_resource };
    }

    results.push({
      index: i,
      resourceType: resource.resourceType,
      id: resource.id ?? "(no id)",
      us_core_profile: profile ?? null,
      ...result,
    });
  }

  const totalFixed = results.filter((r) => r.success && !r.already_valid).length;
  const totalAlreadyValid = results.filter((r) => r.already_valid).length;
  const totalFailed = results.filter((r) => !r.success).length;

  return {
    success: true,
    is_bundle: true,
    total_entries: entries.length,
    total_fixed: totalFixed,
    total_already_valid: totalAlreadyValid,
    total_failed: totalFailed,
    fixed_bundle: fixedBundle,
    entry_results: results,
  };
}

// ---------------------------------------------------------------------------
// list_profiles helper
// ---------------------------------------------------------------------------

async function fetchSupportedProfiles() {
  const response = await fetch(`${HAPI_BASE_URL}/metadata`, {
    headers: { Accept: "application/fhir+json" },
  });
  const cs = await response.json();
  const profiles = [];

  if (Array.isArray(cs.implementationGuide)) {
    for (const ig of cs.implementationGuide) {
      profiles.push({ type: "ImplementationGuide", url: ig });
    }
  }

  for (const restEntry of cs.rest ?? []) {
    for (const resource of restEntry.resource ?? []) {
      const resourceType = resource.type;
      for (const p of resource.supportedProfile ?? []) {
        profiles.push({ resourceType, profileUrl: p });
      }
      if (resource.profile) {
        profiles.push({ resourceType, profileUrl: resource.profile, isBase: true });
      }
    }
  }

  return {
    fhir_version: cs.fhirVersion ?? "unknown",
    software: cs.software?.name ?? "HAPI FHIR",
    software_version: cs.software?.version ?? "unknown",
    us_core_profiles_available: Object.entries(US_CORE_PROFILES).map(([type, url]) => ({
      resourceType: type,
      profileUrl: url,
    })),
    server_profiles: profiles,
    total_server_profiles: profiles.length,
  };
}

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "fhir-auto-fixer", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// list_tools handler
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "validate_and_fix",
        description:
          "Validates a FHIR resource (or Bundle) against HAPI FHIR and uses Claude AI to automatically generate a corrected version. Returns the fixed resource, a field-by-field diff, per-fix confidence scores (0-100), and a plain-English explanation of every change. Supports base FHIR R4 validation and US Core profile enforcement.",
        inputSchema: {
          type: "object",
          properties: {
            resource: {
              type: "string",
              description:
                "The FHIR resource or Bundle as a JSON string. Must include a resourceType field.",
            },
            profile: {
              type: "string",
              description:
                "Optional: A specific FHIR profile URL to validate against. Overrides use_us_core.",
            },
            use_us_core: {
              type: "boolean",
              description:
                "If true, validates against the matching US Core profile for the resource type. For Bundles, each entry is checked against its own US Core profile.",
            },
          },
          required: ["resource"],
        },
      },
      {
        name: "list_profiles",
        description:
          "Returns the FHIR profiles and Implementation Guides supported by the connected HAPI FHIR server, plus the built-in US Core profile map. Use this to discover which profiles are available before calling validate_and_fix.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "explain_error",
        description:
          "Takes a raw HAPI FHIR error message and returns a plain-English explanation, root cause, and a concrete JSON fix example. Use this when you have a specific error message you want to understand before fixing manually.",
        inputSchema: {
          type: "object",
          properties: {
            error_message: {
              type: "string",
              description: "The raw error or diagnostic message from HAPI FHIR.",
            },
            resource_type: {
              type: "string",
              description:
                "Optional: The FHIR resource type this error relates to (e.g. Patient, Observation).",
            },
          },
          required: ["error_message"],
        },
      },
      {
        name: "batch_validate_and_fix",
        description:
          "Accepts an array of FHIR resource JSON strings, validates and fixes each one, and returns a full report with per-resource results, confidence scores, diffs, and a summary. Ideal for CI/CD pipelines or bulk data cleanup. Maximum 20 resources per call.",
        inputSchema: {
          type: "object",
          properties: {
            resources: {
              type: "array",
              items: { type: "string" },
              description:
                "Array of FHIR resource JSON strings. Each must have a resourceType field.",
              maxItems: 20,
            },
            use_us_core: {
              type: "boolean",
              description:
                "If true, validates all resources against their US Core profiles.",
            },
          },
          required: ["resources"],
        },
      },
    ],
  };
});

// ---------------------------------------------------------------------------
// call_tool handler
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // ---- validate_and_fix ----
    if (name === "validate_and_fix") {
      const { resource, profile, use_us_core } = ValidateAndFixInput.parse(args);

      let resourceObj;
      try {
        resourceObj = JSON.parse(resource);
      } catch {
        return errorResponse("The provided resource is not valid JSON. Please check your JSON syntax.");
      }

      if (!resourceObj.resourceType) {
        return errorResponse("The resource must have a 'resourceType' field (e.g. \"Patient\", \"Bundle\").");
      }

      // Handle FHIR Bundle
      if (resourceObj.resourceType === "Bundle") {
        let bundleResult;
        try {
          bundleResult = await processBundle(resourceObj, use_us_core ?? false);
        } catch (err) {
          return errorResponse(`Bundle processing failed: ${err.message}`);
        }
        return jsonResponse(bundleResult);
      }

      // Single resource — auto-detect US Core profile from resource type if needed
      const autoDetectedProfile = use_us_core ? US_CORE_PROFILES[resourceObj.resourceType] : undefined;
      const resolvedProfile = profile ?? autoDetectedProfile;
      const result = await processOneResource(resourceObj, resolvedProfile);

      if (resolvedProfile) {
        result.validated_against_profile = resolvedProfile;
        result.profile_auto_detected = !profile && !!autoDetectedProfile;
        if (!profile && autoDetectedProfile) {
          result.profile_detection_note = `Automatically selected US Core profile for ${resourceObj.resourceType}: ${autoDetectedProfile}`;
        }
      } else if (use_us_core && !autoDetectedProfile) {
        result.profile_detection_note = `No US Core profile mapping found for resource type '${resourceObj.resourceType}'. Validated against base FHIR R4 only.`;
      }

      return jsonResponse(result);
    }

    // ---- list_profiles ----
    if (name === "list_profiles") {
      let profiles;
      try {
        profiles = await fetchSupportedProfiles();
      } catch (err) {
        return errorResponse(`Could not reach HAPI FHIR at ${HAPI_BASE_URL}. Details: ${err.message}`);
      }
      return jsonResponse({ success: true, ...profiles });
    }

    // ---- explain_error ----
    if (name === "explain_error") {
      const { error_message, resource_type } = ExplainErrorInput.parse(args);

      let explanation;
      try {
        explanation = await explainErrorWithClaude(error_message, resource_type);
      } catch (err) {
        return errorResponse(`AI explanation failed: ${err.message}`);
      }

      return jsonResponse({
        success: true,
        error_message,
        resource_type: resource_type ?? null,
        ...explanation,
      });
    }

    // ---- batch_validate_and_fix ----
    if (name === "batch_validate_and_fix") {
      const { resources, use_us_core } = BatchValidateAndFixInput.parse(args);

      const batchResults = [];
      let totalFixed = 0;
      let totalAlreadyValid = 0;
      let totalFailed = 0;
      let totalLowConfidence = 0;

      for (let i = 0; i < resources.length; i++) {
        let resourceObj;
        try {
          resourceObj = JSON.parse(resources[i]);
        } catch {
          batchResults.push({
            index: i,
            success: false,
            error: "Invalid JSON — could not parse this resource.",
          });
          totalFailed++;
          continue;
        }

        if (!resourceObj.resourceType) {
          batchResults.push({
            index: i,
            success: false,
            error: "Missing resourceType field.",
          });
          totalFailed++;
          continue;
        }

        const profile = use_us_core ? US_CORE_PROFILES[resourceObj.resourceType] : undefined;
        const result = await processOneResource(resourceObj, profile);

        if (result.success && result.already_valid) totalAlreadyValid++;
        else if (result.success) {
          totalFixed++;
          if ((result.low_confidence_fixes ?? []).length > 0) totalLowConfidence++;
        } else {
          totalFailed++;
        }

        batchResults.push({
          index: i,
          resourceType: resourceObj.resourceType,
          id: resourceObj.id ?? "(no id)",
          us_core_profile: profile ?? null,
          ...result,
        });
      }

      return jsonResponse({
        success: true,
        summary: {
          total: resources.length,
          fixed: totalFixed,
          already_valid: totalAlreadyValid,
          failed: totalFailed,
          resources_with_low_confidence_fixes: totalLowConfidence,
        },
        results: batchResults,
      });
    }

    // ---- unknown tool ----
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error:
              err instanceof z.ZodError
                ? `Invalid input: ${err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`
                : `Unexpected error: ${err.message}`,
          }),
        },
      ],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

function errorResponse(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ success: false, error: message }) }],
  };
}

// ---------------------------------------------------------------------------
// Start — dual mode: HTTP/SSE when PORT is set, stdio for local Claude Desktop
// ---------------------------------------------------------------------------

async function startHttp(port) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Health / info endpoint
  app.get("/", (_req, res) => {
    res.json({
      name: "AI-Powered FHIR Auto-Fixer",
      version: "2.0.0",
      description: "MCP server that validates broken FHIR resources via HAPI FHIR and auto-fixes them using Claude AI.",
      hapi_endpoint: HAPI_BASE_URL,
      mcp_endpoint: "/sse",
      tools: ["validate_and_fix", "list_profiles", "explain_error", "batch_validate_and_fix"],
    });
  });

  // MCP SSE transport — each connection gets its own transport instance
  const transports = new Map();

  app.get("/sse", async (req, res) => {
    res.setHeader("X-Accel-Buffering", "no");  // ← this line is new
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => transports.delete(transport.sessionId));
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    await transport.handlePostMessage(req, res);
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
