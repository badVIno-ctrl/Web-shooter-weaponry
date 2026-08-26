/* The synthesis currently shipped in the repo's ak74.html, reimplemented
   offline so it can be measured with the identical instrument as the new
   engine. Two oscillator sweeps (152->43 Hz sine, 94->37 Hz triangle) plus
   band-passed continuous noise with 1.2 ms exponential gain ramps. */
function renderLegacy(sr) {
  const n = Math.round(2.0 * sr);
  const out = new Float32Array(n);
  const rnd = O.rng(3);
  const nb = new Float32Array(Math.round(2.2 * sr));
  { let last = 0; for (let i = 0; i < nb.length; i++) { const w = rnd() * 2 - 1; last = 0.86 * last + 0.14 * w; nb[i] = w * 0.72 + last * 0.55; } }
  const nz = (t0, dur, o) => {
    const i0 = Math.round(t0 * sr), len = Math.round(dur * sr);
    const tmp = new Float32Array(len);
    const off = Math.round(rnd() * 1.6 * sr);
    for (let k = 0; k < len; k++) tmp[k] = nb[(off + k) % nb.length];
    if (o.type) {
      const q = new Float32Array(len);
      O.filterInto(q, tmp, O.biquad(o.type === 'highpass' ? 'hp' : o.type === 'lowpass' ? 'lp' : 'bp', o.freq, o.q === undefined ? 1 : o.q, sr), len);
      tmp.set(q);
    }
    const atk = Math.max(1, Math.round((o.atk === undefined ? 0.0012 : o.atk) * sr));
    const pk = o.gain === undefined ? 0.3 : o.gain;
    for (let k = 0; k < len; k++) {
      const g = k < atk ? 0.0004 * Math.pow(pk / 0.0004, k / atk)
        : pk * Math.pow(0.0004 / pk, (k - atk) / (len - atk));
      if (i0 + k < n) out[i0 + k] += tmp[k] * g;
    }
  };
  const osc = (t0, dur, f0, f1, gain, type) => {
    const i0 = Math.round(t0 * sr), len = Math.round(dur * sr);
    let ph = 0;
    const atk = Math.max(1, Math.round(0.0015 * sr));
    for (let k = 0; k < len; k++) {
      const u = k / len;
      const f = f1 && f1 !== f0 ? f0 * Math.pow(Math.max(20, f1) / f0, u) : f0;
      ph += 2 * Math.PI * f / sr;
      const s = type === 'triangle' ? (2 / Math.PI) * Math.asin(Math.sin(ph)) : Math.sin(ph);
      const g = k < atk ? 0.0004 * Math.pow(gain / 0.0004, k / atk)
        : gain * Math.pow(0.0004 / gain, (k - atk) / (len - atk));
      if (i0 + k < n) out[i0 + k] += s * g;
    }
  };
  const t = 0, p = 1, v = 1;
  nz(t, 0.010, { type: 'highpass', freq: 2900 * p, q: 0.6, gain: 0.62 * v, atk: 0.0005 });
  nz(t + 0.0007, 0.080, { type: 'bandpass', freq: 760 * p, q: 0.7, gain: 1.05 * v, atk: 0.0009 });
  nz(t + 0.001, 0.030, { type: 'bandpass', freq: 1780 * p, q: 1.0, gain: 0.46 * v, atk: 0.0007 });
  nz(t + 0.002, 0.270, { type: 'lowpass', freq: 205, q: 0.9, gain: 0.66 * v, atk: 0.0045 });
  osc(t + 0.001, 0.170, 152 * p, 43, 0.52 * v, 'sine');
  osc(t + 0.0015, 0.090, 94 * p, 37, 0.34 * v, 'triangle');
  nz(t + 0.030, 0.520, { type: 'lowpass', freq: 760, q: 0.6, gain: 0.13, atk: 0.022 });
  nz(t + 0.022, 0.028, { type: 'bandpass', freq: 2400, q: 1.7, gain: 0.15 });
  nz(t + 0.058, 0.042, { type: 'bandpass', freq: 1450, q: 1.2, gain: 0.20 });
  osc(t + 0.059, 0.055, 235, 118, 0.10, 'triangle');
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] /= pk || 1;
  return out;
}
