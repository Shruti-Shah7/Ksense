/**
 * DemoMed Assessment - Full Solution (pagination + retries + scoring + submit)
 * Run:
 *   node risk_submit.js
 *
 * Or set env:
 *   KSENSE_API_KEY=... node risk_submit.js
 */

const API_KEY =
  process.env.KSENSE_API_KEY ||
  "ak_e79abae9d437f32d422233ee023d335929e21982bfe3c73d";

const BASE_URL = "https://assessment.ksensetech.com/api";
const PATIENTS_URL = `${BASE_URL}/patients`;
const SUBMIT_URL = `${BASE_URL}/submit-assessment`;

// Keep requests safe for rate limits
const LIMIT = 20; // max allowed
const MAX_RETRIES = 8;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isNullishOrEmpty(v) {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function toNumberStrict(v) {
  if (isNullishOrEmpty(v)) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseBP(bpValue) {
  // Accept only "SYS/DIA" where both are integers
  if (isNullishOrEmpty(bpValue)) return { ok: false, sys: null, dia: null };
  if (typeof bpValue !== "string") return { ok: false, sys: null, dia: null };

  const m = bpValue.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return { ok: false, sys: null, dia: null };

  const sys = Number(m[1]);
  const dia = Number(m[2]);
  if (!Number.isFinite(sys) || !Number.isFinite(dia)) return { ok: false, sys: null, dia: null };

  return { ok: true, sys, dia };
}

/**
 * SCORING — using YOUR PASTED SPEC (not the screenshot)
 *
 * BP:
 * Normal (<120 AND <80): 1
 * Elevated (120-129 AND <80): 2
 * Stage1 (130-139 OR 80-89): 3
 * Stage2 (>=140 OR >=90): 4
 * Invalid: 0 + data quality flag
 *
 * Temp:
 * <=99.5: 0
 * 99.6-100.9: 1
 * >=101.0: 2
 * Invalid: 0 + data quality flag
 *
 * Age:
 * Under 40: 1 (your text shows "1" even though it also says "Under 40: 1 points")
 * 40-65 inclusive: 1
 * Over 65: 2
 * Invalid: 0 + data quality flag
 */

function bpScore(bpRaw) {
    const { ok, sys, dia } = parseBP(bpRaw);
    if (!ok) return { score: 0, valid: false };
  
    if (sys >= 140 || dia >= 90) return { score: 3, valid: true };                    // Stage 2
    if ((sys >= 130 && sys <= 139) || (dia >= 80 && dia <= 89)) return { score: 2, valid: true }; // Stage 1
    if (sys >= 120 && sys <= 129 && dia < 80) return { score: 1, valid: true };       // Elevated
    if (sys < 120 && dia < 80) return { score: 0, valid: true };                      // Normal
  
    return { score: 0, valid: true };
}
  

function tempScore(tempRaw) {
  const t = toNumberStrict(tempRaw);
  if (t === null) return { score: 0, valid: false, fever: false };

  if (t >= 101.0) return { score: 2, valid: true, fever: true };
  if (t >= 99.6 && t <= 100.9) return { score: 1, valid: true, fever: true };
  return { score: 0, valid: true, fever: false };
}

function ageScore(ageRaw) {
    const a = toNumberStrict(ageRaw);
    if (a === null) return { score: 0, valid: false };
  
    if (a > 65) return { score: 2, valid: true };
    if (a >= 40 && a <= 65) return { score: 1, valid: true };
    return { score: 0, valid: true }; // under 40
}
  

// Robust fetch with retries for 429, 500, 503
async function fetchWithRetry(url, options = {}) {
  let attempt = 0;

  while (true) {
    attempt++;
    const res = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        "x-api-key": API_KEY,
        Accept: "application/json",
      },
    });

    // Success
    if (res.ok) return res;

    const status = res.status;

    // Retryable statuses: 429, 500, 503
    const retryable = status === 429 || status === 500 || status === 503;

    if (!retryable || attempt >= MAX_RETRIES) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Request failed (${status}) after ${attempt} attempts: ${txt}`);
    }

    // backoff
    const retryAfter = res.headers.get("retry-after");
    let waitMs;

    if (retryAfter) {
      const sec = Number(retryAfter);
      waitMs = Number.isFinite(sec) ? sec * 1000 : 0;
    } else {
      // exponential backoff + jitter
      const base = 300 * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 250);
      waitMs = Math.min(8000, base + jitter);
    }

    await sleep(waitMs);
  }
}

async function getPatientsPage(page, limit) {
  const url = `${PATIENTS_URL}?page=${page}&limit=${limit}`;
  const res = await fetchWithRetry(url, { method: "GET" });
  const json = await res.json();

  // Inconsistent responses handling:
  // expected: { data: [...], pagination: {...} }
  // sometimes might be just an array or nested differently
  let data = [];
  let pagination = null;

  if (Array.isArray(json)) {
    data = json;
  } else if (Array.isArray(json?.data)) {
    data = json.data;
  } else if (Array.isArray(json?.patients)) {
    data = json.patients;
  } else if (Array.isArray(json?.result)) {
    data = json.result;
  }

  pagination = json?.pagination || null;

  return { data, pagination };
}

function computeAlerts(allPatients) {
  const highRisk = new Set();
  const fever = new Set();
  const dq = new Set();

  for (const p of allPatients) {
    const id = typeof p?.patient_id === "string" ? p.patient_id : String(p?.patient_id ?? "");
    if (!id) continue;

    const bp = bpScore(p?.blood_pressure);
    const tmp = tempScore(p?.temperature);
    const age = ageScore(p?.age);

    const total = bp.score + tmp.score + age.score;

    if (!bp.valid || !tmp.valid || !age.valid) dq.add(id);
    if (tmp.valid && tmp.fever) fever.add(id);
    if (total >= 4) highRisk.add(id);
  }

  const toSortedArray = (s) => Array.from(s).sort();

  return {
    high_risk_patients: toSortedArray(highRisk),
    fever_patients: toSortedArray(fever),
    data_quality_issues: toSortedArray(dq),
  };
}

async function submitAlerts(payload) {
  const res = await fetchWithRetry(SUBMIT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function main() {
  console.log("Fetching all patients with pagination...");

  let page = 1;
  let all = [];
  let totalPages = null;

  while (true) {
    const { data, pagination } = await getPatientsPage(page, LIMIT);
    all = all.concat(data);

    // if pagination is present, use it
    if (pagination && typeof pagination.totalPages === "number") {
      totalPages = pagination.totalPages;
      if (pagination.hasNext === false) break;
      page++;
    } else {
      // If pagination missing/inconsistent:
      // Stop when a page returns empty or fewer than limit
      if (!data || data.length === 0) break;
      if (data.length < LIMIT) break;
      page++;
    }

    // gentle pacing to reduce 429 chance
    await sleep(150);
    if (totalPages && page > totalPages) break;
  }

  console.log(`Fetched ${all.length} patients.`);

  const payload = computeAlerts(all);

  console.log("Submitting payload:");
  console.log(JSON.stringify(payload, null, 2));

  const result = await submitAlerts(payload);

  console.log("\nSubmission response:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error("\nERROR:", e.message);
  process.exit(1);
});
