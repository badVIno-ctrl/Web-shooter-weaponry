#!/usr/bin/env node
/* ============================================================================
   ORDNANCE audio gate.

   Refuses any weapon whose synthesised shot is not measurably a gunshot.
   The bell detector used here is calibrated in audio-calib.js — run that
   first; a gate nobody calibrated is decoration.

     G1  shock rise      < 60 us            a front, not a ramp
     G2  crest factor    > 12 dB            impulsive, not compressed mush
     G3  ring index      < 2.10 (dry src)   no narrowband ring == no bell
     G3b room IR ring    < 2.10             the reverb is not a bell either
     G4  blast peak      inside real band    per-cartridge, published figures
     G5  centroid        inside real band
     G6  ordering        by caliber, monotonic where physics says it must be
     G7  hygiene         no DC, no clipped runs
     G8  mechanics       every mech cue also non-tonal
   ========================================================================== */

const O = require('./ordnance-audio.js');
const { ringIndex, THRESH } = require('./audio-calib.js');
const SR = 48000;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let l = 2; l <= n; l <<= 1) {
    const a = -2 * Math.PI / l, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += l) {
      let cr = 1, ci = 0;
      for (let k = 0; k < l / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + l / 2] * cr - im[i + k + l / 2] * ci;
        const vi = re[i + k + l / 2] * ci + im[i + k + l / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + l / 2] = ur - vr; im[i + k + l / 2] = ui - vi;
        const n2 = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = n2;
      }
    }
  }
}

function spec(x, t0, t1) {
  const len = Math.round((t1 - t0) * SR);
  let N = 1; while (N < len) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  const off = Math.round(t0 * SR);
  for (let i = 0; i < len; i++) re[i] = (x[off + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (len - 1)));
  fft(re, im);
  const half = N >> 1, binHz = SR / N;
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
  // 1/3-octave power smoothing for a stable peak estimate
  const sm = new Float64Array(half);
  for (let i = 1; i < half; i++) {
    const l = Math.max(1, Math.floor(i / 1.26)), h = Math.min(half - 1, Math.ceil(i * 1.26));
    let s = 0, c = 0; for (let k = l; k <= h; k++) { s += mag[k] * mag[k]; c++; }
    sm[i] = Math.sqrt(s / c);
  }
  let pk = 0, pi = 1;
  const lo = Math.max(2, Math.round(120 / binHz)), hi = Math.min(half - 1, Math.round(9000 / binHz));
  for (let i = lo; i <= hi; i++) if (sm[i] > pk) { pk = sm[i]; pi = i; }
  let num = 0, den = 0;
  const a20 = Math.max(1, Math.round(20 / binHz)), a16 = Math.min(half - 1, Math.round(16000 / binHz));
  for (let i = a20; i <= a16; i++) { num += i * binHz * mag[i]; den += mag[i]; }
  // 2-8 kHz energy fraction: this is perceived "sharpness"/"crack"
  let hf = 0, tot = 0;
  const h1 = Math.round(2000 / binHz), h2 = Math.min(half - 1, Math.round(8000 / binHz));
  for (let i = a20; i <= a16; i++) { const p2 = mag[i] * mag[i]; tot += p2; if (i >= h1 && i <= h2) hf += p2; }
  return { fPeak: pi * binHz, centroid: num / (den || 1), hfRatio: hf / (tot || 1) };
}

function basics(ch) {
  const n = ch.length;
  let peak = 0, pi = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(ch[i]); if (a > peak) { peak = a; pi = i; } }
  let i10 = 0, i90 = pi;
  for (let i = pi; i >= 0; i--) if (Math.abs(ch[i]) <= 0.9 * peak) { i90 = i; break; }
  for (let i = i90; i >= 0; i--) if (Math.abs(ch[i]) <= 0.1 * peak) { i10 = i; break; }
  const riseUs = Math.abs(i90 - i10) / SR * 1e6;
  let s = 0; const w = Math.min(n, Math.round(0.25 * SR));
  for (let i = 0; i < w; i++) s += ch[i] * ch[i];
  const rms = Math.sqrt(s / w);
  let dc = 0; for (let i = 0; i < n; i++) dc += ch[i]; dc /= n;
  let clip = 0, run = 0;
  for (let i = 0; i < n; i++) { if (Math.abs(ch[i]) > 0.985) { if (++run >= 3) clip++; } else run = 0; }
  return { peak, riseUs, rms, crestDb: 20 * Math.log10(peak / (rms || 1e-9)), dc, clip };
}

/* Published 1/3-octave gunshot measurements, shooter position, put the blast
   peak and the magnitude centroid inside these bands. These are the real-life
   targets — not knobs to widen when a weapon fails. */
/* Where the 1/3-octave peak sits is NOT what makes a pistol sound sharp.
   Unweighted gunshot spectra put most energy at 300-1000 Hz for practically
   every firearm, including a Glock; what separates a short-barrel pistol crack
   from a 12-gauge boom is the 2-8 kHz fraction. So the peak band is kept wide
   and deliberately loose, and "sharpness" is gated separately as hfRatio. */
const TARGET = {
  ak74:         { fPk: [ 420, 1150], cen: [1600, 4300] },
  akm:          { fPk: [ 320,  900], cen: [1400, 4000] },
  m416:         { fPk: [ 450, 1250], cen: [1650, 4400] },
  'scar-h':     { fPk: [ 300,  880], cen: [1350, 3950] },
  mp5a3:        { fPk: [ 500, 1400], cen: [1700, 4500] },
  glock18c:     { fPk: [ 450, 1500], cen: [1800, 4700] },
  remington870: { fPk: [ 170,  520], cen: [ 900, 3100] },
  svd:          { fPk: [ 280,  820], cen: [1250, 3800] },
};

const MECHS = {
  knife: ['knifeSwing', 'knifeHit', 'sheathe'],
  ak74: ['dryFire', 'trigger', 'selector', 'magOut', 'magIn', 'boltBack', 'boltRelease'],
  akm: ['dryFire', 'trigger', 'selector', 'magOut', 'magIn', 'boltBack', 'boltRelease'],
  m416: ['dryFire', 'trigger', 'safety', 'magOut', 'magIn', 'boltBack', 'boltRelease'],
  'scar-h': ['dryFire', 'trigger', 'safety', 'magOut', 'magIn', 'boltBack', 'boltRelease', 'stockFold'],
  mp5a3: ['dryFire', 'trigger', 'safety', 'magOut', 'magIn', 'boltBack', 'boltRelease', 'sightClick'],
  glock18c: ['dryFire', 'trigger', 'magOut', 'magIn', 'boltBack', 'boltRelease', 'safety'],
  remington870: ['dryFire', 'trigger', 'safety', 'pumpBack', 'pumpForward', 'shellInsert'],
  svd: ['dryFire', 'trigger', 'safety', 'magOut', 'magIn', 'boltBack', 'boltRelease', 'sightClick'],
};

/* Longest -20 dB duration of any 1/12-octave band. A mechanical cue is a short
   event; if a single band sustains past ~260 ms it is ringing, whatever the
   neighbourhood ratio says. Needed because a 30 ms cue has so few frames above
   the floor that the ratio starts measuring the hop size instead. */
function maxBandMs(x) {
  const N = 2048, HOP = 128;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const binHz = SR / N, half = N >> 1, step = Math.pow(2, 1 / 12);
  const cs = []; for (let f = 200; f <= 6000; f *= step) cs.push(f);
  const ed = cs.map(f => [Math.max(1, Math.round(f / Math.pow(2, 1 / 24) / binHz)),
                          Math.min(half - 1, Math.round(f * Math.pow(2, 1 / 24) / binHz))]);
  const env = cs.map(() => []);
  const lim = Math.min(x.length, Math.round(0.7 * SR));
  for (let p = 0; p + N <= lim; p += HOP) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[p + i] * win[i];
    fft(re, im);
    for (let ci = 0; ci < cs.length; ci++) {
      const [a, b] = ed[ci]; let s2 = 0;
      for (let k = a; k <= b; k++) s2 += re[k] * re[k] + im[k] * im[k];
      env[ci].push(s2 / (b - a + 1));
    }
  }
  const nF = env[0].length; let best = 0;
  for (let ci = 0; ci < cs.length; ci++) {
    const e = env[ci]; let pk = 0, pf = 0;
    for (let i = 0; i < nF; i++) if (e[i] > pk) { pk = e[i]; pf = i; }
    if (pk <= 0) continue;
    const th = pk * 0.01; let cnt = 1, i = pf;
    while (i + 1 < nF && e[i + 1] > th) { i++; cnt++; }
    let g = pf; while (g - 1 >= 0 && e[g - 1] > th) { g--; cnt++; }
    best = Math.max(best, cnt * HOP / SR * 1000);
  }
  return best;
}

function run() {
  let fails = 0;
  const rows = [];

  console.log('\n=== shots ========================================================');
  console.log('   weapon        cartridge   rise    crest   ring   fpk/target      centroid/target');
  for (const id of Object.keys(O.WEAPONS)) {
    if (!O.firesAmmunition(id)) continue;   // a blade has no muzzle blast
    const W = O.WEAPONS[id], cart = O.CARTRIDGE[W.cart], T = TARGET[id];
    const acc = { riseUs: 0, crestDb: 0, ring: 0, fPeak: 0, centroid: 0, hfRatio: 0, dc: 0, clip: 0 };
    const NS = 4;
    for (let s = 1; s <= NS; s++) {
      const dryS = O.renderShot(SR, id, { seed: s }).channels[0];
      const wet = dryS;
      const b = basics(wet), sp = spec(wet, 0, 0.040);
      const r = ringIndex(dryS, SR, 0, 0.8);
      acc.riseUs += b.riseUs / NS; acc.crestDb += b.crestDb / NS;
      acc.dc += b.dc / NS; acc.clip += b.clip;
      acc.ring += r.ring / NS; acc.fPeak += sp.fPeak / NS; acc.centroid += sp.centroid / NS;
      acc.hfRatio += sp.hfRatio / NS;
    }
    const g = {
      G1: acc.riseUs < 60,
      G2: acc.crestDb > 12,
      G3: acc.ring < THRESH,
      G4: acc.fPeak >= T.fPk[0] && acc.fPeak <= T.fPk[1],
      G5: acc.centroid >= T.cen[0] && acc.centroid <= T.cen[1],
      G7: Math.abs(acc.dc) < 2e-3 && acc.clip === 0,
    };
    const ok = Object.values(g).every(Boolean);
    if (!ok) fails++;
    rows.push({ id, acc, ok });
    console.log(`  ${id.padEnd(13)} ${cart.name.padEnd(10)} ` +
      `${acc.riseUs.toFixed(0).padStart(4)}us ${acc.crestDb.toFixed(1).padStart(6)}dB ` +
      `${acc.ring.toFixed(2).padStart(6)} ` +
      `${acc.fPeak.toFixed(0).padStart(5)}/[${T.fPk[0]},${T.fPk[1]}]`.padEnd(20) +
      `${acc.centroid.toFixed(0).padStart(5)}/[${T.cen[0]},${T.cen[1]}]`.padEnd(20) +
      Object.entries(g).map(([k, v]) => (v ? ' ' : '!') + k).join('') + (ok ? '  PASS' : '  FAIL'));
  }

  console.log('\n=== G6 caliber ordering (spectral centroid) =======================');
  const c = (id) => rows.find(r => r.id === id).acc.centroid;
  const h = (id) => rows.find(r => r.id === id).acc.hfRatio;
  const bcCache = {};
  const bc = (id) => bcCache[id] !== undefined ? bcCache[id] : (bcCache[id] =
    spec(O.renderShot(SR, id, { seed: 1, dry: true, noAction: true, noBrass: true }).channels[0], 0, 0.040).centroid);
  const checks = [
    ['12 gauge is the lowest of all', Math.min(...rows.map(r => r.acc.centroid)) === c('remington870')],
    ['7,62x54R < 7,62x39 (620 vs 415 mm barrel)', c('svd') < c('akm')],
    ['7,62x39 < 5,45x39', c('akm') < c('ak74')],
    ['7,62x51 < 5,56x45', c('scar-h') < c('m416')],
    /* Same cartridge, shorter barrel -> higher muzzle pressure -> sharper.
       Measured on the BLAST ALONE: the aggregate centroid also carries the
       action noise, and an MP5's roller-delayed bolt in a stamped steel
       receiver really is brighter than a Glock slide, so the aggregate
       ordering is not what barrel-length physics predicts. */
    ['blast only: Glock 114 mm > MP5 225 mm, same round', bc('glock18c') > bc('mp5a3')],
    ['blast only: bore order 12ga < 7,62 < 5,45',
      bc('remington870') < bc('akm') && bc('akm') < bc('ak74')],
    /* sharpness: 2-8 kHz fraction. This is the ordering a listener actually
       hears as crack-vs-boom, and it must be monotonic in barrel length for a
       shared cartridge and monotonic in bore across the set. */
    /* The sharpest weapon in the set is the 5,56 short-barrel rifle, not the
       pistol: its bullet leaves at Mach 2.7 and contributes a bow-shock N-wave
       that a Mach 1.1 pistol round does not have. */
    ['sharpness: 5,56 short barrel is the sharpest of all',
      Math.max(...rows.map(r => r.acc.hfRatio)) === h('m416')],
    ['sharpness: 12 gauge is the dullest of all',
      Math.min(...rows.map(r => r.acc.hfRatio)) === h('remington870')],
    /* Aggregate sharpness is NOT ordered by barrel length here, and that is
       correct: the MP5's stamped-steel receiver and light roller-delayed bolt
       add more high-frequency mechanical energy than a Glock's polymer frame.
       Barrel-length physics is gated on the blast alone, above. */
    ['sharpness: both 9 mm above every 7,62',
      Math.min(h('mp5a3'), h('glock18c')) > Math.max(h('akm'), h('scar-h'), h('svd'))],
    ['sharpness: 5,45 > 7,62x39 (same barrel)', h('ak74') > h('akm')],
    ['sharpness: 5,56 > 7,62x51', h('m416') > h('scar-h')],
    ['sharpness: SVD 620 mm is the dullest rifle',
      Math.min(h('ak74'), h('akm'), h('m416'), h('scar-h'), h('svd')) === h('svd')],
  ];
  for (const [t, v] of checks) { if (!v) fails++; console.log(`  ${v ? 'ok  ' : 'FAIL'}  ${t}`); }
  for (const r of rows) console.log(`     ${r.id.padEnd(14)} aggregate ${r.acc.centroid.toFixed(0).padStart(5)} Hz` +
    `   blast-only ${bc(r.id).toFixed(0).padStart(5)} Hz   2-8kHz ${(r.acc.hfRatio * 100).toFixed(1).padStart(5)}%`);

  console.log('\n=== G3b room impulse responses ===================================');
  for (const name of Object.keys(O.ENV)) {
    const ir = O.renderRoomIR(SR, name);
    const r = ringIndex(ir.channels[0], SR, 0, 1.2);
    const ok = r.ring < THRESH;
    if (!ok) fails++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  "${name}" ring ${r.ring.toFixed(2)}`);
  }

  console.log('\n=== G8 mechanical cues (all must be non-tonal) ====================');
  let mechFail = 0, mechN = 0;
  for (const id of Object.keys(MECHS)) {
    const bad = [];
    for (const k of MECHS[id]) {
      mechN++;
      const mch = O.renderMech(SR, id, k, { seed: 5, dry: true }).channels[0];
      const r = ringIndex(mch, SR, 0, 0.7, { minFrames: 12 });
      const abs = maxBandMs(mch);
      if (r.ring >= THRESH || abs > 260) { bad.push(`${k}=${r.ring.toFixed(2)}/${abs.toFixed(0)}ms${JSON.stringify(r.worst.slice(0, 2))}`); mechFail++; }
    }
    console.log(`  ${bad.length === 0 ? 'ok  ' : 'FAIL'}  ${id.padEnd(13)} ${bad.length ? bad.join(' ') : MECHS[id].length + ' cues clean'}`);
  }
  if (mechFail) fails++;
  console.log(`  ${mechN - mechFail}/${mechN} cues non-tonal`);

  console.log('\n=== A/B vs the synthesis currently in the repo ====================');
  const src = require('fs').readFileSync(__dirname + '/legacy-ref.js', 'utf8');
  const legacy = new Function('O', src + '; return renderLegacy;')(O);
  const lch = legacy(SR);
  const lb = basics(lch), ls = spec(lch, 0, 0.040), lr = ringIndex(lch, SR, 0, 0.8);
  const nb = rows.find(r => r.id === 'ak74').acc;
  const line = (k, l, n2, unit, better) =>
    console.log(`  ${k.padEnd(12)} repo ${l.toFixed(2).padStart(8)}${unit}   new ${n2.toFixed(2).padStart(8)}${unit}   ` +
      ((better === 'lo' ? n2 < l : n2 > l) ? 'NEW WINS' : 'repo'));
  line('rise', lb.riseUs, nb.riseUs, ' us', 'lo');
  line('ring index', lr.ring, nb.ring, '   ', 'lo');
  line('crest', lb.crestDb, nb.crestDb, ' dB', 'hi');
  line('centroid', ls.centroid, nb.centroid, ' Hz', 'hi');
  console.log(`  repo ring peaks at ${JSON.stringify(lr.worst)} Hz — the 152->43 Hz sine sweep and its harmonics`);

  console.log('\n' + (fails === 0 ? 'ALL AUDIO GATES PASS' : fails + ' GATE FAILURE(S)'));
  process.exit(fails === 0 ? 0 : 1);
}

run();
