# AI-Powered FHIR Auto-Fixer MCP

An MCP (Model Context Protocol) tool that takes broken FHIR resources, 
automatically detects violations using HAPI FHIR and the official HL7 
validator, and uses Claude AI to generate corrected resources with 
confidence scores, report card grades, and clinical explanations.

## What it does

- Validates FHIR R4 resources against base FHIR and US Core rules
- Auto-detects the correct US Core profile based on resource type
- Uses Claude to generate a fully corrected resource
- Returns confidence scores on every fix
- Grades resources A-D before and after fixing
- Explains every fix in both technical and clinical language
- Supports single resources, Bundles, and batch processing

## Tools exposed

| Tool | Description |
|------|-------------|
| `validate_and_fix` | Validates and auto-fixes any FHIR resource |
| `batch_validate_and_fix` | Fixes multiple resources at once |
| `explain_error` | Explains any FHIR error in plain English |
| `list_profiles` | Lists all supported FHIR profiles |

## Tech stack

- Node.js MCP server
- HAPI FHIR 8.8.0 for base R4 validation
- HL7 official validator JAR for US Core validation
- Claude claude-sonnet-4-20250514 for AI-powered fixes
- Supports 19 US Core profiles across 17 resource types

