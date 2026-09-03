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

const DAY = 86_400_000;
const PIPELINE_SCOPE = '__pipeline__';

// ── Tuning ─────────────────────────────────────────────────────────────────
const MODEL             = 'claude-haiku-4-5-20251001';
const MARKETS           = ['Nigeria','Ghana','Kenya','Tanzania','Ethiopia','Uganda','Zambia','Mozambique'];
const MAX_SPEND_USD     = 1.50;   // hard ceiling per run
const SCORE_THRESHOLD   = 6;      // 1-10; below this we don't report it
const BATCH_SIZE        = 6;      // results per model call — the extraction
                                  // schema is ~14 fields wide, so keep responses
                                  // well clear of max_tokens
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

// Multilateral pipeline sweep — run once across Africa rather than per market,
// because the World Bank and AfDB project databases are continent-wide and the
// country falls out of the document itself.
//
// These target concept-stage paperwork: Project Information Documents,
// Environmental and Social Review Summaries, appraisal reports. They surface
// projects while scope is still being discussed, often a year or two before a
// design tender exists — the widest relationship window there is.
const PIPELINE_QUERIES = [
  'World Bank project information document erosion flood embankment Africa',
  'World Bank environmental social review summary concept stage drainage channel Africa',
  'African Development Bank project appraisal report erosion flood protection Africa',
  'World Bank pipeline project watershed erosion management Sub-Saharan Africa',
  'AfDB World Bank proposed project gully erosion slope protection preparation Africa'
];

// Country from the document, not from whichever search surfaced it. Run #4
// filed a Malawian tender under Mozambique purely because that search found it.
const TLD_COUNTRY = {
  ng:'Nigeria', gh:'Ghana', ke:'Kenya', tz:'Tanzania', et:'Ethiopia', ug:'Uganda',
  zm:'Zambia', mz:'Mozambique', mw:'Malawi', za:'South Africa', rw:'Rwanda',
  bw:'Botswana', na:'Namibia', zw:'Zimbabwe', sn:'Senegal', ci:'Côte d’Ivoire',
  cm:'Cameroon', ao:'Angola', bj:'Benin', bf:'Burkina Faso', ml:'Mali', ne:'Niger',
  td:'Chad', sd:'Sudan', ss:'South Sudan', so:'Somalia', dj:'Djibouti', er:'Eritrea',
  mg:'Madagascar', ls:'Lesotho', sz:'Eswatini', gm:'Gambia', gn:'Guinea', lr:'Liberia',
  sl:'Sierra Leone', tg:'Togo', cd:'DR Congo', cg:'Congo', ga:'Gabon', bi:'Burundi'
};

function resolveCountry(h, searchCountry) {
  const named = String(h.country_named || '').trim();
  if (named && !/^(africa|sub-saharan africa|multiple|various|n\/a)$/i.test(named)) return named;
  try {
    const m = /\.([a-z]{2})$/.exec(new URL(h.url).hostname);
    if (m && TLD_COUNTRY[m[1]]) return TLD_COUNTRY[m[1]];
  } catch { /* malformed url */ }
  return searchCountry === PIPELINE_SCOPE ? 'Africa — country unstated' : searchCountry;
}

// Brave ranks by authority, not recency, so an old well-linked PDF beats a
// fresh notice. Constrain every web search to the last month; the MDB APIs
// below cover anything older that still matters.
const BRAVE_FRESHNESS = 'pm';

// Where the early signal actually lives. Web search is an index of what is
// popular; these are the registries themselves, queryable by status and date.
const WB_PROJECTS_API = 'https://search.worldbank.org/api/v3/projects';
const WB_DOCS_API     = 'https://search.worldbank.org/api/v3/wds';

// How far back to look for newly-published documents each run.
const DOC_LOOKBACK_DAYS = 45;

// Scope is all of Sub-Saharan Africa, not just the eight priority markets.
// The MDB APIs are queried continent-wide at no extra cost per country, so
// widening here is free — only the per-country Brave searches are metered.
const AFRICA_COUNTRIES = new Set([
  'Nigeria','Ghana','Kenya','Tanzania','Ethiopia','Uganda','Zambia','Mozambique',
  'Malawi','Rwanda','Burundi','South Sudan','Sudan','Somalia','Djibouti','Eritrea',
  'Madagascar','Zimbabwe','Botswana','Namibia','Lesotho','Eswatini','Angola',
  'Cameroon','Senegal','Mali','Burkina Faso','Niger','Chad','Benin','Togo',
  'Guinea','Sierra Leone','Liberia','Gambia','Côte d\'Ivoire','Cote d\'Ivoire',
  'Congo, Democratic Republic of','Congo, Republic of','Gabon','Mauritania',
  'Central African Republic','South Africa','Comoros','Cabo Verde','Guinea-Bissau'
]);

// Terms that make a project or document worth scoring. Applied to the
// project objective / document title before we pay the model.
const MDB_RELEVANCE_TERMS = [
  'erosion','gully','channel','drainage','embankment','slope','revetment',
  'flood','watershed','riverbank','coastal','shoreline','spillway','scour',
  'dam','irrigation','canal','levee','stormwater','landslide','resilience'
];

const matchesRelevance = text =>
  MDB_RELEVANCE_TERMS.some(t => String(text || '').toLowerCase().includes(t));

// Concept-stage documents rarely say "tender" or "bid", so the procurement
// gate would throw them away. Gate the pipeline sweep on the vocabulary those
// documents actually use.
const PIPELINE_HINTS = [
  'project information document','pid','concept note','concept stage',
  'environmental and social review','esrs','appraisal report','appraisal document',
  'country strategy','pipeline','proposed project','project preparation',
  'identification','pre-appraisal','worldbank.org','afdb.org','documents.worldbank'
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
const STAGE_ORDER = ['design-tender','project-funded','pipeline','design-underway','works-tender','works-awarded','unknown'];
const STAGE_LABEL = {
  'design-tender'   : '🟢 Design tender open',
  'project-funded'  : '🔵 Funded, design upcoming',
  'pipeline'        : '🟣 Pipeline — under preparation',
  'design-underway' : '🟡 Design in progress',
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
/**
 * @param freshness Brave recency filter: pd/pw/pm/py, or a YYYY-MM-DDtoYYYY-MM-DD
 *   range. Without it Brave ranks by authority, which means a heavily-linked
 *   2016 PDF outranks last week's notice every time — the reason early runs
 *   kept surfacing finished projects.
 */
async function braveSearch(query, freshness = BRAVE_FRESHNESS) {
  if (budgetLeft() < BRAVE_COST_PER_SEARCH) return [];
  const url = 'https://api.search.brave.com/res/v1/web/search'
    + `?q=${encodeURIComponent(query)}&count=${RESULTS_PER_QUERY}`
    + (freshness ? `&freshness=${encodeURIComponent(freshness)}` : '');
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

// ── Multilateral registries ────────────────────────────────────────────────
// These are the authoritative sources. Unlike web search they can be filtered
// by status and date, which is the whole point: we want projects that are
// under preparation now, not the ones the web has had years to link to.

/** Fetch JSON, logging enough of the shape that a mismatch is diagnosable. */
async function fetchJson(url, label) {
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) { console.warn(`  ${label}: HTTP ${r.status}`); return null; }
    const j = await r.json();
    console.log(`  ${label}: top-level keys = ${Object.keys(j).join(', ')}`);
    return j;
  } catch (err) {
    console.warn(`  ${label} threw: ${err.message}`);
    return null;
  }
}

/**
 * World Bank projects at Pipeline status — approved for preparation but not
 * yet financed, so scope is still being written. This is the earliest point
 * at which a project is publicly identifiable.
 */
async function fetchWorldBankPipeline() {
  const fields = 'id,project_name,countryshortname,regionname,status,boardapprovaldate,url,pdo,sector1,theme1';
  const url = `${WB_PROJECTS_API}?format=json&rows=500&status=Pipeline&fl=${encodeURIComponent(fields)}`;
  const data = await fetchJson(url, 'WB Projects (Pipeline)');
  if (!data) return [];

  // The API returns { projects: { P123: {...}, ... } }; tolerate an array too.
  const raw = data.projects ?? data.docs ?? {};
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  console.log(`  WB Projects: ${list.length} pipeline records returned`);

  const out = [];
  for (const p of list) {
    const country = p.countryshortname || p.countryname || '';
    const region  = String(p.regionname || '');
    if (!AFRICA_COUNTRIES.has(country) && !/africa/i.test(region)) continue;

    const name = p.project_name || p.projectname || '';
    const pdo  = p.pdo || p.project_abstract?.cdata || '';
    if (!matchesRelevance(`${name} ${pdo}`)) continue;

    out.push({
      title:   name,
      url:     p.url || `https://projects.worldbank.org/en/projects-operations/project-detail/${p.id}`,
      snippet: `Status: Pipeline. ${String(pdo).slice(0, 350)}`,
      country,
      _source: 'wb-pipeline',
      _approved: p.boardapprovaldate || null
    });
  }
  console.log(`  WB Projects: ${out.length} African + erosion-relevant`);
  return out;
}

/**
 * Recently published World Bank project documents. Concept notes, PIDs and
 * ESRS appear here the week they are disclosed, which is months to years
 * before any tender. Date-filtered so we only ever see new disclosures.
 */
async function fetchWorldBankDocs() {
  const since = new Date(Date.now() - DOC_LOOKBACK_DAYS * DAY).toISOString().slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);
  const qterm = 'erosion OR gully OR embankment OR drainage OR "flood protection" OR revetment';
  const url = `${WB_DOCS_API}?format=json&rows=100&strdate=${since}&enddate=${until}`
            + `&qterm=${encodeURIComponent(qterm)}`;
  const data = await fetchJson(url, `WB Documents (since ${since})`);
  if (!data) return [];

  const raw = data.documents ?? data.docs ?? {};
  const list = (Array.isArray(raw) ? raw : Object.values(raw))
    .filter(d => d && typeof d === 'object' && (d.docdt || d.display_title || d.docna));
  console.log(`  WB Documents: ${list.length} records in window`);

  const out = [];
  for (const d of list) {
    const title = d.display_title || d.docna || d.doc_name || '';
    const country = d.count || d.countryname || '';
    if (country && !AFRICA_COUNTRIES.has(country) && !/africa/i.test(String(d.admreg || ''))) continue;
    if (!matchesRelevance(title)) continue;

    out.push({
      title,
      url:     d.pdfurl || d.url || d.guid || '',
      snippet: `${d.docty || 'World Bank document'} · disclosed ${String(d.docdt || '').slice(0, 10)}. ${String(d.abstracts?.cdata || '').slice(0, 300)}`,
      country: country || PIPELINE_SCOPE,
      _source: 'wb-docs',
      _published: String(d.docdt || '').slice(0, 10) || null
    });
  }
  console.log(`  WB Documents: ${out.length} African + erosion-relevant`);
  return out.filter(o => o.url);
}

/**
 * Parse a JSON array, recovering whatever is intact if the response was cut
 * short. Run #6 lost twelve batches — roughly 250 candidates including 55
 * World Bank pipeline projects — because max_tokens truncated the array and a
 * single JSON.parse failure discarded everything in it. Scanning for balanced
 * top-level objects means a truncation now costs the final partial record
 * rather than the whole batch.
 */
function parseMaybeTruncated(text) {
  try { return JSON.parse(text); } catch { /* fall through to salvage */ }

  const objects = [];
  let depth = 0, start = -1, inString = false, escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped)        escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"')  inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { objects.push(JSON.parse(text.slice(start, i + 1))); } catch { /* skip */ }
        start = -1;
      }
    }
  }
  if (objects.length) console.warn(`    salvaged ${objects.length} record(s) from a truncated response`);
  return objects;
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
  "pipeline"         project under identification, preparation, appraisal or discussion — a World Bank
                     Project Information Document (PID), Project Concept Note, Environmental and Social
                     Review Summary (ESRS), AfDB appraisal report, country strategy paper, or any
                     document describing a proposed intervention not yet approved or financed
  "project-funded"   project approved or financed, design not yet procured
  "design-tender"    EOI, RFP, ToR or consultant shortlisting for feasibility study, detailed engineering design, ESIA+design, or technical design services
  "design-underway"  a design consultant has been appointed, or design/feasibility work is in progress
  "works-tender"     construction/works tender advertised, bidding documents issued for physical works
  "works-awarded"    works contract awarded, contractor named, or construction begun
  "unknown"          cannot tell

Pipeline documents matter. A World Bank PID or ESRS naming erosion, drainage, embankment or flood
works describes a project whose scope is still being discussed, often a year or two before any tender
exists. Classify these as "pipeline" rather than "unknown" — they are wanted, not noise.

STEP 3 — score 1-10. RELEVANCE IS A HARD CEILING, applied before stage:
  - "unrelated" scores 1-2. Never above 2, no matter how good the procurement stage is. A perfect
    design-stage EOI for water supply or road pavement is still a 2 — we cannot sell into it.
  - "adjacent" scores at most 6.
  - only "direct" may score 7-10.

Within those ceilings, rank by stage:
  9-10  direct relevance + design-tender — the specification is still open, this is the target
  7-8   direct relevance + pipeline or project-funded — early, but scope is still being shaped and
        the agency and funder task team are both reachable; also direct + design-underway
  5-6   any adjacent-relevance result, or direct relevance with significant scope ambiguity
  3-4   works-tender — specification already written, useful only if it names a lining method to challenge
  1-2   works-awarded, unrelated relevance, or not a real opportunity (directory, job advert, academic paper, marketing)

If the snippet names civil works but not enough detail to confirm an ACB application, use "adjacent"
rather than guessing "direct". Reserve "unrelated" for work that genuinely has no surface, slope,
channel or water-control element — not merely for scope that is vaguely described.

For each result return an object with:
  i             - the index number given
  relevance     - one of the relevance strings above
  stage         - one of the stage strings above
  score         - 1-10
  country_named - the country this project is actually in, read from the document itself. Not the
                  region. If the document covers several countries or names none, use null. Do not
                  guess from the search terms.
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
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!r.ok) {
      console.warn(`  Model ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return null;   // call failed — caller must not burn these URLs
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
    const arr = parseMaybeTruncated(text);
    if (!Array.isArray(arr) || arr.length === 0) return [];

    return arr
      .filter(o => o && typeof o.i === 'number' && batch[o.i])
      // batch fields first so model output wins on conflicts, but keep the
      // registry's own dates when the snippet didn't restate them.
      .map(o => {
        const src = batch[o.i];
        return {
          ...src,
          ...o,
          country,
          published_date: o.published_date || src._published || null,
          approved_date:  o.approved_date  || src._approved  || null
        };
      });
  } catch (err) {
    console.warn(`  Scoring threw: ${err.message}`);
    return null;     // call failed — caller must not burn these URLs
  }
}

// ── Timing ─────────────────────────────────────────────────────────────────
// Where a project sits in time decides whether it is worth a call today.
// A design tender closing in 10 days needs acting on now; a consultant
// appointed last month is the single best moment to approach, because the
// firm is known and the specification is not yet written.

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
const PRE_AWARD = new Set(['design-tender', 'project-funded', 'pipeline']);
const STALE_AFTER_DAYS = 180;

/**
 * A notice published long ago with no future deadline is almost certainly
 * closed, whatever its wording says. Run #4 surfaced a Malawian ToR published
 * 854 days earlier and labelled it TENDER OPEN — the expired-deadline filter
 * missed it because the document stated no deadline at all, only a
 * publication date.
 *
 * Pipeline documents are exempt: a PID or ESRS describes a project under
 * preparation, and preparation legitimately runs for years, so age says
 * nothing about whether it is still live.
 */
function isStale(h) {
  if (h.stage === 'pipeline') return false;
  const dl = parseLooseDate(h.deadline);
  if (dl && daysUntil(dl.t) >= 0) return false;   // a future deadline means it's live
  const pu = parseLooseDate(h.published_date);
  return !!(pu && daysSince(pu.t) > STALE_AFTER_DAYS);
}

function urgency(h) {
  const dl = parseLooseDate(h.deadline);
  const aw = parseLooseDate(h.awarded_date);
  const pu = parseLooseDate(h.published_date);

  // Open tender about to close — the agency is live and reachable right now.
  if (PRE_AWARD.has(h.stage) && dl) {
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
    const age = pu ? ` · published ${daysSince(pu.t)}d ago` : '';
    return { rank: 1, tag: `📋 TENDER OPEN — contact the agency${age}` };
  }
  // Funded but not yet tendered — earliest possible approach.
  if (h.stage === 'project-funded') {
    return { rank: 2, tag: `🌱 PRE-TENDER — agency reachable before the process starts` };
  }
  // Under preparation. Longest runway of all, and both the agency and the
  // funder's task team are still shaping what gets specified.
  if (h.stage === 'pipeline') {
    const age = pu ? ` · doc published ${daysSince(pu.t)}d ago` : '';
    return { rank: 2, tag: `🟣 IN PREPARATION — scope still under discussion${age}` };
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
  md += `| Dropped — stale (>${STALE_AFTER_DAYS}d, no live deadline) | ${dropped.stale} |\n`;
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
  // URLs awaiting scoring. Kept out of seenSet until a batch actually
  // succeeds, so a failed call leaves them retryable on the next run.
  const queued     = new Set();

  // Registries first. These are free, cover the whole continent, and are the
  // only sources that can be filtered by status and disclosure date.
  console.log('Querying multilateral registries…');
  const mdb = [...await fetchWorldBankPipeline(), ...await fetchWorldBankDocs()];
  for (const item of mdb) {
    if (!item.url || seenSet.has(item.url) || queued.has(item.url)) continue;
    queued.add(item.url);
    freshUrls.push(item.url);
    candidates.push({ ...item, snippet: String(item.snippet).slice(0, 400) });
  }
  console.log(`  ${candidates.length} registry candidates after dedup\n`);

  for (const country of MARKETS) {
    if (budgetLeft() <= 0) { console.log('Budget cap reached — stopping search.'); break; }
    console.log(`Searching ${country}…`);

    for (const template of QUERIES) {
      if (budgetLeft() <= 0) break;
      const results = await braveSearch(template.replace('{country}', country));

      for (const item of results) {
        const url = item.url;
        if (!url || seenSet.has(url) || queued.has(url)) continue;
        freshUrls.push(url);

        const title   = item.title || '';
        const snippet = item.description || '';
        const haystack = `${title} ${snippet} ${url}`.toLowerCase();

        // Cheap keyword gate before we pay the model for anything. A reject
        // here is a completed evaluation, so it is safe to mark seen.
        if (!PROCUREMENT_HINTS.some(h => haystack.includes(h))) { seenSet.add(url); continue; }

        queued.add(url);
        candidates.push({ title, url, snippet: snippet.slice(0, 400), country });
      }
      await new Promise(r => setTimeout(r, 300));  // be polite to Brave
    }
  }

  // Multilateral pipeline sweep — Africa-wide, run once rather than per market.
  console.log('\nSweeping World Bank / AfDB pipeline…');
  for (const q of PIPELINE_QUERIES) {
    if (budgetLeft() <= 0) { console.log('Budget cap reached — stopping pipeline sweep.'); break; }
    const results = await braveSearch(q);
    for (const item of results) {
      const url = item.url;
      if (!url || seenSet.has(url) || queued.has(url)) continue;
      freshUrls.push(url);
      const title   = item.title || '';
      const snippet = item.description || '';
      const haystack = `${title} ${snippet} ${url}`.toLowerCase();
      // Concept-stage paperwork rarely uses tender vocabulary, so the
      // procurement gate would reject it. Gate on pipeline vocabulary instead.
      if (!PIPELINE_HINTS.some(k => haystack.includes(k))) { seenSet.add(url); continue; }
      queued.add(url);
      candidates.push({ title, url, snippet: snippet.slice(0, 400), country: PIPELINE_SCOPE });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n${freshUrls.length} new URLs, ${candidates.length} passed the procurement filter.\n`);

  const hits = [];
  let failedBatches = 0;
  const byCountry = {};
  for (const c of candidates) (byCountry[c.country] ??= []).push(c);

  for (const [country, list] of Object.entries(byCountry)) {
    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      if (budgetLeft() <= 0) { console.log('Budget cap reached — stopping scoring.'); break; }
      const batch = list.slice(i, i + BATCH_SIZE).map((c, idx) => ({ ...c, _idx: idx }));
      const label = country === PIPELINE_SCOPE ? 'World Bank / AfDB pipeline' : country;
      const scored = await scoreBatch(batch, label);
      if (scored === null) {
        // The call failed. Leave every URL in this batch unmarked so the
        // next run retries it. Run #6 burned 55 World Bank pipeline
        // projects by marking them seen before scoring, then losing them
        // to a truncated response — they were never retried.
        failedBatches++;
        continue;
      }
      // The call succeeded, so these are evaluated whatever the scores.
      for (const c of batch) seenSet.add(c.url);
      // Re-home each hit to the country its document actually names, rather
      // than whichever search happened to surface it.
      hits.push(...scored
        .filter(s => (s.score ?? 0) >= SCORE_THRESHOLD)
        .map(s => ({ ...s, country: resolveCountry(s, country) })));
    }
  }

  const dropped = { expired: 0, stale: 0, duplicate: 0 };

  const live = hits.filter(h => {
    if (isExpired(h.deadline)) { dropped.expired++; return false; }
    if (isStale(h))            { dropped.stale++;   return false; }
    return true;
  });

  const beforeDedupe = live.length;
  let final = dedupeByProject(live);
  dropped.duplicate = beforeDedupe - final.length;

  final.sort(compareHits);

  const atDesign = final.filter(h => h.stage === 'design-tender' || h.stage === 'design-underway').length;
  console.log(`${hits.length} scored at or above ${SCORE_THRESHOLD}.`);
  console.log(`  dropped ${dropped.expired} expired, ${dropped.stale} stale, ${dropped.duplicate} duplicate → ${final.length} reported`);
  console.log(`  of which ${atDesign} are at design stage (spec still open)`);
  if (failedBatches) console.log(`  ${failedBatches} batch(es) failed — their URLs stay retryable next run`);
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
