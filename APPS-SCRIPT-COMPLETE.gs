/**
 * ============================================================================
 * CABLE CONCRETE® — COMPLETE APPS SCRIPT
 * ============================================================================
 *
 * This is the WHOLE script. Select all in the Apps Script editor, delete,
 * paste this in its place, Save. Then add one trigger (see SETUP at bottom).
 *
 * Handles all three things the app sends:
 *   1. Leads          — contact form submissions  -> Leads sheet  + email
 *   2. App installs    — PWA added to home screen  -> Installs sheet
 *   3. Error reports   — JS errors in a browser    -> Errors sheet + email
 *
 * Plus a health check that polls the live site every 10 minutes and emails
 * if anything is down.
 *
 * The app calls this over GET with no-cors, so doGet is the real entry point.
 * doPost is wired to the same router in case the transport ever changes.
 * ============================================================================
 */

// ── CONFIG — change these if anything moves ─────────────────────────────────
var ALERT_EMAIL   = 'nnamdieguh@iecsafrica.com';
var SHEET_ID      = '1Y_ivVEZ1v3JtKQlMEUElRCX9SwQubvfIvBrkhoskCpE';
var SITE_URL      = 'https://www.cableconcrete.app';

var LEADS_TAB     = 'Leads';
var INSTALLS_TAB  = 'Installs';
var ERRORS_TAB    = 'Errors';

// Priority markets get flagged in the subject line.
var PRIORITY_MARKETS = ['Nigeria','Ghana','Kenya','Tanzania','Ethiopia','Uganda','Zambia','Mozambique'];


// ── ROUTER ──────────────────────────────────────────────────────────────────
function doGet(e)  { return route_(e); }
function doPost(e) { return route_(e); }

function route_(e) {
  try {
    var p = (e && e.parameter) ? e.parameter : {};

    if (p.event === 'error_log')   { handleErrorLog_(p);   return ok_('error logged'); }
    if (p.event === 'app_install') { handleAppInstall_(p); return ok_('install logged'); }

    // Anything else is a lead from the contact form.
    handleLead_(p);
    return ok_('lead received');

  } catch (err) {
    // Never throw back at the browser — log it and move on.
    try {
      MailApp.sendEmail({
        to: ALERT_EMAIL,
        subject: '[Cable Concrete] Apps Script error',
        body: 'The script threw while handling a request.\n\n' + err.toString() +
              '\n\nStack:\n' + (err.stack || '(none)')
      });
    } catch (e2) {}
    return ok_('error');
  }
}

function ok_(msg) {
  return ContentService.createTextOutput(msg).setMimeType(ContentService.MimeType.TEXT);
}


// ── LEADS ───────────────────────────────────────────────────────────────────
function handleLead_(p) {
  var headers = ['Timestamp','Name','Firm','Email','Phone','Country','Priority',
                 'Project Scope','Source','Block','Max Velocity','Shear Resistance',
                 'Mat Size','Block Height','Cable Spec','Terms Status'];

  var row = {
    'Timestamp'        : new Date(),
    'Name'             : p.name || '',
    'Firm'             : p.firm || '',
    'Email'            : p.email || '',
    'Phone'            : p.phone || '',
    'Country'          : p.country || '',
    'Priority'         : p.priority || 'Standard',
    'Project Scope'    : p.scope || '',
    'Source'           : p.source || '',
    'Block'            : p.block || '',
    'Max Velocity'     : p.velocity || '',
    'Shear Resistance' : p.shear || '',
    'Mat Size'         : p.mat_size || '',
    'Block Height'     : p.block_height || '',
    'Cable Spec'       : p.cable_spec || '',
    'Terms Status'     : p.terms || ''
  };

  appendMapped_(LEADS_TAB, headers, row);

  // Guard: a "lead" with neither a name nor an email is junk — a crawler, a
  // probe, or a stray request. Log it (above) so it's auditable, but don't
  // email. This is what produced the blank lead alerts.
  if (!String(p.name || '').trim() && !String(p.email || '').trim()) return;

  var isPriority = PRIORITY_MARKETS.indexOf(p.country || '') !== -1;
  var subject = (isPriority ? '[PRIORITY] ' : '') +
                'New Cable Concrete lead — ' + (p.name || 'Unknown') +
                (p.country ? ' (' + p.country + ')' : '');

  var body =
    '==============================\n' +
    'NEW CABLE CONCRETE LEAD\n' +
    '==============================\n\n' +
    'CONTACT DETAILS\n' +
    '---------------\n' +
    'Name:     ' + (p.name || '') + '\n' +
    'Firm:     ' + (p.firm || '') + '\n' +
    'Email:    ' + (p.email || '') + '\n' +
    'Phone:    ' + (p.phone || '') + '\n' +
    'Country:  ' + (p.country || '') + '\n' +
    'Priority: ' + (p.priority || 'Standard') + '\n' +
    'Source:   ' + (p.source || 'Not specified') + '\n\n' +
    'PROJECT SCOPE\n' +
    '---------------\n' +
    (p.scope || '(not provided)') + '\n\n' +
    'RECOMMENDED BLOCK\n' +
    '---------------\n' +
    'Block:            ' + (p.block || '') + '\n' +
    'Max Velocity:     ' + (p.velocity || '') + '\n' +
    'Shear Resistance: ' + (p.shear || '') + '\n' +
    'Mat Size:         ' + (p.mat_size || '') + '\n' +
    'Block Height:     ' + (p.block_height || '') + '\n' +
    'Cable Spec:       ' + (p.cable_spec || '') + '\n\n' +
    'Terms Status: ' + (p.terms || '') + '\n' +
    'Submitted:    ' + (p.submitted || new Date().toLocaleString()) + '\n\n' +
    '==============================\n' +
    'Reply to this email to contact the engineer directly.\n' +
    'View full leads sheet:\n' +
    'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '\n' +
    '==============================';

  var opts = { to: ALERT_EMAIL, subject: subject, body: body };
  if (String(p.email || '').indexOf('@') !== -1) opts.replyTo = p.email;
  MailApp.sendEmail(opts);
}


// ── APP INSTALLS ────────────────────────────────────────────────────────────
// Logged only — no email. Check the Installs tab whenever you want the count.
function handleAppInstall_(p) {
  appendMapped_(INSTALLS_TAB,
    ['Timestamp','Method','Platform','Display Mode','User Agent'],
    {
      'Timestamp'    : new Date(),
      'Method'       : p.method || '',
      'Platform'     : p.platform || '',
      'Display Mode' : p.display || '',
      'User Agent'   : p.ua || ''
    });
}


// ── ERROR REPORTS ───────────────────────────────────────────────────────────
// The app already filters out third-party noise (Vercel Analytics, browser
// extensions) before sending, so anything arriving here is our own code.
// Emails at most once per day per unique message so a repeated bug can't
// flood the inbox.
function handleErrorLog_(p) {
  appendMapped_(ERRORS_TAB,
    ['Timestamp','Type','Message','Source','Line','Col','Page','User Agent','Stack'],
    {
      'Timestamp'  : new Date(),
      'Type'       : p.type || '',
      'Message'    : p.message || '',
      'Source'     : p.source || '',
      'Line'       : p.line || '',
      'Col'        : p.col || '',
      'Page'       : p.page || '',
      'User Agent' : p.ua || '',
      'Stack'      : p.stack || ''
    });

  if (!throttle_('err_' + hash_(String(p.message || '').slice(0, 120)), 24 * 60 * 60 * 1000)) return;

  MailApp.sendEmail({
    to: ALERT_EMAIL,
    subject: '[Cable Concrete] App error: ' + String(p.message || '').slice(0, 70),
    body:
      'A JavaScript error fired in the Cable Concrete app.\n\n' +
      'Type:    ' + (p.type || '') + '\n' +
      'Message: ' + (p.message || '') + '\n' +
      'Page:    ' + (p.page || '') + '\n' +
      'Source:  ' + (p.source || '') + ':' + (p.line || '') + '\n' +
      'Device:  ' + (p.ua || '') + '\n\n' +
      'Stack:\n' + (p.stack || '(none)') + '\n\n' +
      '------------------------------\n' +
      'You get one email per unique error per day.\n' +
      'Full log: https://docs.google.com/spreadsheets/d/' + SHEET_ID
  });
}


// ── HEALTH CHECK ────────────────────────────────────────────────────────────
// Runs on a 10-minute trigger. Emails if the site or any API is down, at most
// once an hour so an outage doesn't spam you.
function runHealthCheck() {
  var status, bodyText;
  try {
    var resp = UrlFetchApp.fetch(SITE_URL + '/api/health', {
      muteHttpExceptions: true,
      followRedirects: true
    });
    status   = resp.getResponseCode();
    bodyText = resp.getContentText();

    if (status === 200) {
      var parsed = JSON.parse(bodyText);
      if (parsed.ok) return;   // healthy — nothing to do
    }
  } catch (err) {
    status   = 0;
    bodyText = 'Request threw: ' + err.toString();
  }

  if (!throttle_('health_alert', 60 * 60 * 1000)) return;

  MailApp.sendEmail({
    to: ALERT_EMAIL,
    subject: '[Cable Concrete] SITE HEALTH CHECK FAILED (HTTP ' + status + ')',
    body:
      'The 10-minute health probe against ' + SITE_URL + ' failed.\n\n' +
      'HTTP status: ' + status + '\n\n' +
      'Response:\n' + bodyText + '\n\n' +
      '------------------------------\n' +
      'No further alerts for this issue for 1 hour.\n' +
      'Check: ' + SITE_URL
  });
}


// ── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Appends a row to a tab, matching whatever column order that tab already
 * uses. If the tab is new or empty the supplied headers are written first.
 * This means it works with your existing Leads sheet without reordering
 * anything, and creates the Installs / Errors tabs automatically.
 */
function appendMapped_(tabName, defaultHeaders, dataObj) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(tabName);

  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.appendRow(defaultHeaders);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, defaultHeaders.length).setFontWeight('bold');
  }

  var lastCol = sheet.getLastColumn();
  var headers = (sheet.getLastRow() === 0 || lastCol === 0)
    ? null
    : sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  if (!headers || headers.join('').trim() === '') {
    sheet.getRange(1, 1, 1, defaultHeaders.length).setValues([defaultHeaders]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, defaultHeaders.length).setFontWeight('bold');
    headers = defaultHeaders;
  }

  // Map our data onto the sheet's actual column order.
  var row = headers.map(function (h) {
    var key = String(h).trim();
    return dataObj.hasOwnProperty(key) ? dataObj[key] : '';
  });

  // Any field the sheet has no column for gets appended on the end so
  // nothing is silently dropped.
  Object.keys(dataObj).forEach(function (k) {
    var found = headers.some(function (h) { return String(h).trim() === k; });
    if (!found && dataObj[k] !== '' && dataObj[k] !== null) {
      row.push(k + ': ' + dataObj[k]);
    }
  });

  sheet.appendRow(row);
}

/** Returns true if enough time has passed since this key last fired. */
function throttle_(key, windowMs) {
  var props = PropertiesService.getScriptProperties();
  var last  = Number(props.getProperty(key) || 0);
  var now   = Date.now();
  if (now - last < windowMs) return false;
  props.setProperty(key, String(now));
  return true;
}

/** Short stable hash so repeated errors share one throttle key. */
function hash_(str) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, str)
    .map(function (b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); })
    .join('')
    .slice(0, 16);
}


// ── SETUP & TESTING ─────────────────────────────────────────────────────────
/**
 * SETUP — do this once after pasting:
 *
 *  1. Save (disk icon).
 *
 *  2. Redeploy so the app talks to this version:
 *       Deploy > Manage deployments > pencil icon >
 *       Version: "New version" > Deploy
 *     (Do NOT create a brand new deployment — that changes the URL and the
 *      app would stop reaching you.)
 *
 *  3. Add the health-check trigger:
 *       Triggers (clock icon, left sidebar) > + Add Trigger
 *         Function:      runHealthCheck
 *         Event source:  Time-driven
 *         Type:          Minutes timer
 *         Interval:      Every 10 minutes
 *       Save, and accept the authorisation prompts.
 *
 *  4. Run testAll_ once from the editor to confirm everything works.
 */

/** Select testAll_ in the toolbar dropdown and press Run. */
function testAll_() {
  handleLead_({
    name: 'Test Engineer', firm: 'Test Firm', email: ALERT_EMAIL,
    phone: '+234 800 000 0000', country: 'Nigeria',
    priority: 'PRIORITY — 24hr Response',
    scope: 'Script self-test — safe to ignore.',
    source: 'testAll_', block: 'CC 45 — Steep Slopes & High Velocity',
    velocity: '6.1 m/s (good)', shear: '390 N/m²', mat_size: '2.44m × 4.88m',
    block_height: '140–152 mm', cable_spec: 'SS 1x19 5/32"', terms: 'Test'
  });

  handleAppInstall_({ method: 'test', platform: 'Test', display: 'standalone', ua: 'testAll_' });

  handleErrorLog_({
    type: 'js-error', message: 'Script self-test error ' + Date.now(),
    source: SITE_URL + '/index.html', line: '1', col: '1',
    page: '/', ua: 'testAll_', stack: '(self-test)'
  });

  runHealthCheck();

  Logger.log('testAll_ finished. Check the Leads / Installs / Errors tabs and your inbox.');
}

/** Blank-lead guard check — should log a row but send NO email. */
function testBlankLeadIgnored_() {
  handleLead_({ source: SITE_URL + '/_vercel/insights/script.js' });
  Logger.log('Blank lead logged to the sheet with no email sent.');
}
