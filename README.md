# DemoMed Patient Risk Scoring Assessment

This project implements a patient risk scoring system for the DemoMed Healthcare API as part of a technical assessment.

## Overview
The script:
- Fetches patient data from a paginated API
- Handles rate limiting (429) and intermittent server errors (500/503)
- Computes risk scores based on:
  - Blood Pressure
  - Temperature
  - Age
- Generates alert lists:
  - High-risk patients (total risk ≥ 4)
  - Fever patients (temperature ≥ 99.6°F)
  - Data quality issues (invalid/missing fields)
- Submits results to the assessment API

## Tech Stack
- Node.js (JavaScript)
- Native Fetch API (Node 18+)

## Setup

### Requirements
- Node.js v18 or higher

### Install
No external dependencies required.

### Environment Variable
Set your API key as an environment variable:

```bash
export KSENSE_API_KEY=ak_e79abae9d437f32d422233ee023d335929e21982bfe3c73d

