// Internal health-check endpoint. Polled by a time-driven Apps Script
// trigger every 10 minutes — when any of the four sub-checks below
// fails, the Apps Script side sends an email to
// nnamdieguh@iecsafrica.com. No third-party uptime service required.

const ORIGIN = 'https://www.cableconcrete.app';

async function probe(name, url, init) {
  const start = Date.now();
  try {
    const r = await fetch(url, init || {});
    const ms = Date.now() - start;
    return { name, ok: r.ok, status: r.status, ms };
  } catch (e) {
    return { name, ok: false, error: (e && e.message) || String(e), ms: Date.now() - start };
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
