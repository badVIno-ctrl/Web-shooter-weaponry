/* ============================================================================
   ORDNANCE runtime — browser side.

   Owns an AudioContext, pre-renders every cue with the offline synthesis in
   ordnance-audio.js, and plays them back as plain AudioBufferSourceNodes.

   Why pre-render instead of building a node graph per shot, which is what the
   files did before:

     - the shock front can be a single-sample discontinuity. A WebAudio
       `exponentialRampToValueAtTime` over 1.2 ms is a 396 us rise; measured,
       that is the difference between a gunshot and a drum.
     - no oscillator ever runs, so no cue can be tonal by construction.
     - firing cost drops to one buffer source. A 1200 rpm Glock spawning 30
       filter/oscillator graphs a second is what makes the old approach crackle.

   Variants exist so sustained fire does not machine-gun the identical sample.
   Rendering is progressive: the first shot variant is ready before the first
   trigger pull, the rest arrive during idle time.
   ========================================================================== */

(function (root) {
  'use strict';
  const O = root.ORDNANCE;

  function Ordnance(weaponId, opt) {
    opt = opt || {};
    this.id = weaponId;
    this.env = opt.env || 'range';
    this.variants = opt.variants || 4;
    this.mechList = opt.mech || [];
    this.ctx = null;
    this.master = null;
    this.buffers = { shot: [], mech: {} };
    this.ready = false;
    this.muted = false;
    this.gain = opt.gain === undefined ? 0.42 : opt.gain;
    this._queue = [];
    this._n = 0;
    this._last = 0;
  }

  Ordnance.prototype.init = function () {
    if (this.ctx) return this.ctx;
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    const ctx = this.ctx = new AC();
    const m = this.master = ctx.createGain();
    m.gain.value = this.gain;
    /* One gentle limiter on the bus. The synthesis is already peak-controlled;
       this only catches several shots overlapping during automatic fire. */
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -9; comp.knee.value = 10; comp.ratio.value = 8;
    comp.attack.value = 0.002; comp.release.value = 0.16;
    m.connect(comp); comp.connect(ctx.destination);

    /* Room. The cues are rendered dry; the space is one shared impulse
       response through a native ConvolverNode. Baking the room into every
       variant cost 80 of the 101 ms it took to render a single shot. */
    this.dryBus = ctx.createGain(); this.dryBus.gain.value = 1;
    this.dryBus.connect(m);
    this.wetBus = ctx.createGain(); this.wetBus.gain.value = 0;   // until the IR lands
    this.conv = ctx.createConvolver();
    this.conv.normalize = false;
    this.wetBus.connect(this.conv); this.conv.connect(m);

    /* First variant synchronously: the user may fire on the same gesture that
       created the context, and a missing first shot is worse than 20 ms.
       A blade has no cartridge, so it has no blast to render. */
    this.armed = O.firesAmmunition(this.id);
    if (this.armed) {
      this._render('shot', 0);
      for (let v = 1; v < this.variants; v++) this._queue.push(['shot', v]);
    }
    for (const k of this.mechList) { this._queue.push(['mech', k, 0]); this._queue.push(['mech', k, 1]); }
    this._queue.push(['room']);          // last: dry-only for the first moments
    this._drain();
    return ctx;
  };

  Ordnance.prototype._toBuffer = function (r) {
    const b = this.ctx.createBuffer(2, r.n, r.sr);
    b.copyToChannel ? b.copyToChannel(r.channels[0], 0) : b.getChannelData(0).set(r.channels[0]);
    b.copyToChannel ? b.copyToChannel(r.channels[1], 1) : b.getChannelData(1).set(r.channels[1]);
    return b;
  };

  Ordnance.prototype._render = function (kind, a, b) {
    const sr = this.ctx.sampleRate;
    if (kind === 'room') {
      const ir = O.renderRoomIR(sr, this.env);
      this.conv.buffer = this._toBuffer(ir);
      this.wetBus.gain.value = ir.wet;
      return;
    }
    if (kind === 'shot') {
      this.buffers.shot[a] = this._toBuffer(
        O.renderShot(sr, this.id, { seed: 1000 + a * 37, env: this.env, dur: 1.5 }));
    } else {
      (this.buffers.mech[a] || (this.buffers.mech[a] = []))[b] = this._toBuffer(
        O.renderMech(sr, this.id, a, { seed: 500 + b * 91, env: this.env, dur: 0.8 }));
    }
  };

  Ordnance.prototype._drain = function () {
    if (!this._queue.length) { this.ready = true; return; }
    /* requestIdleCallback alone is not enough: a page already rendering flat
       out never becomes idle, and the remaining cues never appear. Whichever
       of the two fires first wins, and the other is cancelled. */
    const self = this;
    let done = false;
    const step = function () {
      if (done) return;
      done = true;
      const t0 = (root.performance || Date).now();
      do {
        const j = self._queue.shift();
        try { self._render(j[0], j[1], j[2]); } catch (e) { /* a missing cue must not kill the page */ }
      } while (self._queue.length && (root.performance || Date).now() - t0 < 12);
      self._drain();
    };
    if (root.requestIdleCallback) root.requestIdleCallback(step, { timeout: 120 });
    setTimeout(step, 150);
  };

  Ordnance.prototype.shot = function (o) {
    if (this.muted || !this.init() || !this.armed) return;
    o = o || {};
    const bs = this.buffers.shot.filter(Boolean);
    if (!bs.length) return;
    // never the same variant twice in a row
    let i = (Math.random() * bs.length) | 0;
    if (bs.length > 1 && i === this._last) i = (i + 1) % bs.length;
    this._last = i;
    const s = this.ctx.createBufferSource();
    s.buffer = bs[i];
    s.playbackRate.value = 1 + (Math.random() - 0.5) * 0.035;
    const g = this.ctx.createGain();
    g.gain.value = (o.gain === undefined ? 1 : o.gain) * (0.94 + Math.random() * 0.12);
    s.connect(g); g.connect(this.dryBus); g.connect(this.wetBus);
    s.start(this.ctx.currentTime + (o.delay || 0));
  };

  Ordnance.prototype.mech = function (kind, o) {
    if (this.muted || !this.init()) return;
    o = o || {};
    const v = this.buffers.mech[kind];
    if (!v || !v.length) return;
    const b = v[(Math.random() * v.length) | 0] || v[0];
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.playbackRate.value = 1 + (Math.random() - 0.5) * 0.06;
    const g = this.ctx.createGain();
    g.gain.value = (o.gain === undefined ? 1 : o.gain) * (0.92 + Math.random() * 0.16);
    s.connect(g); g.connect(this.dryBus);
    // mechanics are close to the ear relative to the blast: less room on them
    const w = this.ctx.createGain(); w.gain.value = 0.45;
    g.connect(w); w.connect(this.wetBus);
    s.start(this.ctx.currentTime + (o.delay || 0));
  };

  Ordnance.prototype.setMuted = function (m) {
    this.muted = !!m;
    if (this.master) this.master.gain.value = m ? 0 : this.gain;
  };

  Ordnance.prototype.resume = function () {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  };

  root.Ordnance = Ordnance;
})(typeof self !== 'undefined' ? self : this);
