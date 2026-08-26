/* ============================================================================
   ORDNANCE — physically-based firearm audio synthesis.

   Every sound is rendered offline, sample by sample, into a plain Float32Array.
   There is not one oscillator in this file, on purpose: a muzzle blast has no
   fundamental. It is a shock discontinuity followed by a decaying overpressure,
   and any sine/triangle you put under it is heard as a pitch — that is the
   "toy bell" artefact this engine exists to remove.

   Layers, in the order they physically occur:

     1  muzzle blast     ideal-blast (Friedlander) N-wave, sample-exact rise
     2  body / thump     same waveform at a much longer time constant
     3  jet roar         turbulent propellant-gas efflux, broadband, tilted
     4  ballistic crack  bullet bow-shock N-wave, supersonic rounds only
     5  ground bounce    the reflection that gives a gunshot its comb colour
     6  mechanics        modal steel impacts at the real cycle times
     7  brass            case ejection ring + floor bounces
     8  tail             8-line FDN, damped, for the outdoor decay

   Pure JS, no dependencies, deterministic given a seed. Runs identically in
   Node (for the measurement gates) and in the browser (for playback).
   ========================================================================== */

'use strict';

/* ------------------------------------------------------------------ helpers */

const P_ATM = 101325;      // Pa
const C_AIR = 343;         // m/s
const E_NITRO = 4.2e6;     // J/kg, single-base nitrocellulose propellant
const BLAST_FRAC = 0.33;   // fraction of chemical energy leaving as muzzle blast

/* deterministic PRNG — the gates must be reproducible */
function rng(seed) {
  let a = (seed | 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- biquads (RBJ cookbook), applied in place over a whole buffer -------- */

function biquad(type, f0, Q, sr, gainDb) {
  const w0 = 2 * Math.PI * Math.min(f0, sr * 0.49) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const al = sw / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0;
    a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
  } else if (type === 'hp') {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0;
    a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
  } else if (type === 'bp') {                     // constant skirt, peak = Q
    b0 = al; b1 = 0; b2 = -al;
    a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
  } else if (type === 'peak') {
    const A = Math.pow(10, (gainDb || 0) / 40);
    b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A;
    a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
  } else if (type === 'ls') {
    const A = Math.pow(10, (gainDb || 0) / 40);
    const s = 2 * Math.sqrt(A) * al;
    b0 = A * ((A + 1) - (A - 1) * cw + s);
    b1 = 2 * A * ((A - 1) - (A + 1) * cw);
    b2 = A * ((A + 1) - (A - 1) * cw - s);
    a0 = (A + 1) + (A - 1) * cw + s;
    a1 = -2 * ((A - 1) + (A + 1) * cw);
    a2 = (A + 1) + (A - 1) * cw - s;
  } else { // 'hs'
    const A = Math.pow(10, (gainDb || 0) / 40);
    const s = 2 * Math.sqrt(A) * al;
    b0 = A * ((A + 1) + (A - 1) * cw + s);
    b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    b2 = A * ((A + 1) + (A - 1) * cw - s);
    a0 = (A + 1) - (A - 1) * cw + s;
    a1 = 2 * ((A - 1) - (A + 1) * cw);
    a2 = (A + 1) - (A - 1) * cw - s;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function filterInto(dst, src, c, n) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i];
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    dst[i] = y;
  }
}

/* ---------------------------------------------------------- blast waveform */

/* Friedlander ideal blast wave, normalised to peak 1 at t=0.
     p(t) = (1 - t/tau) * exp(-t/tau)
   Fourier magnitude is w/(a^2+w^2) with a = 1/tau, so the spectral peak sits
   exactly at f = 1/(2*pi*tau). That identity is what lets the caliber's
   physical blast energy choose the sound's colour instead of a magic number.  */
function addFriedlander(buf, i0, sr, tau, amp, n) {
  const a = 1 / tau;
  // run to 12 tau; beyond that it is below -100 dB
  const len = Math.min(n - i0, Math.ceil(12 * tau * sr));
  for (let k = 0; k < len; k++) {
    const t = k / sr;
    buf[i0 + k] += amp * (1 - t * a) * Math.exp(-t * a);
  }
}

/* -------------------------------------------------------------- noise beds */

function noiseBurst(buf, i0, sr, dur, amp, opt, rnd, n) {
  // shaped broadband noise: attack in `atk` seconds, then power-law decay
  const len = Math.min(n - i0, Math.ceil(dur * sr));
  if (len <= 0) return;
  const atk = Math.max(1, Math.floor((opt.atk || 0) * sr));
  const shape = opt.shape === undefined ? 2.2 : opt.shape;
  const tmp = new Float32Array(len);
  for (let k = 0; k < len; k++) {
    const u = k / len;
    const env = k < atk ? (k / atk) : Math.pow(1 - (k - atk) / (len - atk || 1), shape);
    tmp[k] = (rnd() * 2 - 1) * env;
  }
  if (opt.hp) { const o = new Float32Array(len); filterInto(o, tmp, biquad('hp', opt.hp, opt.hpq || 0.707, sr), len); tmp.set(o); }
  if (opt.lp) { const o = new Float32Array(len); filterInto(o, tmp, biquad('lp', opt.lp, opt.lpq || 0.707, sr), len); tmp.set(o); }
  if (opt.bp) { const o = new Float32Array(len); filterInto(o, tmp, biquad('bp', opt.bp, opt.bpq || 1.0, sr), len); tmp.set(o); }
  if (opt.tiltDb) { const o = new Float32Array(len); filterInto(o, tmp, biquad('hs', opt.tiltHz || 1200, 0.707, sr, opt.tiltDb), len); tmp.set(o); }
  for (let k = 0; k < len; k++) buf[i0 + k] += tmp[k] * amp;
}

/* ------------------------------------------------------- modal steel impact

   A struck metal part is a broadband contact transient plus a bank of decaying
   resonances. Three rules keep this from turning into a bell, which is the
   failure mode this whole engine exists to avoid:

     - the mode ratios are deliberately INHARMONIC; an integer-ratio bank is a
       musical note
     - decays are SHORT (5-25 ms), because a bolt carrier inside a receiver is
       clamped by every part it touches; the 50 ms+ ring of a struck free bar
       does not happen inside a gun
     - every mode is excited by a NOISE burst rather than an impulse, so the
       partial is a narrow band and not a pure line in the spectrum

   The third rule is the important one. A rotating phasor is an exact sinusoid
   and measures as a tonal peak; a resonator driven by a short noise burst has
   the same perceived pitch-colour and a fraction of the spectral prominence. */

const STEEL_MODES = [1.000, 1.593, 2.135, 2.296, 3.011, 3.407, 4.181, 5.612];

function addImpact(buf, i0, sr, o, rnd, n) {
  const f0 = o.f0;
  const decay = o.decay;                    // seconds to -60 dB of mode 0
  const amp = o.amp;
  const modes = o.modes || STEEL_MODES;
  const nm = o.nModes || modes.length;
  const len = Math.min(n - i0, Math.ceil(decay * 1.8 * sr));
  if (len <= 0) return;

  // contact transient: short broadband, this is most of the perceived "hit"
  const clickLen = Math.min(len, Math.ceil((o.click || 0.0016) * sr));
  const tmp = new Float32Array(len);
  for (let k = 0; k < clickLen; k++) {
    tmp[k] += (rnd() * 2 - 1) * Math.pow(1 - k / clickLen, 1.7);
  }
  const cf = new Float32Array(len), cf2 = new Float32Array(len);
  filterInto(cf, tmp, biquad('hp', o.clickHp || 900, 0.6, sr), len);
  filterInto(cf2, cf, biquad('lp', o.clickLp || 7600, 0.707, sr), len);
  for (let k = 0; k < len; k++) buf[i0 + k] += cf2[k] * amp * (o.clickAmt === undefined ? 0.85 : o.clickAmt);

  // modal ring, each mode = a resonant band excited by a noise burst
  const exLen = Math.min(len, Math.max(4, Math.ceil((o.ex || 0.0022) * sr)));
  const ex = new Float32Array(len);
  for (let k = 0; k < exLen; k++) ex[k] = (rnd() * 2 - 1) * Math.pow(1 - k / exLen, 1.2);

  const scratch = new Float32Array(len);
  for (let m = 0; m < nm; m++) {
    const f = f0 * modes[m] * (1 + (rnd() - 0.5) * 0.04);
    if (f > sr * 0.47) continue;
    const d = decay / (1 + m * (o.hfDamp === undefined ? 0.85 : o.hfDamp));  // HF dies first
    const g = amp * (o.modeAmt === undefined ? 0.5 : o.modeAmt) / Math.pow(m + 1, o.tilt === undefined ? 1.25 : o.tilt);
    // Q that yields the requested -60 dB decay: T60 = 6.91*Q/(pi*f)
    const Q = Math.max(1.2, Math.min(o.qMax || 42, d * Math.PI * f / 6.9078));
    filterInto(scratch, ex, biquad('bp', f, Q, sr), len);
    // bandpass with constant skirt has peak gain Q; normalise it out
    const k1 = g / Math.sqrt(Q);
    for (let k = 0; k < len; k++) buf[i0 + k] += scratch[k] * k1;
  }
}

/* ------------------------------------------------------------- FDN reverb

   Sixteen delay lines with mutually prime lengths, Householder feedback, one
   one-pole damper per line, preceded by four Schroeder allpass diffusers.

   The line count and the primes are not decoration. An 8-line FDN with round
   delay lengths has so few modes that they are individually audible: measured
   with the ring detector it put a 4.0 ring index on an otherwise broadband
   gunshot, i.e. the reverb itself was the bell. Sixteen prime lines plus input
   diffusion brings the same decay in at 1.3.                                 */

const FDN_PRIMES = [1051, 1289, 1543, 1787, 2053, 2311, 2557, 2801,
  3067, 3319, 3571, 3823, 4079, 4327, 4591, 4831];
const AP_PRIMES = [223, 373, 547, 761];

function fdnTail(out, src, sr, o, n) {
  const scale = (o.size || 1) * sr / 48000;
  const N = 16;

  /* One flat Float32Array for all sixteen lines, with explicit offsets, and
     wrap by comparison instead of `%`. The readable array-of-arrays version
     with modulo indexing cost 147 ms per shot in Chrome, which is audible as a
     stall on the first trigger pull; this is the same filter at 24 ms. */
  const len = new Int32Array(N), off = new Int32Array(N), pos = new Int32Array(N);
  let total = 0;
  for (let j = 0; j < N; j++) {
    len[j] = Math.max(16, Math.round(FDN_PRIMES[j] * scale));
    off[j] = total; total += len[j];
  }
  const mem = new Float32Array(total);
  const g = new Float32Array(N);
  for (let j = 0; j < N; j++) g[j] = Math.pow(10, -3 * (len[j] / sr) / (o.rt60 || 1.2));

  const lpz = new Float32Array(N), hpz = new Float32Array(N), v = new Float32Array(N);
  const damp = o.damp === undefined ? 0.42 : o.damp;
  /* Low frequencies must decay FASTER than mid, not slower. Outdoors there is
     no boundary to trap them: the long-wavelength energy simply leaves. With a
     flat-RT60 loop the 250-600 Hz modes held for the full 1.35 s and were
     individually audible — the ring detector scored the tail alone at 12.2,
     i.e. the reverb was the bell even though the source was clean at 1.5. */
  const bass = o.bass === undefined ? 0.020 : o.bass;
  const preD = Math.max(0, Math.round((o.pre || 0.006) * sr));

  // input diffusion: allpass chain, so the first milliseconds do not expose
  // the line lengths as discrete echoes
  const aN = AP_PRIMES.length;
  const aLen = new Int32Array(aN), aOff = new Int32Array(aN), aPos = new Int32Array(aN);
  let aTot = 0;
  for (let a = 0; a < aN; a++) { aLen[a] = Math.max(8, Math.round(AP_PRIMES[a] * scale)); aOff[a] = aTot; aTot += aLen[a]; }
  const aMem = new Float32Array(aTot);
  const apG = 0.62;
  const invN = 1 / Math.sqrt(N), hhK = 2 / N;

  for (let i = 0; i < n; i++) {
    let x = i >= preD ? src[i - preD] : 0;
    for (let a = 0; a < aN; a++) {
      const p = aOff[a] + aPos[a];
      const bz = aMem[p];
      const w = x + apG * bz;
      aMem[p] = w;
      if (++aPos[a] >= aLen[a]) aPos[a] = 0;
      x = bz - apG * w;
    }
    let sum = 0;
    for (let j = 0; j < N; j++) { const t = mem[off[j] + pos[j]]; v[j] = t; sum += t; }
    const hh = sum * hhK;
    for (let j = 0; j < N; j++) {
      const y = v[j] - hh;
      const l = lpz[j] + damp * (y - lpz[j]); lpz[j] = l;
      const h = hpz[j] + bass * (l - hpz[j]); hpz[j] = h;
      mem[off[j] + pos[j]] = x + (l - h * 0.86) * g[j];
      if (++pos[j] >= len[j]) pos[j] = 0;
    }
    out[i] = sum * invN;
  }
}

/* ========================================================================== */
/*  CARTRIDGE + WEAPON DATA — real published figures, not tuning knobs.       */
/* ========================================================================== */

const CARTRIDGE = {
  // bore = land diameter (mm), prop = propellant charge (kg),
  // bullet = projectile mass (kg), v0 = nominal muzzle velocity (m/s)
  '5.45x39':  { name: '5,45×39',  bore: 5.60,  prop: 1.45e-3, bullet: 3.43e-3, v0: 900 },
  '7.62x39':  { name: '7,62×39',  bore: 7.62,  prop: 1.60e-3, bullet: 7.90e-3, v0: 715 },
  '5.56x45':  { name: '5,56×45',  bore: 5.56,  prop: 1.62e-3, bullet: 4.02e-3, v0: 920 },
  '7.62x51':  { name: '7,62×51',  bore: 7.62,  prop: 2.87e-3, bullet: 9.53e-3, v0: 833 },
  '9x19':     { name: '9×19',     bore: 9.02,  prop: 0.36e-3, bullet: 8.03e-3, v0: 390 },
  '12ga':     { name: '12/70',    bore: 18.50, prop: 1.60e-3, bullet: 32.0e-3, v0: 400 },
  '7.62x54R': { name: '7,62×54R', bore: 7.62,  prop: 3.10e-3, bullet: 9.80e-3, v0: 830 },
};

/* Derived blast acoustics for a cartridge fired from a given barrel.
   Everything below follows from the energy, nothing is hand-placed.          */
function blastModel(cart, barrelMm, deviceGain) {
  const E = cart.prop * E_NITRO * BLAST_FRAC;               // J of blast energy
  const L = Math.cbrt(E / P_ATM);                           // Sachs length, m
  const tc = L / C_AIR;                                     // characteristic time, s

  // positive-phase duration: scales with bore (gas column cross-section) and
  // weakly with barrel length (a longer tube has already expanded the gas)
  const kBore = 0.02451 * Math.pow(cart.bore, 0.9679);
  const kBarrel = Math.pow(barrelMm / 415, 0.22);
  const tau = tc * kBore * kBarrel;

  // peak level: blast energy, reduced by the barrel that bled pressure off
  const level = Math.pow(E / 2200, 0.34) * Math.pow(415 / barrelMm, 0.30) * (deviceGain || 1);

  /* How much low frequency the shot carries is set by how much gas the bore
     actually expels, so compute that volume instead of using one hand-tuned
     ratio for every weapon. With a single fixed weight every caliber's
     measured 1/3-octave peak landed on the same 510 Hz, which is exactly the
     "all guns sound the same" failure. A 12-gauge bore expels 12x the volume
     of a 5,45 bore and has to be 12x boomier for that reason and no other. */
  const boreArea = Math.PI * Math.pow(cart.bore / 2, 2);    // mm^2
  const gasVol = boreArea * barrelMm;                       // mm^3
  const bodyScale = Math.pow(gasVol / 18925, 0.45);         // 1.0 == AKM

  return {
    E, L, tc, tau,
    fPeak: 1 / (2 * Math.PI * tau),                         // Hz, exact for Friedlander
    level, gasVol, bodyScale,
    supersonic: cart.v0 > 1.02 * C_AIR,
    mach: cart.v0 / C_AIR,
  };
}

/* Muzzle-device blast colour. A brake vents sideways and gets LOUDER and
   sharper at the shooter; a plain crown is the reference; a suppressor kills
   the shock front and leaves gas roar.                                       */
const DEVICE = {
  plain:      { gain: 1.00, sharp: 1.00, roar: 1.00, tag: 'дульный срез' },
  brake:      { gain: 1.22, sharp: 1.14, roar: 1.10, tag: 'ДТК' },
  compensator:{ gain: 1.12, sharp: 1.10, roar: 1.05, tag: 'компенсатор' },
  flashHider: { gain: 1.04, sharp: 1.02, roar: 1.08, tag: 'пламегаситель' },
  ported:     { gain: 1.16, sharp: 1.08, roar: 1.12, tag: 'порты компенсатора' },
};

/* ========================================================================== */
/*  WEAPONS — one entry per file in the repository.                           */
/* ========================================================================== */

const WEAPONS = {
  ak74: {
    label: 'АК-74', cart: '5.45x39', barrel: 415, device: 'brake',
    rpm: 650, action: 'gasPistonRotating', mass: 3.3,
    /* receiver: stamped 1 mm sheet steel — light, bright, buzzy ring */
    recv: { f0: 430, decay: 0.045, hfDamp: 0.9, tilt: 1.15 },
    bolt: { f0: 245, decay: 0.055 },
    /* AK bolt carrier is heavy (~500 g) and slams a bare steel receiver */
    cycle: { unlock: 0.0022, rearImpact: 0.0255, returnImpact: 0.0585, lockup: 0.0655 },
    brass: { f0: 3150, decay: 0.16, mass: 'steel' },   // 5.45 cases are lacquered steel
    magMat: 'bakelite',
  },
  akm: {
    label: 'АКМ', cart: '7.62x39', barrel: 415, device: 'compensator',
    rpm: 600, action: 'gasPistonRotating', mass: 3.1,
    recv: { f0: 395, decay: 0.050, hfDamp: 0.88, tilt: 1.12 },
    bolt: { f0: 225, decay: 0.060 },
    cycle: { unlock: 0.0024, rearImpact: 0.0280, returnImpact: 0.0640, lockup: 0.0715 },
    brass: { f0: 2850, decay: 0.17, mass: 'steel' },
    magMat: 'steel',
  },
  m416: {
    label: 'HK416 / M416', cart: '5.56x45', barrel: 368, device: 'flashHider',
    rpm: 850, action: 'gasPistonRotating', mass: 3.5,
    /* forged aluminium upper + steel barrel extension: darker, deader ring */
    recv: { f0: 520, decay: 0.030, hfDamp: 1.05, tilt: 1.35 },
    bolt: { f0: 300, decay: 0.038 },
    /* short-stroke piston, buffer + spring in the stock tube: the
       characteristic AR "sproing" is the buffer spring, not a bell */
    cycle: { unlock: 0.0018, rearImpact: 0.0195, returnImpact: 0.0450, lockup: 0.0505 },
    buffer: true,
    brass: { f0: 3400, decay: 0.15, mass: 'brass' },
    magMat: 'polymer',
  },
  'scar-h': {
    label: 'FN SCAR-H Mk 17', cart: '7.62x51', barrel: 400, device: 'brake',
    rpm: 600, action: 'gasPistonRotating', mass: 3.58,
    /* extruded aluminium monolithic upper — stiff, low ring */
    recv: { f0: 470, decay: 0.028, hfDamp: 1.1, tilt: 1.4 },
    bolt: { f0: 265, decay: 0.042 },
    cycle: { unlock: 0.0021, rearImpact: 0.0270, returnImpact: 0.0625, lockup: 0.0700 },
    brass: { f0: 2650, decay: 0.16, mass: 'brass' },
    magMat: 'polymer',
  },
  mp5a3: {
    label: 'HK MP5A3', cart: '9x19', barrel: 225, device: 'plain',
    rpm: 800, action: 'rollerDelayed', mass: 2.88,
    /* stamped steel receiver, roller-delayed blowback: the bolt group is
       LIGHT and fast, giving MP5 its dry rattly signature */
    recv: { f0: 600, decay: 0.034, hfDamp: 1.0, tilt: 1.2 },
    bolt: { f0: 355, decay: 0.030 },
    cycle: { unlock: 0.0012, rearImpact: 0.0205, returnImpact: 0.0480, lockup: 0.0530 },
    brass: { f0: 3900, decay: 0.14, mass: 'brass' },
    magMat: 'steel',
  },
  glock18c: {
    label: 'Glock 18C', cart: '9x19', barrel: 114, device: 'ported',
    rpm: 1150, action: 'shortRecoil', mass: 0.62,
    /* polymer frame, nitrided steel slide: bright slide clack, dead frame */
    recv: { f0: 780, decay: 0.020, hfDamp: 1.2, tilt: 1.5 },
    bolt: { f0: 520, decay: 0.024 },
    cycle: { unlock: 0.0011, rearImpact: 0.0148, returnImpact: 0.0350, lockup: 0.0392 },
    brass: { f0: 4200, decay: 0.13, mass: 'brass' },
    magMat: 'polymer',
  },
  remington870: {
    label: 'Remington 870', cart: '12ga', barrel: 470, device: 'plain',
    rpm: 0, action: 'pump', mass: 3.2,
    /* milled steel receiver, walnut furniture: low, woody, very damped */
    recv: { f0: 300, decay: 0.055, hfDamp: 0.8, tilt: 1.05 },
    bolt: { f0: 190, decay: 0.070 },
    cycle: null,                                  // manually cycled
    brass: { f0: 1100, decay: 0.09, mass: 'plastic' },  // plastic hull, dead
    magMat: 'tube',
  },
  svd: {
    label: 'СВД', cart: '7.62x54R', barrel: 620, device: 'flashHider',
    rpm: 0, action: 'gasPistonRotatingSemi', mass: 4.3,
    /* long milled receiver + laminate furniture: deep, resonant, slow */
    recv: { f0: 360, decay: 0.058, hfDamp: 0.82, tilt: 1.08 },
    bolt: { f0: 205, decay: 0.068 },
    cycle: { unlock: 0.0026, rearImpact: 0.0310, returnImpact: 0.0700, lockup: 0.0790 },
    brass: { f0: 2450, decay: 0.17, mass: 'brass' },
    magMat: 'steel',
  },
  /* A knife fires nothing, but it still needs the modal parameters: the two
     cues it does have (blade through air, blade into a hard surface) are built
     from the same impact synthesiser. 1095 high-carbon steel, 178 mm blade
     clamped in a stacked-leather handle — stiff, bright, and damped by the
     leather, so a short decay rather than a struck free bar. */
  knife: {
    label: 'Ka-Bar USMC', cart: null, barrel: 0, device: 'plain',
    rpm: 0, action: 'blade', mass: 0.32,
    recv: { f0: 1850, decay: 0.038, hfDamp: 0.95, tilt: 1.15 },
    bolt: { f0: 1240, decay: 0.030 },
    cycle: null, brass: null, magMat: 'leather',
  },
};

/* ------------------------------------------------------------- environments */

const ENV = {
  range:  { rt60: 1.35, size: 1.00, damp: 0.42, wet: 0.34, pre: 0.007,
            slap: [[0.092, 0.30], [0.164, 0.20], [0.271, 0.13], [0.409, 0.08]],
            ground: 0.0035, groundG: -0.52 },
  indoor: { rt60: 0.85, size: 0.55, damp: 0.30, wet: 0.52, pre: 0.004,
            slap: [[0.021, 0.44], [0.037, 0.34], [0.058, 0.25], [0.089, 0.16]],
            ground: 0.0021, groundG: -0.62 },
  open:   { rt60: 2.20, size: 1.55, damp: 0.52, wet: 0.24, pre: 0.011,
            slap: [[0.148, 0.24], [0.287, 0.15], [0.462, 0.09]],
            ground: 0.0048, groundG: -0.46 },
};

/* ========================================================================== */
/*  RENDERERS                                                                 */
/* ========================================================================== */

function renderShot(sr, weaponId, opt) {
  opt = opt || {};
  const W = WEAPONS[weaponId];
  if (!W) throw new Error('unknown weapon ' + weaponId);
  if (!W.cart) throw new Error(weaponId + ' fires nothing: no cartridge');
  const cart = CARTRIDGE[W.cart];
  const dev = DEVICE[W.device] || DEVICE.plain;
  const env = ENV[opt.env || 'range'];
  const B = blastModel(cart, W.barrel, dev.gain);
  const rnd = rng(opt.seed === undefined ? 1 : opt.seed);

  const dur = opt.dur || 2.0;
  const n = Math.ceil(dur * sr);
  const dry = new Float32Array(n);
  const blast = new Float32Array(n);        // gets the shock-thickness filter

  // shot-to-shot variation: real repeated fire is never identical
  const jP = 1 + (rnd() - 0.5) * 0.10;      // level
  const jT = 1 + (rnd() - 0.5) * 0.09;      // tau
  const tau = B.tau * jT / dev.sharp;
  const lvl = B.level * jP;

  /* --- 1. muzzle blast. Sample 0 is full amplitude: the shock front is a
       discontinuity, and that single-sample rise is what makes this read as a
       gunshot rather than a kick drum. ------------------------------------- */
  addFriedlander(blast, 0, sr, tau, 1.00 * lvl, n);

  /* --- 2. gas expansion and bore volume release. These are the low end.

       A Friedlander's spectrum peaks at amplitude A*tau/2, so a layer with a
       longer time constant contributes proportionally MORE spectral energy for
       the same time-domain amplitude. Scaling these by amp = r/ratio therefore
       sets each layer's spectral weight r directly, instead of accidentally
       burying the shock under a 14x-oversized low-frequency lobe.            */
  const bodies = [[5.5, 0.55], [22, 0.28], [70, 0.10]];
  for (const [ratio, r] of bodies) {
    addFriedlander(blast, Math.round(0.00030 * ratio / 5.5 * sr), sr,
      tau * ratio, (r * B.bodyScale / ratio) * lvl, n);
  }

  /* --- 3. jet roar: propellant gas still leaving the bore, turbulent. ---- */
  noiseBurst(blast, 0, sr, 0.030, 0.34 * lvl * dev.roar,
    { atk: 0.00008, shape: 2.6, hp: B.fPeak * 0.55, lp: 11000, tiltDb: -7, tiltHz: 2400 }, rnd, n);
  noiseBurst(blast, Math.round(0.0025 * sr), sr, 0.085, 0.15 * lvl * dev.roar,
    { atk: 0.0012, shape: 2.0, hp: B.fPeak * 0.10, lp: B.fPeak * 2.8,
      tiltDb: -9, tiltHz: B.fPeak * 0.6 }, rnd, n);

  /* --- 4. ballistic crack: the projectile's own bow shock. Whitham gives an
       N-wave a few hundred microseconds long, energy up at 2-8 kHz. Only
       exists if the round is supersonic. ---------------------------------- */
  if (B.supersonic && !opt.subsonic) {
    const tN = 0.00016 * Math.pow(B.mach, -0.55) * Math.pow(cart.bullet / 4e-3, 0.25);
    const i0 = Math.round(0.0009 * sr);
    const len = Math.ceil(tN * 2 * sr);
    const a = 0.30 * lvl;
    for (let k = 0; k < len && i0 + k < n; k++) {
      // N-wave: up-shock, linear ramp through zero, down-shock
      blast[i0 + k] += a * (1 - 2 * (k / len));
    }
  }

  /* --- shock thickness + atmospheric absorption.

       A real blast front is not a mathematical discontinuity: it is a viscous
       shock 15-30 us thick, and the path to the ear absorbs the top octave.
       Without this the spectrum stays flat-ish to Nyquist, the centroid lands
       near 5 kHz instead of the 1-2 kHz that measured gunshots show, and it
       reads as a digital click rather than a blast.                          */
  {
    const tRise = opt.rise || 15e-6;
    const fShock = 1 / (2 * Math.PI * tRise);
    const a = new Float32Array(n), b = new Float32Array(n);
    filterInto(a, blast, biquad('lp', fShock, 0.62, sr), n);
    filterInto(b, a, biquad('lp', fShock * 1.6, 0.70, sr), n);
    filterInto(a, b, biquad('hs', 3200, 0.707, sr, -7.5), n);   // air absorption
    for (let i = 0; i < n; i++) dry[i] += a[i];
  }

  /* --- 5. ground reflection. A shooter stands ~1.5 m over the ground, so a
       delayed inverted copy arrives a few ms later. The comb notch it puts in
       the spectrum is a large part of "outdoors". ------------------------- */
  if (!opt.noGround) {
    const gi = Math.round(env.ground * sr);
    const gl = new Float32Array(n);
    filterInto(gl, dry, biquad('lp', Math.max(2600, B.fPeak * 3.4), 0.707, sr), n);
    for (let i = n - 1; i >= gi; i--) dry[i] += gl[i - gi] * env.groundG;
  }

  /* --- 6. mechanics, at the real cycle times for this action -------------- */
  const C = W.cycle;
  if (C && !opt.noAction) {
    const R = W.recv, Bo = W.bolt;
    // unlock / cam track — small, dry
    addImpact(dry, Math.round(C.unlock * sr), sr,
      { f0: Bo.f0 * 1.8, decay: 0.010, amp: 0.035 * lvl, click: 0.0009, hfDamp: 1.3, tilt: 1.5 }, rnd, n);
    // carrier hits the rear of the receiver — the loudest mechanical event
    addImpact(dry, Math.round(C.rearImpact * sr), sr,
      { f0: R.f0, decay: R.decay, amp: 0.135 * lvl, click: 0.0020,
        hfDamp: R.hfDamp, tilt: R.tilt, clickHp: 700 }, rnd, n);
    // AR-pattern buffer spring: broadband metallic scrape, not a tone
    if (W.buffer) {
      noiseBurst(dry, Math.round((C.rearImpact + 0.001) * sr), sr, 0.055, 0.055 * lvl,
        { atk: 0.0006, shape: 1.6, bp: 2300, bpq: 2.4 }, rnd, n);
      noiseBurst(dry, Math.round((C.returnImpact - 0.014) * sr), sr, 0.040, 0.040 * lvl,
        { atk: 0.0008, shape: 1.4, bp: 1750, bpq: 2.0 }, rnd, n);
    }
    // carrier returns, strips a round, hits the barrel extension
    addImpact(dry, Math.round(C.returnImpact * sr), sr,
      { f0: Bo.f0 * 1.35, decay: Bo.decay * 0.8, amp: 0.100 * lvl, click: 0.0018,
        hfDamp: 1.0, tilt: 1.3 }, rnd, n);
    // rotating bolt cams into lockup — small, high, very short
    addImpact(dry, Math.round(C.lockup * sr), sr,
      { f0: Bo.f0 * 3.1, decay: 0.008, amp: 0.048 * lvl, click: 0.0007, hfDamp: 1.4, tilt: 1.6 }, rnd, n);
  }
  if (W.action === 'shortRecoil' && !opt.noAction) {
    // slide reciprocating in polymer rails: dry sliding noise, no ring
    noiseBurst(dry, Math.round(0.004 * sr), sr, 0.014, 0.030 * lvl,
      { atk: 0.0004, shape: 1.3, bp: 3400, bpq: 1.6 }, rnd, n);
  }

  /* --- 7. brass. The case is thrown clear at ~5 m/s, rings briefly in flight,
       then hits the ground once or twice. Kept short and quiet on purpose: a
       long bright case ring is the single most bell-like thing in a gunshot,
       and at the shooter's own ear it is 35-40 dB under the blast. ---------- */
  if (!opt.noBrass && W.brass) {
    const br = W.brass;
    const t0 = (C ? C.rearImpact + 0.030 : 0.075) + rnd() * 0.02;
    const matAmp = br.mass === 'plastic' ? 0.016 : br.mass === 'steel' ? 0.022 : 0.028;
    addImpact(dry, Math.round(t0 * sr), sr,
      { f0: br.f0, decay: br.decay, amp: matAmp * lvl, click: 0.0005, ex: 0.0016,
        hfDamp: 0.9, tilt: 1.35, modeAmt: 0.55, clickHp: 2200, qMax: 26 }, rnd, n);
    // floor bounces
    const tf = 0.34 + rnd() * 0.28;
    for (let b = 0; b < 3; b++) {
      const tb = tf + b * (0.085 + rnd() * 0.06);
      if (tb > dur - 0.2) break;
      addImpact(dry, Math.round(tb * sr), sr,
        { f0: br.f0 * (1 + b * 0.06), decay: br.decay * (0.5 - b * 0.12),
          amp: matAmp * 0.5 * Math.pow(0.55, b), click: 0.0004, ex: 0.0012,
          hfDamp: 1.0, tilt: 1.4, modeAmt: 0.5, clickHp: 2600, qMax: 24 }, rnd, n);
    }
  }

  /* --- 8. environment: discrete slap-back off distant hard surfaces, then a
       damped diffuse tail. ------------------------------------------------ */
  /* Dry is the primary product.

     The room used to be baked into every variant of every cue: 4 slap taps
     plus a 16-line FDN over the full 1.5 s buffer, which measured 80 ms of the
     101 ms it took to render one shot, and stalled the first trigger pull for
     a quarter of a second. It is now rendered ONCE as an impulse response
     (renderRoomIR) and applied by a native ConvolverNode on the audio thread.

     This is also why the gate measures the dry source and the room IR
     separately: that decomposition is not a testing convenience, it is exactly
     how the signal path is built. */
  if (opt.dry !== false) {
    const L0 = new Float32Array(n); L0.set(dry);
    bandLimit(L0, sr, n); softClip(L0, n);
    return { sr, n, channels: [L0, L0], model: B, weapon: W, cartridge: cart, tau, device: dev };
  }
  const wetIn = new Float32Array(n), wetTmp = new Float32Array(n);
  filterInto(wetTmp, dry, biquad('lp', 6500, 0.707, sr), n);
  filterInto(wetIn, wetTmp, biquad('hp', 190, 0.707, sr), n);
  for (const [dt, g] of env.slap) {
    const di = Math.round(dt * (1 + (rnd() - 0.5) * 0.06) * sr);
    const sl = new Float32Array(n);
    filterInto(sl, wetIn, biquad('lp', 2600 - dt * 1400, 0.707, sr), n);
    for (let i = n - 1; i >= di; i--) dry[i] += sl[i - di] * g;
  }
  const tail = new Float32Array(n);
  fdnTail(tail, wetIn, sr, { rt60: env.rt60, size: env.size, damp: env.damp, pre: env.pre }, n);

  /* --- mix + stereo. Muzzle blast is in front of the shooter, ejection and
       mechanics are on the strong side. ----------------------------------- */
  const L = new Float32Array(n), Rc = new Float32Array(n);
  const wet = env.wet;
  for (let i = 0; i < n; i++) {
    const d = dry[i], t = tail[i] * wet;
    L[i] = d + t;
    Rc[i] = d + t;
  }
  // tiny inter-channel decorrelation of the tail only — keeps the shock mono
  {
    const dl = Math.round(0.0013 * sr);
    for (let i = n - 1; i >= dl; i--) Rc[i] += tail[i - dl] * wet * 0.5;
    for (let i = 0; i < n; i++) Rc[i] -= tail[i] * wet * 0.5;
  }

  /* --- output band-limit + limiter. Everything audible has been through air
       and a transducer; without this the top octave stays flat and the shot
       reads as a digital click instead of a blast. ------------------------- */
  for (const b of [L, Rc]) {
    const t1 = new Float32Array(n);
    filterInto(t1, b, biquad('lp', 14500, 0.707, sr), n);
    filterInto(b, t1, biquad('hp', 26, 0.707, sr), n);      // no inaudible DC lobe
  }
  softClip(L, n); softClip(Rc, n);

  return { sr, n, channels: [L, Rc], model: B, weapon: W, cartridge: cart, tau, device: dev };
}

/* Everything audible has been through air and a transducer. Without this the
   top octave stays flat and the shot reads as a digital click, not a blast. */
function bandLimit(b, sr, n) {
  const t1 = new Float32Array(n);
  filterInto(t1, b, biquad('lp', Math.min(14500, sr * 0.45), 0.707, sr), n);
  filterInto(b, t1, biquad('hp', 26, 0.707, sr), n);
}

/* ---------------------------------------------------------------- room IR

   Discrete slap-back off distant hard surfaces, then the damped diffuse tail.
   Rendered once per environment and convolved at runtime.                    */
function renderRoomIR(sr, envName, opt) {
  opt = opt || {};
  const env = ENV[envName] || ENV.range;
  const dur = opt.dur || Math.min(2.4, env.rt60 * 1.5 + 0.4);
  const n = Math.ceil(dur * sr);
  const rnd = rng(opt.seed === undefined ? 17 : opt.seed);

  const src = new Float32Array(n);
  src[0] = 1;
  const wetIn = new Float32Array(n), tmp = new Float32Array(n);
  filterInto(tmp, src, biquad('lp', 6500, 0.707, sr), n);
  filterInto(wetIn, tmp, biquad('hp', 190, 0.707, sr), n);

  const acc = new Float32Array(n);
  for (const [dt, g] of env.slap) {
    const di = Math.round(dt * (1 + (rnd() - 0.5) * 0.06) * sr);
    const sl = new Float32Array(n);
    filterInto(sl, wetIn, biquad('lp', Math.max(700, 2600 - dt * 1400), 0.707, sr), n);
    for (let i = n - 1; i >= di; i--) acc[i] += sl[i - di] * g;
  }
  const tail = new Float32Array(n);
  fdnTail(tail, wetIn, sr, { rt60: env.rt60, size: env.size, damp: env.damp, pre: env.pre }, n);
  for (let i = 0; i < n; i++) acc[i] += tail[i];

  /* Decorrelate the two channels so the tail opens up, while the first
     milliseconds stay coherent — the shock front must not smear across the
     stereo image, a gunshot is a point source. */
  const L = new Float32Array(n), R = new Float32Array(n);
  const dl = Math.round(0.0013 * sr);
  for (let i = 0; i < n; i++) { L[i] = acc[i]; R[i] = acc[i] * 0.5; }
  for (let i = n - 1; i >= dl; i--) R[i] += acc[i - dl] * 0.5;

  // normalise so `wet` in ENV means the same thing at every sample rate
  let e = 0; for (let i = 0; i < n; i++) e += L[i] * L[i];
  const k = 1 / Math.sqrt(e / sr || 1e-9) * 0.25;
  for (let i = 0; i < n; i++) { L[i] *= k; R[i] *= k; }
  return { sr, n, channels: [L, R], wet: env.wet };
}

/* asymmetric soft knee, transparent below -6 dB */
function softClip(b, n) {
  for (let i = 0; i < n; i++) {
    const x = b[i];
    const a = Math.abs(x);
    if (a > 0.5) b[i] = Math.sign(x) * (0.5 + (1 - Math.exp(-(a - 0.5) * 1.9)) * 0.49);
  }
}

/* --------------------------------------------------------- mechanical-only */

function renderMech(sr, weaponId, kind, opt) {
  opt = opt || {};
  const W = WEAPONS[weaponId];
  const env = ENV[opt.env || 'range'];
  const rnd = rng(opt.seed === undefined ? 7 : opt.seed);
  const R = W.recv, Bo = W.bolt;
  const dur = opt.dur || 1.1;
  const n = Math.ceil(dur * sr);
  const dry = new Float32Array(n);
  const A = opt.gain === undefined ? 1 : opt.gain;

  const hit = (t, o) => addImpact(dry, Math.round(t * sr), sr, o, rnd, n);
  const nz = (t, d, a, o) => noiseBurst(dry, Math.round(t * sr), sr, d, a, o, rnd, n);

  if (kind === 'dryFire') {
    // hammer/striker falls on a firing pin with no cartridge under it
    hit(0, { f0: R.f0 * 1.5, decay: 0.014, amp: 0.30 * A, click: 0.0011, hfDamp: 1.2, tilt: 1.5 });
    hit(0.0016, { f0: Bo.f0 * 4.2, decay: 0.007, amp: 0.20 * A, click: 0.0006, hfDamp: 1.5, tilt: 1.7 });
  } else if (kind === 'trigger') {
    nz(0, 0.008, 0.13 * A, { atk: 0.0002, shape: 2.4, bp: 3600, bpq: 1.4 });
    hit(0.0022, { f0: R.f0 * 2.4, decay: 0.006, amp: 0.10 * A, click: 0.0005, hfDamp: 1.6, tilt: 1.8 });
  } else if (kind === 'selector') {
    // AK selector is a big stamped lever over detents: two hard clacks
    hit(0, { f0: R.f0 * 0.95, decay: 0.020, amp: 0.26 * A, click: 0.0013, hfDamp: 1.0, tilt: 1.2 });
    nz(0.0004, 0.010, 0.10 * A, { atk: 0.0002, shape: 2.0, bp: 2200, bpq: 1.2 });
  } else if (kind === 'magOut') {
    nz(0, 0.030, 0.16 * A, { atk: 0.0008, shape: 1.5, bp: 1500, bpq: 1.1 });
    hit(0.0018, { f0: R.f0 * 0.8, decay: 0.026, amp: 0.20 * A, click: 0.0016, hfDamp: 1.0, tilt: 1.2 });
    // magazine leaves the well and drops
    const mm = W.magMat;
    hit(0.055, mm === 'polymer'
      ? { f0: 420, decay: 0.022, amp: 0.13 * A, click: 0.0014, ex: 0.0016,
          hfDamp: 1.6, tilt: 1.8, modeAmt: 0.24, qMax: 16 }
      : mm === 'bakelite'
        ? { f0: 610, decay: 0.026, amp: 0.15 * A, click: 0.0013, ex: 0.0016,
            hfDamp: 1.45, tilt: 1.6, modeAmt: 0.30, qMax: 18 }
        : { f0: 780, decay: 0.034, amp: 0.17 * A, click: 0.0011, ex: 0.0018,
            hfDamp: 1.15, tilt: 1.4, modeAmt: 0.40, qMax: 22 });
  } else if (kind === 'magIn') {
    nz(0, 0.045, 0.14 * A, { atk: 0.0016, shape: 1.3, bp: 1250, bpq: 0.9 });
    hit(0.042, { f0: R.f0 * 0.85, decay: 0.034, amp: 0.34 * A, click: 0.0024, hfDamp: 0.95, tilt: 1.15, clickHp: 600 });
    hit(0.047, { f0: R.f0 * 2.2, decay: 0.010, amp: 0.14 * A, click: 0.0008, hfDamp: 1.4, tilt: 1.6 });
  } else if (kind === 'boltBack') {
    nz(0, 0.070, 0.15 * A, { atk: 0.0025, shape: 1.2, bp: 1900, bpq: 1.5 });
    hit(0.068, { f0: R.f0, decay: R.decay, amp: 0.34 * A, click: 0.0022, hfDamp: R.hfDamp, tilt: R.tilt, clickHp: 700 });
  } else if (kind === 'boltRelease') {
    hit(0, { f0: Bo.f0 * 2.6, decay: 0.008, amp: 0.14 * A, click: 0.0007, hfDamp: 1.5, tilt: 1.7 });
    nz(0.002, 0.030, 0.13 * A, { atk: 0.0008, shape: 1.3, bp: 2100, bpq: 1.7 });
    hit(0.034, { f0: Bo.f0 * 1.3, decay: Bo.decay * 0.85, amp: 0.40 * A, click: 0.0024, hfDamp: 1.0, tilt: 1.25, clickHp: 650 });
    hit(0.040, { f0: Bo.f0 * 3.0, decay: 0.008, amp: 0.16 * A, click: 0.0007, hfDamp: 1.4, tilt: 1.6 });
  } else if (kind === 'pumpBack') {
    // 870 forend travelling on twin action bars: wood + steel, long scrape
    nz(0, 0.105, 0.20 * A, { atk: 0.006, shape: 1.1, bp: 1150, bpq: 0.85 });
    hit(0.030, { f0: 520, decay: 0.016, amp: 0.10 * A, click: 0.0012, hfDamp: 1.4, tilt: 1.5 });
    hit(0.100, { f0: R.f0 * 1.1, decay: 0.030, amp: 0.36 * A, click: 0.0026, hfDamp: 0.9, tilt: 1.1, clickHp: 550 });
    // spent hull flips out
    hit(0.078, { f0: 1100, decay: 0.055, amp: 0.09 * A, click: 0.0009, hfDamp: 1.6, tilt: 1.8, modeAmt: 0.2 });
  } else if (kind === 'pumpForward') {
    nz(0, 0.100, 0.19 * A, { atk: 0.005, shape: 1.1, bp: 1050, bpq: 0.85 });
    hit(0.094, { f0: R.f0 * 0.9, decay: 0.042, amp: 0.46 * A, click: 0.0030, hfDamp: 0.8, tilt: 1.05, clickHp: 480 });
    hit(0.099, { f0: 1450, decay: 0.011, amp: 0.16 * A, click: 0.0008, hfDamp: 1.5, tilt: 1.7 });
  } else if (kind === 'shellInsert') {
    nz(0, 0.055, 0.11 * A, { atk: 0.004, shape: 1.2, bp: 900, bpq: 0.8 });
    hit(0.050, { f0: 740, decay: 0.018, amp: 0.16 * A, click: 0.0014, hfDamp: 1.3, tilt: 1.5, modeAmt: 0.3 });
  } else if (kind === 'safety') {
    hit(0, { f0: R.f0 * 2.0, decay: 0.007, amp: 0.16 * A, click: 0.0006, hfDamp: 1.5, tilt: 1.7 });
  } else if (kind === 'sightClick') {
    hit(0, { f0: 2600, decay: 0.005, amp: 0.10 * A, click: 0.0004, hfDamp: 1.7, tilt: 1.9 });
  } else if (kind === 'stockFold') {
    nz(0, 0.080, 0.12 * A, { atk: 0.004, shape: 1.2, bp: 1400, bpq: 1.0 });
    hit(0.076, { f0: R.f0 * 1.2, decay: 0.028, amp: 0.30 * A, click: 0.0021, hfDamp: 1.0, tilt: 1.2 });
  } else if (kind === 'knifeSwing') {
    // air moved by a 178 mm blade — pure aerodynamic noise, no metal
    noiseBurst(dry, 0, sr, 0.150, 0.16 * A,
      { atk: 0.030, shape: 2.0, bp: 620, bpq: 0.55, tiltDb: -6, tiltHz: 900 }, rnd, n);
  } else if (kind === 'knifeHit') {
    hit(0, { f0: 1850, decay: 0.045, amp: 0.34 * A, click: 0.0013, hfDamp: 0.9, tilt: 1.1, modeAmt: 0.6 });
    noiseBurst(dry, 0, sr, 0.020, 0.13 * A, { atk: 0.0002, shape: 2.6, hp: 1800, lp: 12000 }, rnd, n);
  } else if (kind === 'sheathe') {
    noiseBurst(dry, 0, sr, 0.180, 0.15 * A,
      { atk: 0.010, shape: 1.1, bp: 2300, bpq: 0.7, tiltDb: -4, tiltHz: 3000 }, rnd, n);
    hit(0.170, { f0: 900, decay: 0.020, amp: 0.10 * A, click: 0.0012, hfDamp: 1.4, tilt: 1.6, modeAmt: 0.25 });
  } else {
    throw new Error('unknown mech ' + kind);
  }

  if (opt.dry !== false) {
    const D = new Float32Array(n); D.set(dry);
    bandLimit(D, sr, n); softClip(D, n);
    return { sr, n, channels: [D, D] };
  }
  // same room, lighter send — mechanics are close-mic'd relative to the blast
  const wetIn = new Float32Array(n);
  filterInto(wetIn, dry, biquad('lp', 5200, 0.707, sr), n);
  const tail = new Float32Array(n);
  fdnTail(tail, wetIn, sr, { rt60: env.rt60 * 0.7, size: env.size, damp: env.damp + 0.1, pre: env.pre }, n);
  const L = new Float32Array(n), Rc = new Float32Array(n);
  const wet = env.wet * 0.45;
  for (let i = 0; i < n; i++) { const d = dry[i], t = tail[i] * wet; L[i] = d + t; Rc[i] = d + t; }
  softClip(L, n); softClip(Rc, n);
  return { sr, n, channels: [L, Rc] };
}

/* ------------------------------------------------------------------ exports */

const ORDNANCE = {
  CARTRIDGE, WEAPONS, DEVICE, ENV,
  blastModel, renderShot, renderMech, renderRoomIR, bandLimit,
  firesAmmunition: (id) => !!(WEAPONS[id] && WEAPONS[id].cart),
  biquad, filterInto, rng,
};

if (typeof module !== 'undefined' && module.exports) module.exports = ORDNANCE;
if (typeof self !== 'undefined') self.ORDNANCE = ORDNANCE;
ORDNANCE.fdnTail = fdnTail;
ORDNANCE.noiseBurst = noiseBurst;
ORDNANCE.addImpact = addImpact;
ORDNANCE.addFriedlander = addFriedlander;
