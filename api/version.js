// Returns the current production deployment identifier so the client can
// detect when a new build is live and silently refresh. Vercel populates
// VERCEL_GIT_COMMIT_SHA on every deploy; VERCEL_DEPLOYMENT_ID is the
// fallback for rebuilds without a SHA change.
// Whether a device that is behind must come up to date before it can be used.
//
// true  — the refresh is mandatory: a short countdown, no way past it, and the
//         cache is emptied so the reload genuinely comes from the network.
// false — the older, gentler behaviour: a longer countdown the user can simply
//         outwait by closing the app.
//
// Leave this on. Turn it off only for a deploy where a half-updated device is
// harmless and you would rather not interrupt anyone mid-quiz.
const FORCE_UPDATE = true;

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.status(200).json({
    v: process.env.VERCEL_GIT_COMMIT_SHA
      || process.env.VERCEL_DEPLOYMENT_ID
      || 'dev',
    force: FORCE_UPDATE
  });
};
