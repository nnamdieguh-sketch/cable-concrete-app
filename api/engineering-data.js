// Cable Concrete® Engineering Data API
//
// Serves the proprietary hydraulic data tables, anchor schedules and
// competitive comparisons used by the Block Selection Tool. Keeping this
// out of the public index.html means a casual "View Source" no longer
// exposes the IECS Engineering Binder values.
//
// POST-only: anyone scraping would have to find the endpoint, send a POST
// with quiz answers, and get rate-limited before pulling enough samples to
// reconstruct the dataset.

const B = {
  CCG2: { name: "CC G2", sub: "Permeable Paving & Gentle Slopes", h: "80–88 mm", wt: "25–28 lbs/sf", vel: "4.0 m/s (good)", oa: "40%", ms: "2.44m × 4.88m", ma: 11.9, c: "#4ade80", sh: "182 N/m²", nc: "0.019–0.022", nb: "0.03–0.035", bh: '2.5"', cb: "302/304 SS or polyester braided" },
  CC35: { name: "CC 35", sub: "Channel Lining & Moderate Slopes", h: '114–127 mm (4.5")', wt: "37–40 lbs/sf", vel: "5.2 m/s (good) / 2.7 (poor)", oa: "20%", ms: "2.44m × 4.88m", ma: 11.9, c: "#60a5fa", sh: "325 N/m²", nc: "0.022–0.027", nb: "0.03–0.035", bh: '4.5"', cb: 'SS 1×19 5/32"/4mm' },
  CC45: { name: "CC 45", sub: "Steep Slopes & High Velocity", h: '140–152 mm (5.5")', wt: "45–52 lbs/sf", vel: "6.1 m/s (good) / 3.5 (poor)", oa: "20%", ms: "2.44m × 4.88m", ma: 11.9, c: "#f59e0b", sh: "390 N/m²", nc: "0.024–0.029", nb: "0.03–0.035", bh: '5.5"', cb: 'SS 1×19 5/32"/4mm' },
  CC70: { name: "CC 70", sub: "Shoreline, Coastal & Extreme Flow", h: '216–229 mm (8.5")', wt: "70–78 lbs/sf", vel: "7.6 m/s (good) / 4.0 (poor)", oa: "20%", ms: "2.44m × 4.88m", ma: 11.9, c: "#f87171", sh: "625 N/m²", nc: "0.028–0.033", nb: "0.03–0.035", bh: '8.5"', cb: 'SS 1×19 3/16"/4.8mm' },
};

const MILD = [
  { b: "CCG2", bm: "2.1", am: "4.0", bf: "7", af: "13" },
  { b: "CC35", bm: "2.7", am: "5.2", bf: "9", af: "17" },
  { b: "CC45", bm: "3.5", am: "6.1", bf: "11", af: "20" },
  { b: "CC70", bm: "4.0", am: "7.6", bf: "13", af: "25" }
];

const STEEP = [
  { b: "CCG2", bm: "2.0", am: "3.7", bf: "6.5", af: "12.1" },
  { b: "CC35", bm: "2.5", am: "4.9", bf: "8.4", af: "15.8" },
  { b: "CC45", bm: "3.3", am: "5.7", bf: "10.2", af: "18.6" },
  { b: "CC70", bm: "3.7", am: "7.1", bf: "12.1", af: "23.3" }
];

const MN = {
  CCG2: [
    { v: "1–3", d: "0.3–1", c: "0.019–0.022", cb: "0.019–0.021", bg: "0.030–0.035" },
    { v: "1–4", d: "1.0–2", c: "0.018–0.021", cb: "0.018–0.020", bg: "0.030–0.035" },
    { v: "1–6", d: ">2", c: "0.017–0.020", cb: "0.017–0.019", bg: "0.030–0.035" }
  ],
  CC35: [
    { v: "1–3", d: "0.3–1", c: "0.023–0.027", cb: "0.020–0.022", bg: "0.030–0.035" },
    { v: "1–4", d: "1.0–2", c: "0.022–0.025", cb: "0.020–0.021", bg: "0.030–0.035" },
    { v: "1–6", d: ">2", c: "0.021–0.024", cb: "0.020–0.021", bg: "0.030–0.035" }
  ],
  CC45: [
    { v: "1–3", d: "0.3–1", c: "0.026–0.029", cb: "0.020–0.024", bg: "0.030–0.035" },
    { v: "1–4", d: "1.0–2", c: "0.024–0.026", cb: "0.020–0.022", bg: "0.030–0.035" },
    { v: "1–6", d: ">2", c: "0.023–0.025", cb: "0.020–0.021", bg: "0.030–0.035" }
  ],
  CC70: [
    { v: "1–3", d: "0.3–1", c: "0.028–0.033", cb: "0.020–0.025", bg: "0.030–0.035" },
    { v: "1–4", d: "1.0–2", c: "0.028–0.033", cb: "0.020–0.025", bg: "0.030–0.035" },
    { v: "1–6", d: ">2", c: "0.028–0.033", cb: "0.020–0.025", bg: "0.030–0.035" }
  ]
};

const SAFL35 = [
  { r: 1, o: "1.0 ft", d: 24, v: 15.3, sh: "~20 lb/ft²" },
  { r: 2, o: "2.0 ft", d: 78, v: 18.4, sh: "~30 lb/ft²" },
  { r: 3, o: "3.0 ft", d: 152, v: 19.0, sh: "38.5 lb/ft²" },
  { r: 4, o: "3.5 ft", d: 198, v: 19.1, sh: "38.5 lb/ft²" }
];

const SAFL45 = [
  { r: 5, o: "1.0 ft", d: 26.5, v: 16.8, sh: "~18 lb/ft²" },
  { r: 6, o: "2.0 ft", d: 74, v: 18.0, sh: "~28 lb/ft²" },
  { r: 7, o: "3.0 ft", d: 147, v: 18.9, sh: "34.9 lb/ft²" },
  { r: 8, o: "3.5 ft", d: 185, v: 19.2, sh: "34.9 lb/ft²" }
];

const ANCHORS = [
  ["Anchor type", "Duckbill™ or equivalent — driven to undisturbed soil (typically 4 ft deep)"],
  ["3:1 slope, poor soil", "4 ft centres"],
  ["3:1 slope, good soil", "8 ft centres"],
  ["Steeper slopes / poor subsoil", "4 ft centres + mid-slope anchors for long slopes"],
  ["Subcritical flow (standard)", "Clamps @ 4–8 ft; 1 anchor per 16 ft centre; 1–2 per 8 ft side edge"],
  ["Mat placement", "Start downstream → work upstream. Upstream mat overlaps downstream filter cloth."],
  ["Clamping", "Min. 3 locations on long side, 1 on short side per adjoining mat"],
  ["Leading edge", "Block must be flush with channel invert; anchors at leading edge are essential"],
  ["Slope > 1%", "Expert advice required. Reduce velocities 25% at abrupt transitions."],
  ["Velocity warning", "Velocities > 5 m/s may abrade geotextile. Velocities > 8 m/s NOT recommended."]
];

const COMPS = [
  ["vs Angular Rock Rip-Rap", "Rip-rap requires large-stone quarries largely unavailable in SSA and shifts unpredictably under high velocity. Cable Concrete® is factory-engineered with defined shear resistance up to 625 N/m² (CC 70). Superior installation rate, no quarry logistics dependency."],
  ["vs Hand-Placed Concrete", "Monolithic concrete cracks under differential settlement and thermal cycling — common in Nigerian and East African expansive soils. Cable Concrete® articulates to follow ground movement while maintaining full erosion protection. No formwork or curing time."],
  ["vs Gabion Baskets", "Gabion wire corrodes in 5–15 years in tropical and coastal environments. Cable Concrete® uses 302/304 stainless steel cable with breaking strength up to 4,700 lbs (CC 70). No basket distortion under sustained flow."],
  ["vs Stone Pitching", "Stone pitching mortar joints erode at velocities above 3 m/s. Cable Concrete® CC 45 handles up to 6.1 m/s with good placement. University-tested by Minnesota SAFL and University of Windsor."]
];

// Supply-and-install rates from the Cable Concrete® Price Guide (Updated B).
// Rates are per square metre of supplied area and INCLUDE materials,
// geotextile, cable/rope, equipment, labour and installation. They EXCLUDE
// earthworks and taxes.
//
// Kept server-side alongside the hydraulic tables so (a) they never appear in
// View Source, and (b) they can be revised here when the Naira moves without
// touching the front end.
//
// `countries` gates which markets see an automatic estimate. Everywhere else
// the app shows a "request a price for your market" call to action instead of
// quoting Naira figures that wouldn't apply.
const PRICING = {
  currency: 'NGN',
  symbol: '₦',
  countries: ['Nigeria'],
  rates: {
    CCG2: { low: 30000, high: 45000 },
    CC35: { low: 45000, high: 50000 },
    CC45: { low: 50000, high: 55000 },
    CC70: { low: 70000, high: 80000 }
  },
  includes: 'Concrete mix (25 MPa), geotextile, stainless steel cable / rope, equipment, labour and installation',
  excludes: 'Earthworks and taxes',
  note: 'Project size, inflation and currency fluctuations can affect pricing and can sometimes make it slightly more expensive.'
};

module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ B, MILD, STEEP, MN, SAFL35, SAFL45, ANCHORS, COMPS, PRICING });
};
