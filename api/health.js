// Internal health-check endpoint. Polled by a time-driven Apps Script
// trigger every 10 minutes — when any of the four sub-checks below
// fails, the Apps Script side sends an email to
// nnamdieguh@iecsafrica.com. No third-party uptime service required.

const ORIGIN = 'https://www.cableconcrete.app';

// No probe may outlive this. Without it a single unresponsive upstream holds
// the whole handler open until the platform kills it, and the Apps Script
// trigger waiting on the other end dies with it — before it reaches the line
// that would have emailed the alert. A monitor that can hang is a monitor that
// fails silently, which is worse than no monitor at all.
const PROBE_TIMEOUT_MS = 5000;

async function probe(name, url, init) {
  const start = Date.now();
  try {
    const r = await fetch(url, Object.assign({
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    }, init || {}));
    const ms = Date.now() - start;
    return { name, ok: r.ok, status: r.status, ms };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return {
      name,
      ok: false,
      error: timedOut
        ? `no response within ${PROBE_TIMEOUT_MS} ms`
        : (e && e.message) || String(e),
      ms: Date.now() - start
    };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  const checks = await Promise.all([
    probe('version', ORIGIN + '/api/version', { cache: 'no-store' }),
    probe('engineering-data', ORIGIN + '/api/engineering-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }),
    probe('manifest', ORIGIN + '/manifest.webmanifest', { cache: 'no-store' }),
    probe('test-report-pdf', ORIGIN + '/cable-concrete-flume-test-report-csu-2005.pdf', { method: 'HEAD' })
  ]);

  const allOk = checks.every(c => c.ok);
  const failures = checks.filter(c => !c.ok);

  res.status(allOk ? 200 : 503).json({
    ok: allOk,
    failures: failures.length,
    checks,
    timestamp: new Date().toISOString()
  });
};
