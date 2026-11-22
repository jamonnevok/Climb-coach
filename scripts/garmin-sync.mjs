#!/usr/bin/env node
/**
 * Garmin -> private Gist (runs in GitHub Actions, free).
 * Env (GitHub repository secrets): GARMIN_API_KEY, GIST_TOKEN, GIST_ID
 * Optional env: GARMIN_DAYS (default 10)
 *
 * 1 token request + 3 data requests per run (sleep, HRV, daily summaries). Garmin does not
 * publish rate limits; users have reported HTTP 429 after ~47 requests/day, so the workflow
 * runs twice a day and never retries in a loop.
 *
 * PRIVACY: Action logs of a public repo are public. This script logs only counts and status
 * codes — never health values, keys or tokens. Raw responses go to the PRIVATE gist only.
 */
const API = 'https://personal.connectapi.garmin.com';
const { GARMIN_API_KEY, GIST_TOKEN, GIST_ID } = process.env;
const DAYS = Math.max(2, Math.min(28, Number(process.env.GARMIN_DAYS ?? 10)));

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}
if (!GARMIN_API_KEY || !GIST_TOKEN || !GIST_ID) fail('Missing secret: GARMIN_API_KEY, GIST_TOKEN and GIST_ID are required.');

const iso = (d) => d.toISOString().slice(0, 10);
const to = new Date();
const from = new Date(to.getTime() - (DAYS - 1) * 86_400_000);

async function token() {
  const res = await fetch(`${API}/personalapitoken-service/personal-api/personal-api-key/token`, {
    method: 'POST',
    headers: { Authorization: `ApiKey ${GARMIN_API_KEY}` },
  });
  if (!res.ok) fail(`Token request failed (HTTP ${res.status}). Is the Garmin personal API key valid and not expired?`);
  // The response body is the token itself (plain text, may be JSON-quoted).
  const text = (await res.text()).trim();
  return text.replace(/^"|"$/g, '');
}

async function get(tok, path, label, errors) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' } });
  console.log(`${label}: HTTP ${res.status}`);
  if (!res.ok) {
    errors[label] = `HTTP ${res.status}`;
    return null;
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    errors[label] = 'invalid JSON';
    return null;
  }
}

function countDated(json) {
  let n = 0;
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof v.calendarDate === 'string') n++;
      Object.values(v).forEach(walk);
    }
  };
  walk(json);
  return n;
}

const tok = await token();
const errors = {};
const f = iso(from);
const t = iso(to);
const sleep = await get(tok, `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${f}&endDate=${t}`, 'sleep', errors);
const hrv = await get(tok, `/hrv-service/hrv/daily/${f}/${t}`, 'hrv', errors);
const daily = await get(tok, `/usersummary-service/v2/dailysummaries?startDate=${f}&endDate=${t}`, 'daily', errors);
console.log(`dated objects — sleep: ${countDated(sleep)}, hrv: ${countDated(hrv)}, daily: ${countDated(daily)}`);

const payload = { version: 1, fetchedAt: new Date().toISOString(), from: f, to: t, sleep, hrv, daily, errors };
const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${GIST_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ files: { 'garmin-raw.json': { content: JSON.stringify(payload) } } }),
});
if (!res.ok) fail(`Gist update failed (HTTP ${res.status}). Check GIST_TOKEN (gist permission) and GIST_ID.`);
console.log('garmin-raw.json written to the private gist.');
if (Object.keys(errors).length) console.log(`::warning::Some Garmin endpoints failed: ${Object.keys(errors).join(', ')}`);
