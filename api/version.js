// Returns the current production deployment identifier so the client can
// detect when a new build is live and silently refresh. Vercel populates
// VERCEL_GIT_COMMIT_SHA on every deploy; VERCEL_DEPLOYMENT_ID is the
// fallback for rebuilds without a SHA change.
module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.status(200).json({
    v: process.env.VERCEL_GIT_COMMIT_SHA
      || process.env.VERCEL_DEPLOYMENT_ID
      || 'dev'
  });
};
