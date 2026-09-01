/**
 * Cable Concrete® — Erosion Control Opportunity Monitor
 * ---------------------------------------------------------------------------
 * Finds PROJECTS, not people. Scans public tender and procurement notices for
 * erosion control, gully rehabilitation, channel lining and slope protection
 * work across IECS Africa's markets, then posts a digest as a GitHub Issue.
 *
 * Deliberately does NOT scrape personal email addresses or send outreach.
 * Everything it reads is a public procurement notice.
 *
 * Cost control differs from the old Apps Script version in two ways that
 * matter: results are batch-scored (one model call per ~10 results instead of
 * one per result), and spend is computed from the API's real reported token
 * usage rather than hardcoded guesses.
 *
 * Requires env: BRAVE_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN,
 *               GITHUB_REPOSITORY
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE      = dirname(fileURLToPath(import.meta.url));
const SEEN_PATH = join(HERE, 'seen.json');

const BRAVE_KEY     = process.env.BRAVE_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GH_TOKEN      = process.env.GITHUB_TOKEN;
const GH_REPO       = process.env.GITHUB_REPOSITORY;

// ── Tuning ─────────────────────────────────────────────────────────────────
const MODEL             = 'claude-haiku-4-5-20251001';
const MARKETS           = ['Nigeria','Ghana','Kenya','Tanzania','Ethiopia','Uganda','Zambia','Mozambique'];
const MAX_SPEND_USD     = 1.50;   // hard ceiling per run
const SCORE_THRESHOLD   = 6;      // 1-10; below this we don't report it
const BATCH_SIZE        = 10;     // results per model call
const RESULTS_PER_QUERY = 10;
const SEEN_RETENTION    = 2000;   // URLs to remember before trimming oldest

// Brave list pricing, and Haiku 4.5 per-million-token pricing.
const BRAVE_COST_PER_SEARCH = 0.005;
const IN_COST_PER_TOKEN     = 1.00 / 1_000_000;
const OUT_COST_PER_TOKEN    = 5.00 / 1_000_000;

// Procurement-flavoured queries. We're hunting notices, not directories.
const QUERIES = [
  'erosion control tender {country}',
  'gully erosion rehabilitation contract award {country}',
  'ACReSAL NEWMAP erosion control project {country}',
  'World Bank AfDB erosion control procurement notice {country}',
  'slope protection channel lining invitation to bid {country}'
];

// Cheap pre-filter so we only pay the model for plausible candidates.
const PROCUREMENT_HINTS = [
  'tender','procure','bid','rfp','rfq','expression of interest','eoi',
  'contract','award','invitation','prequalification','solicitation','notice'
];

const spend = { usd: 0, braveCalls: 0, modelCalls: 0, inTokens: 0, outTokens: 0 };
const budgetLeft = () => MAX_SPEND_USD - spend.usd;

// ── Dedup store ────────────────────────────────────────────────────────────
function loadSeen() {
  if (!existsSync(SEEN_PATH)) return { urls: [], lastRun: null };
  try {
    const parsed = JSON.parse(readFileSync(SEEN_PATH, 'utf8'));
    return { urls: Array.isArray(parsed.urls) ? parsed.urls : [], lastRun: parsed.lastRun || null };
  } catch {
    return { urls: [], lastRun: null };
  }
}

function saveSeen(urls) {
  const trimmed = urls.slice(-SEEN_RETENTION);
  writeFileSync(SEEN_PATH, JSON.stringify({
    urls: trimmed,
    lastRun: new Date().toISOString(),
    count: trimmed.length
  }, null, 2) + '\n');
}

// ── Brave search ───────────────────────────────────────────────────────────
async function braveSearch(query) {
  if (budgetLeft() < BRAVE_COST_PER_SEARCH) return [];
  const url = 'https://api.search.brave.com/res/v1/web/search'
    + `?q=${encodeURIComponent(query)}&count=${RESULTS_PER_QUERY}`;
  try {
    const r = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_KEY
      }
    });
    spend.braveCalls++;
    spend.usd += BRAVE_COST_PER_SEARCH;
    if (!r.ok) {
      console.warn(`  Brave ${r.status} for "${query}"`);
      return [];
    }
    const data = await r.json();
    return data?.web?.results ?? [];
  } catch (err) {
    console.warn(`  Brave threw for "${query}": ${err.message}`);
    return [];
  }
}

// ── Claude batch extraction ────────────────────────────────────────────────
async function scoreBatch(batch, country) {
  const listing = batch.map((r, i) =>
    `[${i}]\nTitle: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`
  ).join('\n\n');

  const prompt =
`You are screening web results for genuine erosion-control PROCUREMENT OPPORTUNITIES in ${country} — tenders, bids, contract awards, expressions of interest, or funded project announcements that could need articulated concrete block revetment (channel lining, gully rehabilitation, slope protection, shoreline protection).

Score each result 1-10 for how likely it is to be a real, actionable project opportunity.

Score HIGH (7-10): a named project or tender with a location, a funder (World Bank, AfDB, ACReSAL, NEWMAP, state ministry), a scope involving erosion/channel/slope work, ideally a deadline or reference number.
Score MEDIUM (4-6): a real project mentioned but vague on scope, funding or timing.
Score LOW (1-3): directories, job adverts, academic papers, news with no project, company marketing, anything not an actual opportunity.

For each result return an object with:
  i        - the index number given
  score    - 1-10
  project  - short project name, or null
  location - state/city/region, or null
  funder   - funding body, or null
  work     - the erosion work involved in a few words, or null
  deadline - any date mentioned, or null
  why      - one short clause on why it scored that way

Return ONLY a JSON array, no prose, no code fences.

RESULTS:
${listing}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!r.ok) {
      console.warn(`  Model ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return [];
    }

    const data = await r.json();
    spend.modelCalls++;
    // Real usage from the API, not an estimate — this is what the old script
    // got wrong, so its $20 cap was never actually enforced.
    const u = data.usage ?? {};
    spend.inTokens  += u.input_tokens  ?? 0;
    spend.outTokens += u.output_tokens ?? 0;
    spend.usd += (u.input_tokens ?? 0) * IN_COST_PER_TOKEN
               + (u.output_tokens ?? 0) * OUT_COST_PER_TOKEN;

    let text = (data.content?.[0]?.text ?? '').trim().replace(/```json|```/g, '').trim();
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return [];

    return arr
      .filter(o => o && typeof o.i === 'number' && batch[o.i])
      .map(o => ({ ...o, ...batch[o.i], country }));
  } catch (err) {
    console.warn(`  Scoring threw: ${err.message}`);
    return [];
  }
}

// ── Digest ─────────────────────────────────────────────────────────────────
function buildDigest(hits) {
  const today = new Date().toISOString().slice(0, 10);
  const byCountry = {};
  for (const h of hits) (byCountry[h.country] ??= []).push(h);

  let md = `**${hits.length} erosion-control opportunit${hits.length === 1 ? 'y' : 'ies'}** found in the last scan.\n\n`;
  md += `Sorted by score. Only results scoring ${SCORE_THRESHOLD}+ are shown.\n\n---\n\n`;

  for (const country of Object.keys(byCountry).sort()) {
    md += `## ${country}\n\n`;
    for (const h of byCountry[country].sort((a, b) => b.score - a.score)) {
      md += `### ${h.score}/10 — ${h.project || h.title}\n\n`;
      if (h.location) md += `- **Location:** ${h.location}\n`;
      if (h.funder)   md += `- **Funder:** ${h.funder}\n`;
      if (h.work)     md += `- **Work:** ${h.work}\n`;
      if (h.deadline) md += `- **Deadline:** ${h.deadline}\n`;
      if (h.why)      md += `- **Why it scored:** ${h.why}\n`;
      md += `- **Source:** ${h.url}\n\n`;
    }
  }

  md += `---\n\n`;
  md += `<details><summary>Run cost</summary>\n\n`;
  md += `| | |\n|---|---|\n`;
  md += `| Spend | **$${spend.usd.toFixed(4)}** of $${MAX_SPEND_USD.toFixed(2)} cap |\n`;
  md += `| Brave searches | ${spend.braveCalls} |\n`;
  md += `| Model calls | ${spend.modelCalls} |\n`;
  md += `| Tokens | ${spend.inTokens.toLocaleString()} in / ${spend.outTokens.toLocaleString()} out |\n`;
  md += `\nToken counts are read from the API response, so this figure is actual, not estimated.\n\n`;
  md += `</details>\n\n`;
  md += `_Scanned ${MARKETS.length} markets on ${today}. Public procurement notices only — no personal data collected, no outreach sent._`;
  return md;
}

async function createIssue(title, body) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ title, body, labels: ['opportunity-monitor'] })
  });
  if (!r.ok) throw new Error(`Issue creation failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const issue = await r.json();
  console.log(`\nIssue created: ${issue.html_url}`);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  for (const [name, val] of Object.entries({ BRAVE_API_KEY: BRAVE_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY, GITHUB_TOKEN: GH_TOKEN })) {
    if (!val) { console.error(`Missing ${name}`); process.exit(1); }
  }

  const seen = loadSeen();
  const seenSet = new Set(seen.urls);
  console.log(`Dedup store holds ${seenSet.size} URLs. Last run: ${seen.lastRun ?? 'never'}\n`);

  const candidates = [];
  const freshUrls  = [];

  for (const country of MARKETS) {
    if (budgetLeft() <= 0) { console.log('Budget cap reached — stopping search.'); break; }
    console.log(`Searching ${country}…`);

    for (const template of QUERIES) {
      if (budgetLeft() <= 0) break;
      const results = await braveSearch(template.replace('{country}', country));

      for (const item of results) {
        const url = item.url;
        if (!url || seenSet.has(url)) continue;
        seenSet.add(url);
        freshUrls.push(url);

        const title   = item.title || '';
        const snippet = item.description || '';
        const haystack = `${title} ${snippet} ${url}`.toLowerCase();

        // Cheap keyword gate before we pay the model for anything.
        if (!PROCUREMENT_HINTS.some(h => haystack.includes(h))) continue;

        candidates.push({ title, url, snippet: snippet.slice(0, 400), country });
      }
      await new Promise(r => setTimeout(r, 300));  // be polite to Brave
    }
  }

  console.log(`\n${freshUrls.length} new URLs, ${candidates.length} passed the procurement filter.\n`);

  const hits = [];
  const byCountry = {};
  for (const c of candidates) (byCountry[c.country] ??= []).push(c);

  for (const [country, list] of Object.entries(byCountry)) {
    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      if (budgetLeft() <= 0) { console.log('Budget cap reached — stopping scoring.'); break; }
      const batch = list.slice(i, i + BATCH_SIZE).map((c, idx) => ({ ...c, _idx: idx }));
      const scored = await scoreBatch(batch, country);
      hits.push(...scored.filter(s => (s.score ?? 0) >= SCORE_THRESHOLD));
    }
  }

  hits.sort((a, b) => b.score - a.score);
  console.log(`${hits.length} scored at or above ${SCORE_THRESHOLD}.`);
  console.log(`Run cost: $${spend.usd.toFixed(4)} (${spend.braveCalls} searches, ${spend.modelCalls} model calls)\n`);

  saveSeen([...seenSet]);

  if (hits.length === 0) {
    console.log('Nothing worth reporting — no issue created.');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  await createIssue(`Erosion control opportunities — ${today} (${hits.length})`, buildDigest(hits));
}

main().catch(err => { console.error(err); process.exit(1); });
