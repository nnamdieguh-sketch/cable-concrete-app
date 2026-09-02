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

// Targeted at the DESIGN/CONSULTANCY stage, not construction.
//
// The commercial window for Cable Concrete opens when a design consultant is
// being procured — before anyone has written a specification. Once a works
// contract is awarded the spec already says "stone pitching" or "gabions" and
// the argument is against a locked document.
const QUERIES = [
  'expression of interest consultancy detailed design erosion gully control {country}',
  'request for proposals engineering design drainage channel lining {country}',
  'terms of reference feasibility study slope embankment protection {country}',
  'consultancy detailed engineering design dam spillway riverbank protection {country}',
  'World Bank AfDB consultant selection flood protection revetment design {country}'
];

// Cheap pre-filter so we only pay the model for plausible candidates.
// Weighted toward design-stage vocabulary.
const PROCUREMENT_HINTS = [
  // design / consultancy stage — what we actually want
  'expression of interest','eoi','terms of reference','tor','consultancy',
  'consultant','feasibility','detailed design','engineering design','esia',
  'request for proposal','rfp','shortlist','prequalification',
  // general procurement — kept so we still see early-stage project notices
  'tender','procure','bid','rfq','invitation','solicitation','notice'
];

// Lifecycle stages, ordered. Anything at 'works-awarded' is past our window.
// Pre-award stages rank ahead of post-award. Before an award the procuring
// agency is the lever — they run the process, they often know which consultant
// is likely to win, and a relationship built with them survives whoever gets
// it. Once the award is made you are talking to one firm about one job.
const STAGE_ORDER = ['design-tender','project-funded','design-underway','works-tender','works-awarded','unknown'];
const STAGE_LABEL = {
  'design-tender'   : '🟢 Design tender open',
  'design-underway' : '🟡 Design in progress',
  'project-funded'  : '🔵 Funded, design upcoming',
  'works-tender'    : '🟠 Works tender (spec locked)',
  'works-awarded'   : '🔴 Awarded (too late)',
  'unknown'         : '⚪ Stage unclear'
};

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
`You are screening web results for erosion-control ENGINEERING DESIGN opportunities in ${country}, on behalf of a manufacturer of articulated concrete block (ACB) revetment used for channel lining, gully rehabilitation, slope and shoreline protection.

CRITICAL — what makes something valuable here:
The commercial window is when a DESIGN CONSULTANT is being procured, or design is underway, because that is when the technical specification gets written. Once a works/construction contract is advertised or awarded, the specification is already fixed (typically to stone pitching, gabions or riprap) and the opportunity is gone.

So a small consultancy EOI for detailed design is worth FAR MORE than a billion-naira construction contract award. Score accordingly — do not be impressed by contract value.

STEP 1 — classify RELEVANCE. ACB revetment is a versatile product. It is specified for:
erosion and gully control; channel and canal lining; slope protection; embankment protection of all
kinds including road, rail and dam embankments; dam upstream faces, spillways, downstream aprons and
stilling basins; bridge pier and abutment scour protection; riverbank, shoreline and coastal
protection; levees and flood protection works; and permeable paving and pedestrian surfacing (the
open-cell CC G2 block at 40% open area is a paving product).

  "direct"     any of the applications listed above is named or clearly implied by the scope
  "adjacent"   civil works where such an application is plausible but not stated — watershed
               management programmes, urban stormwater and sanitation with a drainage component,
               road or rail projects where embankment and drainage scope is not spelled out,
               general infrastructure with a likely earthworks or water-control element
  "unrelated"  no physical civil works at all, or works with no surface, slope, channel or
               water-control element — water supply pipelines, treatment plants, WASH hardware,
               buildings, power, IT, supply of goods, pure policy or capacity-building studies,
               job adverts, directories, academic papers

STEP 2 — classify STAGE:
  "design-tender"    EOI, RFP, ToR or consultant shortlisting for feasibility study, detailed engineering design, ESIA+design, or technical design services
  "design-underway"  a design consultant has been appointed, or design/feasibility work is in progress
  "project-funded"   project approved or financed, design not yet procured
  "works-tender"     construction/works tender advertised, bidding documents issued for physical works
  "works-awarded"    works contract awarded, contractor named, or construction begun
  "unknown"          cannot tell

STEP 3 — score 1-10. RELEVANCE IS A HARD CEILING, applied before stage:
  - "unrelated" scores 1-2. Never above 2, no matter how good the procurement stage is. A perfect
    design-stage EOI for water supply or road pavement is still a 2 — we cannot sell into it.
  - "adjacent" scores at most 6.
  - only "direct" may score 7-10.

Within those ceilings, rank by stage:
  9-10  direct relevance + design-tender — the specification is still open, this is the target
  7-8   direct relevance + design-underway, or direct + design-tender with some scope ambiguity
  5-6   project-funded with direct relevance, or any adjacent-relevance result
  3-4   works-tender — specification already written, useful only if it names a lining method to challenge
  1-2   works-awarded, unrelated relevance, or not a real opportunity (directory, job advert, academic paper, marketing)

If the snippet names civil works but not enough detail to confirm an ACB application, use "adjacent"
rather than guessing "direct". Reserve "unrelated" for work that genuinely has no surface, slope,
channel or water-control element — not merely for scope that is vaguely described.

For each result return an object with:
  i         - the index number given
  relevance - one of the relevance strings above
  stage     - one of the stage strings above
  score     - 1-10
  project   - short project name, or null
  location  - state/city/region, or null
  funder    - the body providing the money (World Bank, AfDB, KfW, state government), or null
  agency    - the government ministry, authority, agency or unit RUNNING this procurement and
              receiving submissions. This is usually different from the funder: the World Bank may
              fund it while a Federal Ministry of Water Resources, a state Ministry of Environment,
              KeNHA, KERRA or a project implementation unit actually runs it. Give the specific body
              named in the notice, not the country. null if genuinely not stated.
  contact   - any enquiry contact given: named officer, office, email, phone, or the address for
              collecting or submitting documents. Quote it as written. null if none.
  work      - the erosion work involved in a few words, or null
  deadline  - submission deadline in YYYY-MM-DD if one is stated, else null. Do NOT put project durations or start dates here.
  approved_date  - date the project was approved, financed or the loan/credit signed, as YYYY-MM-DD or YYYY-MM, else null
  published_date - date THIS notice, tender or EOI was published, as YYYY-MM-DD or YYYY-MM, else null
  awarded_date   - date a design consultant was appointed or the contract signed, as YYYY-MM-DD or YYYY-MM, else null
  spec      - any lining method named (stone pitching, gabions, riprap, concrete lining), or null

Timing matters more than anything else here, so extract those three dates whenever the snippet gives
them, even approximately to the month. Never invent a date, and never carry one field's date into
another — a project approved in 2023 whose tender published in 2026 must show both, not one repeated.
  why       - one short clause on why it scored that way

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

// ── Timing ─────────────────────────────────────────────────────────────────
// Where a project sits in time decides whether it is worth a call today.
// A design tender closing in 10 days needs acting on now; a consultant
// appointed last month is the single best moment to approach, because the
// firm is known and the specification is not yet written.

const DAY = 86_400_000;

/** Accepts YYYY-MM-DD, YYYY-MM, or anything Date.parse handles. */
function parseLooseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(str);
  if (m) {
    const t = Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 1);
    return Number.isNaN(t) ? null : { t, monthOnly: !m[3] };
  }
  const t = Date.parse(str);
  return Number.isNaN(t) ? null : { t, monthOnly: false };
}

const daysUntil = t => Math.round((t - Date.now()) / DAY);
const daysSince = t => Math.round((Date.now() - t) / DAY);

function fmtDate(p) {
  if (!p) return null;
  return new Date(p.t).toLocaleDateString('en-GB', p.monthOnly
    ? { year: 'numeric', month: 'short', timeZone: 'UTC' }
    : { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** One-line project chronology, only including the dates we actually have. */
function timelineLine(h) {
  const parts = [];
  const ap = parseLooseDate(h.approved_date);
  const pu = parseLooseDate(h.published_date);
  const aw = parseLooseDate(h.awarded_date);
  const dl = parseLooseDate(h.deadline);

  if (ap) parts.push(`approved ${fmtDate(ap)}`);
  if (pu) {
    const d = daysSince(pu.t);
    parts.push(`published ${fmtDate(pu)}${d >= 0 ? ` _(${d}d ago)_` : ''}`);
  }
  if (aw) {
    const d = daysSince(aw.t);
    parts.push(`consultant appointed ${fmtDate(aw)}${d >= 0 ? ` _(${d}d ago)_` : ''}`);
  }
  if (dl) {
    const d = daysUntil(dl.t);
    parts.push(d >= 0 ? `**closes ${fmtDate(dl)} — ${d} days left**` : `closed ${fmtDate(dl)}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Ranks how time-critical a hit is. rank 0 sorts to the very top.
 *
 * Pre-award beats post-award. While a tender is still open the procuring
 * agency is contactable, knows the field, and can often say which consultant
 * is likely to win — and a relationship formed then carries over to whoever
 * does. After the award you are down to one firm and one conversation.
 */
const PRE_AWARD = new Set(['design-tender', 'project-funded']);

function urgency(h) {
  const dl = parseLooseDate(h.deadline);
  const aw = parseLooseDate(h.awarded_date);
  const pu = parseLooseDate(h.published_date);
  const preAward = PRE_AWARD.has(h.stage);

  // Open tender about to close — the agency is live and reachable right now.
  if (preAward && dl) {
    const d = daysUntil(dl.t);
    if (d >= 0 && d <= 21) return { rank: 0, tag: `⏳ CLOSES IN ${d} DAYS — CONTACT THE AGENCY NOW` };
  }
  // Open tender with runway, or one whose deadline isn't stated. Still
  // pre-award, so still the best moment to build the relationship.
  if (h.stage === 'design-tender') {
    if (dl) {
      const d = daysUntil(dl.t);
      if (d >= 0) return { rank: 1, tag: `📋 TENDER OPEN — ${d} days to award` };
    }
    return { rank: 1, tag: `📋 TENDER OPEN — contact the agency` };
  }
  // Funded but not yet tendered — earliest possible approach.
  if (h.stage === 'project-funded') {
    return { rank: 2, tag: `🌱 PRE-TENDER — agency reachable before the process starts` };
  }
  // Award already made. Useful, but now it is one firm rather than the agency.
  if (aw) {
    const d = daysSince(aw.t);
    if (d >= 0 && d <= 90) return { rank: 3, tag: `🆕 designer appointed ${d}d ago — approach the firm` };
  }
  if (pu) {
    const d = daysSince(pu.t);
    if (d >= 0 && d <= 30) return { rank: 4, tag: `📰 published ${d}d ago` };
  }
  return { rank: 5, tag: null };
}

// ── Post-filters ───────────────────────────────────────────────────────────

/**
 * Design tenders have short submission windows, so an expired one is dead
 * weight. Only drops entries whose deadline parses cleanly AND sits more than
 * a fortnight in the past — anything ambiguous ("30 months from award",
 * "March 2025") is kept rather than guessed at.
 */
function isExpired(deadline) {
  if (!deadline) return false;
  const t = Date.parse(deadline);
  if (Number.isNaN(t)) return false;
  return t < Date.now() - 14 * 86_400_000;
}

/** Time-critical first, then lifecycle position, then score. */
function compareHits(a, b) {
  const u = urgency(a).rank - urgency(b).rank;
  if (u !== 0) return u;
  const s = STAGE_ORDER.indexOf(a.stage ?? 'unknown') - STAGE_ORDER.indexOf(b.stage ?? 'unknown');
  if (s !== 0) return s;
  return b.score - a.score;
}

/**
 * The same project often surfaces from several news sources — run #1 carried
 * Bulbula/Gayawa twice. Collapse on normalised project name, keeping whichever
 * copy scored highest.
 */
function dedupeByProject(hits) {
  const best = new Map();
  for (const h of hits) {
    const key = String(h.project || h.title || h.url)
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const prev = best.get(key);
    if (!prev || h.score > prev.score) best.set(key, h);
  }
  return [...best.values()];
}

// ── Digest ─────────────────────────────────────────────────────────────────
function buildDigest(hits, dropped) {
  const today = new Date().toISOString().slice(0, 10);
  const byCountry = {};
  for (const h of hits) (byCountry[h.country] ??= []).push(h);

  const actionable = hits.filter(h => h.stage === 'design-tender' || h.stage === 'design-underway').length;

  let md = `**${hits.length} opportunit${hits.length === 1 ? 'y' : 'ies'}** — `;
  md += `**${actionable} at design stage**, where the specification is still open.\n\n`;
  md += `Scored on procurement stage, not contract value: a consultancy EOI for detailed design outranks a billion-naira works award, because by award the lining method is already fixed.\n\n`;

  // Anything time-critical goes above the fold — a tender closing in a
  // fortnight or a designer appointed last month is worth acting on today,
  // and shouldn't be buried three countries down the page.
  const urgent = hits.map(h => ({ h, u: urgency(h) }))
                     .filter(x => x.u.rank <= 2)
                     .sort((a, b) => a.u.rank - b.u.rank);
  if (urgent.length) {
    md += `## ⚡ Pre-award — agency still reachable\n\n`;
    md += `The award has not been made on these, so the procuring agency is the contact. They run the process, they know the field, and a relationship formed now carries over to whoever wins.\n\n`;
    for (const { h, u } of urgent) {
      md += `- **${u.tag}** — ${h.project || h.title} _(${h.country})_\n`;
      if (h.agency) md += `  ☎️ **${h.agency}**${h.contact ? ` · ${h.contact}` : ''}\n`;
      const tl = timelineLine(h);
      if (tl) md += `  ${tl}\n`;
    }
    md += `\n`;
  }

  md += `Only results scoring ${SCORE_THRESHOLD}+ are shown.\n\n---\n\n`;

  for (const country of Object.keys(byCountry).sort()) {
    md += `## ${country}\n\n`;
    const sorted = byCountry[country].sort(compareHits);
    for (const h of sorted) {
      const rel = h.relevance === 'adjacent' ? ' · _adjacent scope_' : '';
      const u   = urgency(h);
      md += `### ${STAGE_LABEL[h.stage] ?? STAGE_LABEL.unknown} · ${h.score}/10 — ${h.project || h.title}${rel}\n\n`;
      if (u.tag)      md += `> **${u.tag}**\n\n`;
      const tl = timelineLine(h);
      if (tl)         md += `- **Timeline:** ${tl}\n`;
      if (h.agency)   md += `- **☎️ Procuring agency:** ${h.agency}${PRE_AWARD.has(h.stage) ? ' — reachable now, pre-award' : ''}\n`;
      if (h.contact)  md += `- **Contact:** ${h.contact}\n`;
      if (h.location) md += `- **Location:** ${h.location}\n`;
      if (h.funder)   md += `- **Funder:** ${h.funder}\n`;
      if (h.work)     md += `- **Work:** ${h.work}\n`;
      if (h.spec)     md += `- **Lining specified:** ${h.spec} ← displacement opportunity\n`;
      if (h.why)      md += `- **Why it scored:** ${h.why}\n`;
      md += `- **Source:** ${h.url}\n\n`;
    }
  }

  md += `---\n\n`;
  md += `<details><summary>Run detail</summary>\n\n`;
  md += `| | |\n|---|---|\n`;
  md += `| Spend | **$${spend.usd.toFixed(4)}** of $${MAX_SPEND_USD.toFixed(2)} cap |\n`;
  md += `| Brave searches | ${spend.braveCalls} |\n`;
  md += `| Model calls | ${spend.modelCalls} |\n`;
  md += `| Tokens | ${spend.inTokens.toLocaleString()} in / ${spend.outTokens.toLocaleString()} out |\n`;
  md += `| Dropped — expired deadline | ${dropped.expired} |\n`;
  md += `| Dropped — duplicate project | ${dropped.duplicate} |\n`;
  md += `\nToken counts are read from the API response, so this figure is actual, not estimated.\n\n`;
  md += `</details>\n\n`;
  md += `_Scanned ${MARKETS.length} markets on ${today}. Public procurement notices only — no personal data collected, no outreach sent._`;
  return md;
}

async function createIssue(title, body) {
  // Assign to the repo owner. GitHub defaults an owned repo's watch setting to
  // "Participating and @mentions", so an issue opened by github-actions[bot]
  // generates no notification on its own. Being assigned always does.
  const owner = (GH_REPO || '').split('/')[0];

  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title,
      body,
      labels: ['opportunity-monitor'],
      ...(owner ? { assignees: [owner] } : {})
    })
  });
  if (!r.ok) throw new Error(`Issue creation failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const issue = await r.json();
  console.log(`\nIssue created: ${issue.html_url}`);
  console.log(`  assigned to: ${issue.assignees?.map(a => a.login).join(', ') || '(none — check assignee permissions)'}`);
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

  const dropped = { expired: 0, duplicate: 0 };

  const live = hits.filter(h => {
    if (isExpired(h.deadline)) { dropped.expired++; return false; }
    return true;
  });

  const beforeDedupe = live.length;
  let final = dedupeByProject(live);
  dropped.duplicate = beforeDedupe - final.length;

  final.sort(compareHits);

  const atDesign = final.filter(h => h.stage === 'design-tender' || h.stage === 'design-underway').length;
  console.log(`${hits.length} scored at or above ${SCORE_THRESHOLD}.`);
  console.log(`  dropped ${dropped.expired} expired, ${dropped.duplicate} duplicate → ${final.length} reported`);
  console.log(`  of which ${atDesign} are at design stage (spec still open)`);
  console.log(`Run cost: $${spend.usd.toFixed(4)} (${spend.braveCalls} searches, ${spend.modelCalls} model calls)\n`);

  saveSeen([...seenSet]);

  if (final.length === 0) {
    console.log('Nothing worth reporting — no issue created.');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  await createIssue(
    `Erosion design opportunities — ${today} (${final.length}, ${atDesign} at design stage)`,
    buildDigest(final, dropped)
  );
}

main().catch(err => { console.error(err); process.exit(1); });
