# Monitoring setup — Apps Script side

This is the one-time setup you do in your Google Apps Script after the
frontend changes ship. ~10 minutes total.

The frontend already captures every uncaught JS error and unhandled
promise rejection in the engineer's browser and POSTs it to the same
Apps Script web app (`AKfycbz...JxkBdSXu4P...`) that handles your leads.

You need to:
1. Extend the Apps Script `doPost` to handle `event=error_log`.
2. Add a time-driven trigger that polls `/api/health` every 10 minutes
   and emails you if it fails.

---

## Step 1 — open the Apps Script

1. Open `script.google.com`.
2. Open the project that owns the URL ending in `.../AKfycbz...JxkBdSXu4P...`.
3. You should see the existing `doPost(e)` function that handles leads.

## Step 2 — paste these three functions into the project

Paste them anywhere in the file. Don't delete anything existing.

```javascript
// ── ERROR LOG INTAKE ──────────────────────────────────────────────────────
// Called from the browser whenever a JS error fires. Appends to the
// "Errors" sheet and emails you on the first occurrence per day per
// unique error message.
function handleErrorLog_(params) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Errors') || ss.insertSheet('Errors');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Timestamp','Type','Message','Source','Line','Page','User Agent','Stack']);
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([
    new Date(),
    params.type || '',
    params.message || '',
    params.source || '',
    params.line || '',
    params.page || '',
    params.ua || '',
    params.stack || ''
  ]);

  // Email on first occurrence today per unique message
  var props = PropertiesService.getScriptProperties();
  var msgKey = 'err_' + Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    String(params.message || '').slice(0,120)
  ).map(function(b){return ('0'+(b<0?b+256:b).toString(16)).slice(-2);}).join('');
  var last = props.getProperty(msgKey);
  var now = Date.now();
  if (!last || now - Number(last) > 24*60*60*1000) {
    props.setProperty(msgKey, String(now));
    MailApp.sendEmail({
      to: 'nnamdieguh@iecsafrica.com',
      subject: '[Cable Concrete] Error: ' + String(params.message || '').slice(0,80),
      body:
        'A JavaScript error fired on cableconcrete.app.\n\n' +
        'Type:     ' + (params.type || '') + '\n' +
        'Message:  ' + (params.message || '') + '\n' +
        'Page:     ' + (params.page || '') + '\n' +
        'Source:   ' + (params.source || '') + ':' + (params.line || '') + '\n' +
        'UA:       ' + (params.ua || '') + '\n\n' +
        'Stack:\n' + (params.stack || '(none)') + '\n\n' +
        '— You only get one email per unique error per day.'
    });
  }
}

// ── HEALTH CHECK PING ─────────────────────────────────────────────────────
// Set up as a 10-minute time-driven trigger (see Step 3 below). Fetches
// /api/health on cableconcrete.app and emails you if anything is down.
function runHealthCheck() {
  try {
    var resp = UrlFetchApp.fetch('https://www.cableconcrete.app/api/health', {
      muteHttpExceptions: true,
      followRedirects: true
    });
    var code = resp.getResponseCode();
    var text = resp.getContentText();
    if (code === 200) {
      var body = JSON.parse(text);
      if (body.ok) return; // healthy, no action
    }
    // Failure path — email, but no more than once per hour for the same status
    var props = PropertiesService.getScriptProperties();
    var lastAlert = Number(props.getProperty('last_health_alert') || 0);
    if (Date.now() - lastAlert < 60*60*1000) return;
    props.setProperty('last_health_alert', String(Date.now()));
    MailApp.sendEmail({
      to: 'nnamdieguh@iecsafrica.com',
      subject: '[Cable Concrete] Health check FAILED (HTTP ' + code + ')',
      body: 'cableconcrete.app failed the 10-minute health probe.\n\n' +
            'HTTP status: ' + code + '\n\n' +
            'Response:\n' + text + '\n\n' +
            '— No more alerts on this issue for 1 hour.'
    });
  } catch (e) {
    MailApp.sendEmail({
      to: 'nnamdieguh@iecsafrica.com',
      subject: '[Cable Concrete] Health check threw an error',
      body: 'Exception while running the health probe:\n\n' + e.toString()
    });
  }
}
```

## Step 3 — hook `handleErrorLog_` into `doPost`

Find your existing `doPost(e)` function. At the top of its body, just
before whatever block handles leads, add this dispatch:

```javascript
function doPost(e) {
  var params = e.parameter || {};

  // NEW — error monitoring
  if (params.event === 'error_log') {
    handleErrorLog_(params);
    return ContentService.createTextOutput('OK');
  }

  // ... your existing lead-handling code stays exactly as-is below this
}
```

If your code currently uses `doGet(e)` instead (which it does — the
frontend uses GET with `mode:'no-cors'`), put the same `if` block at
the top of `doGet` instead.

## Step 4 — install the 10-minute trigger for `runHealthCheck`

1. In the Apps Script editor sidebar, click the **⏰ Triggers** icon.
2. Click **+ Add Trigger** (bottom right).
3. Function: **`runHealthCheck`**.
4. Event source: **Time-driven**.
5. Type: **Minutes timer**.
6. Interval: **Every 10 minutes**.
7. Save. You'll be prompted to authorise the trigger to fetch external
   URLs and to send email — accept both.

You're done. From this point on:
- Any uncaught browser error → row in the Errors sheet + email (once per
  day per unique message).
- Any health failure → email within 10 minutes (no more than once per
  hour for the same incident).
- All visible from your existing spreadsheet — no new tools, no
  subscriptions.

## Verifying it's working

Open `cableconcrete.app` in your browser, open DevTools console, paste:

```javascript
throw new Error('Monitoring smoke test ' + Date.now());
```

Within ~10 seconds you should see a row in the Errors sheet and an
email titled `[Cable Concrete] Error: Monitoring smoke test ...`.

For the health check, you can run `runHealthCheck` manually once from
the Apps Script editor (with the Run button) — should complete silently
because the site is up.
