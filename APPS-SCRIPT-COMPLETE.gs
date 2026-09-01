/**
 * ============================================================================
 * CABLE CONCRETE® LEAD CAPTURE — Code.gs  (COMPLETE REPLACEMENT)
 * ============================================================================
 *
 * Replaces Code.gs ONLY. Prospector.gs and Autoresponder.gs are untouched —
 * nothing here calls them and nothing here defines a name they use.
 *
 * PRESERVED exactly as before:
 *   • SHEET_NAME "Sheet1" and its 16-column lead row order
 *   • NOTIFY_EMAIL contact@iecsafrica.com for lead alerts
 *   • Installs tab and its Platform/Method/Display column order
 *   • Lead notification email wording
 *   • Engineer autoresponder wording and signature
 *   • testSetup() and testInstall()
 *
 * ADDED:
 *   • error_log events  -> Errors tab + throttled alert to ALERT_EMAIL
 *   • runHealthCheck()  -> 10-minute uptime probe, alerts on failure
 *   • Blank-lead guard  -> junk submissions logged but never emailed
 *
 * FIXED:
 *   • Autoresponder had a markdown link pasted into a plain-text email, so
 *     engineers were literally receiving:
 *       Web: [www.cableconcrete.app](https://www.cableconcrete.app)
 *     Now reads: Web: www.cableconcrete.app
 *   • Lead subject line printed "undefined" when name/country were missing.
 * ============================================================================
 */

var SHEET_NAME   = "Sheet1";
var NOTIFY_EMAIL = "contact@iecsafrica.com";        // leads — sales inbox
var ALERT_EMAIL  = "nnamdieguh@iecsafrica.com";     // errors + uptime — technical
var SITE_URL     = "https://www.cableconcrete.app";


function doGet(e) {
  return handleRequest(e.parameter);
}

function doPost(e) {
  var data = {};
  try {
    if (e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    } else if (e.parameter) {
      data = e.parameter;
    }
  } catch(err) {
    data = e.parameter || {};
  }
  return handleRequest(data);
}

function handleRequest(data) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // ── APP INSTALL EVENTS ──────────────────────────────────────────────
    // Logged to a separate "Installs" tab. No emails, no lead rows.
    if (data.event === "app_install") {
      var ish = ss.getSheetByName("Installs");
      if (!ish) {
        ish = ss.insertSheet("Installs");
        ish.appendRow(["Timestamp", "Platform", "Method", "Display", "User Agent"]);
      }
      ish.appendRow([
        new Date().toLocaleString(),
        data.platform || "",
        data.method || "",
        data.display || "",
        data.ua || ""
      ]);
      return ContentService
        .createTextOutput(JSON.stringify({status:"success", logged:"install"}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── ERROR REPORTS ───────────────────────────────────────────────────
    // The app filters third-party noise (Vercel Analytics, browser
    // extensions) before sending, so anything arriving here is our own
    // code. Logged to an "Errors" tab; emailed at most once per unique
    // message per day so a repeating bug can't flood the inbox.
    if (data.event === "error_log") {
      var esh = ss.getSheetByName("Errors");
      if (!esh) {
        esh = ss.insertSheet("Errors");
        esh.appendRow(["Timestamp","Type","Message","Source","Line","Col","Page","User Agent","Stack"]);
        esh.setFrozenRows(1);
      }
      esh.appendRow([
        new Date().toLocaleString(),
        data.type || "",
        data.message || "",
        data.source || "",
        data.line || "",
        data.col || "",
        data.page || "",
        data.ua || "",
        data.stack || ""
      ]);

      if (throttle_("err_" + hash_(String(data.message || "").slice(0,120)), 24*60*60*1000)) {
        GmailApp.sendEmail(ALERT_EMAIL,
          "[Cable Concrete] App error: " + String(data.message || "").slice(0,70),
          "A JavaScript error fired in the Cable Concrete app.\n\n" +
          "Type:    " + (data.type || "") + "\n" +
          "Message: " + (data.message || "") + "\n" +
          "Page:    " + (data.page || "") + "\n" +
          "Source:  " + (data.source || "") + ":" + (data.line || "") + "\n" +
          "Device:  " + (data.ua || "") + "\n\n" +
          "Stack:\n" + (data.stack || "(none)") + "\n\n" +
          "============================\n" +
          "One email per unique error per day.\n" +
          "Full log: https://docs.google.com/spreadsheets/d/" + ss.getId(),
          { name: "Cable Concrete Monitor" });
      }

      return ContentService
        .createTextOutput(JSON.stringify({status:"success", logged:"error"}))
        .setMimeType(ContentService.MimeType.JSON);
    }
    // ────────────────────────────────────────────────────────────────────

    var sheet = ss.getSheetByName(SHEET_NAME);

    if (!sheet) {
      GmailApp.sendEmail(NOTIFY_EMAIL,
        "ERROR - Cable Concrete Sheet Not Found",
        "Sheet named '" + SHEET_NAME + "' was not found. Lead data lost:\n\n" + JSON.stringify(data)
      );
      return ContentService
        .createTextOutput(JSON.stringify({status:"error",message:"Sheet not found"}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    sheet.appendRow([
      new Date().toLocaleString(),
      data.name || "",
      data.firm || "",
      data.email || "",
      data.phone || "",
      data.country || "",
      data.priority || "Standard",
      data.scope || "",
      data.source || "Not specified",
      data.block || "",
      data.velocity || "",
      data.shear || "",
      data.mat_size || "",
      data.block_height || "",
      data.cable_spec || "",
      data.terms || ""
    ]);

    // ── BLANK-LEAD GUARD ────────────────────────────────────────────────
    // A submission carrying neither a name nor an email is junk — a
    // crawler, a probe, or a stray request. The row above keeps it
    // auditable, but no email goes out. This is what produced the blank
    // lead alerts with a script URL sitting in the Source column.
    if (!String(data.name || "").trim() && !String(data.email || "").trim()) {
      return ContentService
        .createTextOutput(JSON.stringify({status:"success", logged:"blank-ignored"}))
        .setMimeType(ContentService.MimeType.JSON);
    }
    // ────────────────────────────────────────────────────────────────────

    var isPriority = (data.priority || "").indexOf("PRIORITY") > -1;
    var subject = (isPriority ? "*** PRIORITY LEAD ***" : "New Lead") +
      " - Cable Concrete | " + (data.name || "Unknown") + " | " + (data.country || "Unknown");

    var body =
      "============================\n" +
      "NEW CABLE CONCRETE LEAD\n" +
      "============================\n\n" +
      "CONTACT DETAILS\n" +
      "----------------\n" +
      "Name: " + (data.name || "") + "\n" +
      "Firm: " + (data.firm || "") + "\n" +
      "Email: " + (data.email || "") + "\n" +
      "Phone: " + (data.phone || "") + "\n" +
      "Country: " + (data.country || "") + "\n" +
      "Priority: " + (data.priority || "Standard") + "\n" +
      "Source: " + (data.source || "Not specified") + "\n\n" +
      "PROJECT SCOPE\n" +
      "----------------\n" +
      (data.scope || "") + "\n\n" +
      "RECOMMENDED BLOCK\n" +
      "----------------\n" +
      "Block: " + (data.block || "") + "\n" +
      "Max Velocity: " + (data.velocity || "") + "\n" +
      "Shear Resistance: " + (data.shear || "") + "\n" +
      "Mat Size: " + (data.mat_size || "") + "\n" +
      "Block Height: " + (data.block_height || "") + "\n" +
      "Cable Spec: " + (data.cable_spec || "") + "\n\n" +
      "Terms Status: " + (data.terms || "") + "\n" +
      "Submitted: " + new Date().toLocaleString() + "\n\n" +
      "============================\n" +
      "Reply to this email to contact the engineer directly.\n" +
      "View full leads sheet:\n" +
      "https://docs.google.com/spreadsheets/d/" +
      ss.getId() + "\n" +
      "============================";

    GmailApp.sendEmail(NOTIFY_EMAIL, subject, body, {
      replyTo: data.email || "",
      name: "Cable Concrete App"
    });

    if (data.email && data.email.indexOf("@") > -1 && data.email !== NOTIFY_EMAIL) {
      var engineerSubject = "Your Cable Concrete Block Selection - IECS Africa";
      var engineerBody =
        "Dear " + (data.name || "Engineer") + ",\n\n" +
        "Thank you for using the Cable Concrete Block Selection Tool.\n\n" +
        "Your project has been received by IECS Africa.\n" +
        "We will contact you shortly with a formal quote.\n\n" +
        "============================\n" +
        "YOUR RECOMMENDATION\n" +
        "============================\n" +
        "Block: " + (data.block || "") + "\n" +
        "Max Velocity: " + (data.velocity || "") + "\n" +
        "Shear Resistance: " + (data.shear || "") + "\n" +
        "Mat Size: " + (data.mat_size || "") + "\n" +
        "Block Height: " + (data.block_height || "") + "\n" +
        "Cable Spec: " + (data.cable_spec || "") + "\n\n" +
        "PROJECT: " + (data.scope || "") + "\n\n" +
        "============================\n" +
        "NEXT STEPS\n" +
        "============================\n" +
        "IECS Africa will contact you with:\n" +
        "- Formal block supply quotation\n" +
        "- Installation services proposal\n" +
        "- Site visit arrangement where applicable\n\n" +
        "For urgent enquiries:\n" +
        "Email: contact@iecsafrica.com\n" +
        "Phone: +234 809 464 4407\n" +
        "Web: www.cableconcrete.app\n\n" +
        "Best regards,\n" +
        "Nnamdi Eguh\n" +
        "VP Africa, IECS Global Inc. Canada\n" +
        "IECS Africa - Subsidiary of IECS Global Inc. Canada";

      GmailApp.sendEmail(data.email, engineerSubject, engineerBody, {
        replyTo: NOTIFY_EMAIL,
        name: "IECS Africa"
      });
    }

    return ContentService
      .createTextOutput(JSON.stringify({status:"success"}))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({status:"error",message:err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ── HEALTH CHECK ────────────────────────────────────────────────────────────
// Add a time-driven trigger on this function (every 10 minutes — see SETUP).
// Probes the live site's /api/health endpoint, which checks the version API,
// the engineering-data API, the manifest and the CSU test-report PDF.
// Emails ALERT_EMAIL on failure, at most once an hour so an outage doesn't
// bury you in mail.
function runHealthCheck() {
  var status, bodyText;
  try {
    var resp = UrlFetchApp.fetch(SITE_URL + "/api/health", {
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
    bodyText = "Request threw: " + err.toString();
  }

  if (!throttle_("health_alert", 60*60*1000)) return;

  GmailApp.sendEmail(ALERT_EMAIL,
    "[Cable Concrete] SITE HEALTH CHECK FAILED (HTTP " + status + ")",
    "The 10-minute health probe against " + SITE_URL + " failed.\n\n" +
    "HTTP status: " + status + "\n\n" +
    "Response:\n" + bodyText + "\n\n" +
    "============================\n" +
    "No further alerts for this issue for 1 hour.\n" +
    "Check: " + SITE_URL,
    { name: "Cable Concrete Monitor" });
}


// ── HELPERS ─────────────────────────────────────────────────────────────────

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
    .map(function(b){ return ("0" + (b < 0 ? b + 256 : b).toString(16)).slice(-2); })
    .join("")
    .slice(0, 16);
}


// ── TESTS ───────────────────────────────────────────────────────────────────

function testSetup() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (sheet) {
    Logger.log("Sheet found: " + sheet.getName());
    handleRequest({
      name: "Test Engineer Nnamdi",
      firm: "IECS Africa Test",
      email: "nnamdieguh@iecsafrica.com",
      phone: "+234 809 464 4407",
      country: "Nigeria",
      priority: "PRIORITY - 24hr Response",
      scope: "2.4km gully erosion control, Anambra State - 4.5m channel, 3:1 slope",
      source: "Google Search",
      block: "CC 45 - Steep Slopes & High Velocity",
      velocity: "6.1 m/s (good) / 3.5 (poor)",
      shear: "390 N/m2",
      mat_size: "2.44m x 4.88m",
      block_height: "140-152 mm (5.5 inch)",
      cable_spec: "SS 1x19 5/32 inch / 4mm",
      terms: "Test submission"
    });
    Logger.log("Done - check sheet and email.");
  } else {
    Logger.log("Sheet NOT found. Check SHEET_NAME = " + SHEET_NAME);
    Logger.log("Available sheets:");
    var sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
    for (var i = 0; i < sheets.length; i++) {
      Logger.log(" - " + sheets[i].getName());
    }
  }
}

function testInstall() {
  handleRequest({ event: "app_install", platform: "Android", method: "test", display: "standalone", ua: "test run" });
  Logger.log('Done - check for an "Installs" tab with a test row.');
}

/** Logs a test error and emails ALERT_EMAIL. Creates the Errors tab. */
function testError() {
  handleRequest({
    event: "error_log",
    type: "js-error",
    message: "Script self-test error " + new Date().getTime(),
    source: SITE_URL + "/index.html",
    line: "1", col: "1",
    page: "/",
    ua: "testError",
    stack: "(self-test)"
  });
  Logger.log('Done - check for an "Errors" tab and an email to ' + ALERT_EMAIL);
}

/** Probes the live site. Silent if healthy; emails if something is down. */
function testHealth() {
  runHealthCheck();
  Logger.log("Health check ran. Silence means the site is healthy.");
}

/** Blank-lead guard check — logs a row to Sheet1 but sends NO email. */
function testBlankLeadIgnored() {
  handleRequest({ source: SITE_URL + "/_vercel/insights/script.js" });
  Logger.log("Blank lead logged to Sheet1 with no email sent. Check the last row.");
}


// ── SETUP ───────────────────────────────────────────────────────────────────
/**
 *  1. Save (disk icon).
 *
 *  2. Redeploy so the live app talks to this version:
 *       Deploy > Manage deployments > pencil icon >
 *       Version: "New version" > Deploy
 *     Use MANAGE deployments, not "New deployment" — a new deployment
 *     issues a different URL and the app would stop reaching you.
 *
 *  3. Add the health-check trigger:
 *       Triggers (clock icon, left sidebar) > + Add Trigger
 *         Function:      runHealthCheck
 *         Event source:  Time-driven
 *         Type:          Minutes timer
 *         Interval:      Every 10 minutes
 *       Save, then accept the authorisation prompts.
 *
 *  4. Verify — run each from the toolbar dropdown:
 *       testSetup             lead row + both emails
 *       testInstall           Installs tab row
 *       testError             Errors tab row + alert email
 *       testHealth            silent if the site is up
 *       testBlankLeadIgnored  row in Sheet1, no email
 */
