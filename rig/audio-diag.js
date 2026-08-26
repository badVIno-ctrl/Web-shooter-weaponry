#!/usr/bin/env node
/* Layer diagnostic + a proper "bell" detector.

   The prominence metric flags any spectral peak, including the comb notches a
   ground reflection genuinely produces. That is a false positive: a comb does
   not sound like a bell. What a bell actually is, is a NARROWBAND component
   that OUTLASTS the broadband energy around it. So measure that directly:
   run an STFT, find how long each frequency bin stays within 20 dB of its own
   peak, and compare the worst bins against the median bin. Scale-free, and
   immune to both reverb length and comb colouring.                          */

const O = require('./ordnance-audio.js');
const SR = 48000;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/* ---- ringIndex: how much longer do the longest-lived bins live than the
        median bin. 1.0 = perfectly broadband. >3 = a pitched ring. --------- */
function ringIndex(x, sr, t0, t1) {
  const N = 1024, HOP = 256;
  const i0 = Math.round(t0 * sr), i1 = Math.min(x.length, Math.round(t1 * sr));
  const frames = [];
  for (let p = i0; p + N <= i1; p += HOP) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[p + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    fft(re, im);
    const half = N >> 1, m = new Float64Array(half);
    for (let i = 0; i < half; i++) m[i] = re[i] * re[i] + im[i] * im[i];
    frames.push(m);
  }
  if (frames.length < 6) return { ring: 1, dur: [] };
  const binHz = sr / N, half = N >> 1;
  const lo = Math.max(2, Math.round(120 / binHz)), hi = Math.min(half - 1, Math.round(9000 / binHz));
  const durs = [], bins = [];
  for (let b = lo; b <= hi; b++) {
    let pk = 0, pf = 0;
    for (let f = 0; f < frames.length; f++) if (frames[f][b] > pk) { pk = frames[f][b]; pf = f; }
    if (pk <= 0) continue;
    const th = pk * 0.01;              // -20 dB in power
    let f = pf, cnt = 1;
    while (f + 1 < frames.length && frames[f + 1][b] > th) { f++; cnt++; }
    let g = pf;
    while (g - 1 >= 0 && frames[g - 1][b] > th) { g--; cnt++; }
    durs.push(cnt * HOP / sr * 1000);
    bins.push(b * binHz);
  }
  /* Compare each bin against its own 1/3-octave NEIGHBOURHOOD, not against the
     global median. Every real room absorbs high frequencies faster than low
     ones, so a global comparison reports ring 6+ on a perfectly broadband
     gunshot in a perfectly ordinary room. What a bell actually looks like is a
     bin that outlasts the bins immediately beside it. */
  const rel = [];
  for (let i = 0; i < durs.length; i++) {
    const f = bins[i];
    const nb = [];
    for (let k = 0; k < durs.length; k++) {
      if (k === i) continue;
      if (bins[k] >= f / 1.26 && bins[k] <= f * 1.26) nb.push(durs[k]);
    }
    if (nb.length < 4) continue;
    nb.sort((a, b) => a - b);
    const lm = nb[nb.length >> 1] || 1;
    rel.push({ r: durs[i] / lm, f });
  }
  rel.sort((a, b) => a.r - b.r);
  const p97o = rel[Math.min(rel.length - 1, Math.floor(rel.length * 0.97))] || { r: 1, f: 0 };
  const med = 1, p97 = p97o.r;
  const worst = rel.slice(-6).map(o => Math.round(o.f));
  return { ring: p97 / med, med, p97, worst: worst.slice(0, 8) };
}

function centroidMag(x, sr, t0, t1, fmax) {
  let N = 1; const len = Math.round((t1 - t0) * sr); while (N < len) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  const off = Math.round(t0 * sr);
  for (let i = 0; i < len; i++) re[i] = (x[off + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (len - 1)));
  fft(re, im);
  const binHz = sr / N, half = N >> 1;
  let num = 0, den = 0, pk = 0, pi = 1;
  const a = Math.max(1, Math.round(20 / binHz)), b = Math.min(half - 1, Math.round((fmax || 16000) / binHz));
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
  const sm = new Float64Array(half);
  for (let i = 1; i < half; i++) {
    const l = Math.max(1, Math.floor(i / 1.26)), h = Math.min(half - 1, Math.ceil(i * 1.26));
    let s = 0, c = 0; for (let k = l; k <= h; k++) { s += mag[k] * mag[k]; c++; }
    sm[i] = Math.sqrt(s / c);
  }
  for (let i = a; i <= b; i++) { num += i * binHz * mag[i]; den += mag[i]; }
  const fLo = Math.max(2, Math.round(120 / binHz));
  for (let i = fLo; i < Math.min(half - 1, Math.round(9000 / binHz)); i++) if (sm[i] > pk) { pk = sm[i]; pi = i; }
  return { centroid: num / (den || 1), fPeak: pi * binHz };
}

/* --------------------------------------------------------------- run it --- */

const OPTS = [
  ['full (with room)', {}],
  ['DRY source only ', { dry: true }],
  ['DRY no mech/brass', { dry: true, noAction: true, noBrass: true }],
  ['DRY blast only  ', { dry: true, noAction: true, noBrass: true, noGround: true }],
  ['room, no mech   ', { noAction: true, noBrass: true }],
];

console.log('ringIndex: 1.0 = broadband, >3 = pitched ring present\n');
for (const id of ['ak74', 'glock18c', 'remington870']) {
  console.log('--- ' + id);
  for (const [name, o] of OPTS) {
    const r = O.renderShot(SR, id, Object.assign({ seed: 2 }, o));
    const ch = r.channels[0];
    const rEarly = ringIndex(ch, SR, 0, 0.30);
    const rLate = ringIndex(ch, SR, 0.05, 0.60);
    const c = centroidMag(ch, SR, 0, 0.040);
    console.log(`  ${name}  ring(0-300ms) ${rEarly.ring.toFixed(2)}  ring(50-600) ${rLate.ring.toFixed(2)}` +
      `  cen ${c.centroid.toFixed(0).padStart(5)}  fpk ${c.fPeak.toFixed(0).padStart(5)}  worst ${JSON.stringify(rEarly.worst)}`);
  }
}

console.log('\n--- legacy, same instrument');
{
  // reuse the legacy renderer from the gate
  const src = require('fs').readFileSync(__dirname + '/audio-gate.js', 'utf8');
  const fnSrc = src.slice(src.indexOf('function renderLegacy'), src.indexOf('/* ------------------------------------------------------------------- gates */'));
  const renderLegacy = new Function('O', fnSrc + '; return renderLegacy;')(O);
  const ch = renderLegacy(SR);
  const rE = ringIndex(ch, SR, 0, 0.30);
  const c = centroidMag(ch, SR, 0, 0.040);
  console.log(`  legacy            ring(0-300ms) ${rE.ring.toFixed(2)}  cen ${c.centroid.toFixed(0)}  fpk ${c.fPeak.toFixed(0)}  worst ${JSON.stringify(rE.worst)}`);
}
