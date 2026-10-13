/**
 * KNACK_STUDIOS — Particle Sphere
 * Pure Canvas 2D — no dependencies
 * Orange dot cloud with depth grading + mouse self-heal effect
 *
 * Performance / robustness:
 *  - Zero allocation inside the animation loop: typed-array state, an O(N)
 *    counting sort by depth, a pre-built color lookup table, and pre-rendered
 *    glow sprites (no per-dot gradient objects or color strings per frame).
 *  - Only renders while the canvas is on screen (IntersectionObserver) and the
 *    tab is visible (visibilitychange).
 *  - Resizes via ResizeObserver on the container, batched to one update per frame.
 *  - Pixel ratio capped at 2 (1.5 on touch devices); fewer dots on touch devices.
 *  - Survives zero-size containers and canvas context loss without throwing.
 *  - prefers-reduced-motion: renders a still sphere (no rotation / twinkle).
 *  - window.KnackSphere.destroy() removes every listener/observer and frees memory.
 */
(function () {
  'use strict';

  const canvas = document.getElementById('hero-sphere');
  if (!canvas || window.KnackSphere) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const container = canvas.parentElement || canvas;
  const mq = q => (window.matchMedia ? window.matchMedia(q) : { matches: false });
  const TOUCH   = mq('(hover: none), (pointer: coarse)').matches;
  const REDUCED = mq('(prefers-reduced-motion: reduce)');

  /* ── CONFIG ─────────────────────────────────────── */
  const N          = TOUCH ? 1100 : 1800; // number of dots (same visual density on the smaller mobile sphere)
  const SPRING     = 0.038;  // how fast dots snap back
  const DAMPING    = 0.80;   // velocity friction
  const MOUSE_R    = 0.18;   // cursor influence radius (fraction of sphere R)
  const PUSH_F     = 0.055;  // push strength
  const ROT_SPEED  = 0.0022; // auto-rotation speed (per 60fps frame)
  const FOV        = 2.8;
  const MAX_DPR    = TOUCH ? 1.5 : 2;
  const DEPTH_LV   = 64;     // depth buckets (sorting + color LUT)
  const GLOW_LV    = 16;     // glow quantization steps
  const SPRITE     = 64;     // glow sprite size (px)

  /* ── STATE (typed arrays — allocated once) ──────── */
  const ox = new Float32Array(N), oy = new Float32Array(N), oz = new Float32Array(N);
  const dx = new Float32Array(N), dy = new Float32Array(N);
  const vx = new Float32Array(N), vy = new Float32Array(N);
  const glow = new Float32Array(N), twinkle = new Float32Array(N);
  const twinkleDir = new Int8Array(N), twinkleTimer = new Float32Array(N);
  const px = new Float32Array(N), py = new Float32Array(N);
  const pz = new Float32Array(N), ps = new Float32Array(N);
  const bucket = new Uint8Array(N), order = new Uint16Array(N);
  const counts = new Uint32Array(DEPTH_LV + 1);

  let W = 0, H = 0, cx = 0, cy = 0, R = 0, mR = 0;
  let rotY = 0, lastT = 0, rafId = 0, resizeQueued = 0;
  let inView = true, started = false, contextLost = false, destroyed = false;
  let pointerActive = false, pointerX = 0, pointerY = 0; // client coords
  let mouseX = -9999, mouseY = -9999;                     // canvas coords

  /* ── FIBONACCI SPHERE ───────────────────────────── */
  // Evenly distributes N points on a unit sphere
  (function () {
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      ox[i] = Math.cos(theta) * r;
      oy[i] = y;
      oz[i] = Math.sin(theta) * r;
      twinkleTimer[i] = Math.random() * 300; // stagger initial triggers
    }
  })();

  /* ── COLOR LUT (depth × glow → fillStyle string) ── */
  const FILL = new Array(DEPTH_LV * (GLOW_LV + 1));
  (function () {
    const gr = 255, gg = 160, gb = 60; // glow color: bright white-orange
    for (let b = 0; b < DEPTH_LV; b++) {
      const t = (b + 0.5) / DEPTH_LV;
      const alpha = 0.08 + t * 0.92;
      const br = 30 + (255 - 30) * t;
      const bg = 38 + (59 - 38) * t;
      const bb = 60 + (0 - 60) * t;
      for (let q = 0; q <= GLOW_LV; q++) {
        const g = q / GLOW_LV;
        const r  = Math.round(br + (gr - br) * g);
        const gv = Math.round(bg + (gg - bg) * g);
        const bl = Math.round(bb + (gb - bb) * g);
        const a  = (alpha + g * (1 - alpha)).toFixed(3);
        FILL[b * (GLOW_LV + 1) + q] = `rgba(${r},${gv},${bl},${a})`;
      }
    }
  })();

  /* ── GLOW SPRITES (replace per-dot radial gradients) ── */
  // Each sprite is the original halo gradient at full alpha; the per-dot
  // halo alpha is applied with globalAlpha, which is mathematically identical.
  let sprites = [];
  function buildSprites() {
    sprites = [];
    for (let q = 0; q <= GLOW_LV; q++) {
      const g = q / GLOW_LV;
      const c = document.createElement('canvas');
      c.width = c.height = SPRITE;
      const sctx = c.getContext('2d');
      if (!sctx) { sprites = []; return; }
      const h = SPRITE / 2;
      const grd = sctx.createRadialGradient(h, h, 0, h, h, h);
      grd.addColorStop(0, `rgba(255,${140 + Math.round(g * 80)},${Math.round(g * 20)},1)`);
      grd.addColorStop(1, 'rgba(255,59,0,0)');
      sctx.fillStyle = grd;
      sctx.fillRect(0, 0, SPRITE, SPRITE);
      sprites.push(c);
    }
  }
  buildSprites();

  /* ── RESIZE ─────────────────────────────────────── */
  function measure() {
    resizeQueued = 0;
    if (destroyed || contextLost) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) { W = H = 0; syncLoop(); return; } // zero-size: park until it has a size
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    W = w; H = h;
    cx = W / 2;
    cy = H / 2;
    // Larger on tablet/phone where the sphere has its own full-width panel
    R  = Math.min(W, H) * (W < 1025 ? 0.36 : 0.28);
    mR = R * MOUSE_R;
    if (!rafId && started) render(false); // keep a correct still frame while paused
    syncLoop();
  }
  function queueResize() {
    if (!resizeQueued && !destroyed) resizeQueued = requestAnimationFrame(measure);
  }

  /* ── RENDER ─────────────────────────────────────── */
  function render(animate) {
    if (!W || !H) return;
    const cosY = Math.cos(rotY);
    const sinY = Math.sin(rotY);

    // Pointer → canvas space (one layout read per frame, only while the pointer is active)
    if (pointerActive) {
      const rect = canvas.getBoundingClientRect();
      mouseX = pointerX - rect.left;
      mouseY = pointerY - rect.top;
    } else {
      mouseX = mouseY = -9999;
    }

    ctx.clearRect(0, 0, W, H);
    counts.fill(0);

    for (let i = 0; i < N; i++) {
      // Rotate around Y + perspective projection
      const rx =  ox[i] * cosY + oz[i] * sinY;
      const rz = -ox[i] * sinY + oz[i] * cosY;
      const scale = FOV / (FOV + rz + 1);
      const x = cx + rx * R * scale + dx[i];
      const y = cy + oy[i] * R * scale + dy[i];
      px[i] = x; py[i] = y; pz[i] = rz; ps[i] = scale;

      let b = ((rz + 1) * 0.5 * DEPTH_LV) | 0;
      if (b < 0) b = 0; else if (b >= DEPTH_LV) b = DEPTH_LV - 1;
      bucket[i] = b;
      counts[b + 1]++;

      if (!animate) continue;

      // Mouse push + glow trigger (screen-space)
      const mdx = x - mouseX, mdy = y - mouseY;
      const dist = Math.sqrt(mdx * mdx + mdy * mdy);
      if (dist < mR && dist > 0.1) {
        const force = (1 - dist / mR) * PUSH_F * R;
        vx[i] += (mdx / dist) * force;
        vy[i] += (mdy / dist) * force;
        glow[i] = Math.min(1, glow[i] + 0.25); // light up instantly on contact
      } else {
        glow[i] = Math.max(0, glow[i] - 0.04); // fade back smoothly
      }

      // Spring + damping for displacement
      vx[i] = (vx[i] - dx[i] * SPRING) * DAMPING;
      vy[i] = (vy[i] - dy[i] * SPRING) * DAMPING;
      dx[i] += vx[i];
      dy[i] += vy[i];

      // Twinkle — sparse, ~0.08% of resting dots per frame
      twinkleTimer[i]--;
      if (twinkleTimer[i] <= 0 && twinkleDir[i] === 0) {
        if (Math.random() < 0.0008) { twinkleDir[i] = 1; twinkleTimer[i] = 0; }
        else twinkleTimer[i] = 5;
      }
      if (twinkleDir[i] === 1) {
        twinkle[i] += 0.06;
        if (twinkle[i] >= 1) { twinkle[i] = 1; twinkleDir[i] = -1; }
      } else if (twinkleDir[i] === -1) {
        twinkle[i] -= 0.035;
        if (twinkle[i] <= 0) {
          twinkle[i] = 0; twinkleDir[i] = 0;
          twinkleTimer[i] = 180 + Math.random() * 480; // longer rest between twinkles
        }
      }
    }

    // Counting sort back-to-front (O(N), no allocation)
    for (let b = 1; b <= DEPTH_LV; b++) counts[b] += counts[b - 1];
    for (let i = 0; i < N; i++) order[counts[bucket[i]]++] = i;

    const haveSprites = sprites.length === GLOW_LV + 1;
    for (let k = 0; k < N; k++) {
      const i = order[k];
      const x = px[i], y = py[i], scale = ps[i];
      const t = (pz[i] + 1) / 2; // depth: 0 = back, 1 = front

      // Size: tiny at back, visible at front
      const dotR = Math.max(0.25, (0.6 + t * 2.6) * scale);

      // Combine cursor glow + twinkle (twinkle is subtler)
      const tw = twinkle[i];
      const g = Math.min(1, glow[i] + tw * 0.22);
      const q = Math.round(g * GLOW_LV);

      // Glow halo — larger and brighter when lit
      const glowIntensity = Math.max(t > 0.55 ? t : 0, g);
      const twinkleHalo = tw * 0.10; // twinkle gets a smaller, crisper halo
      if (haveSprites && (glowIntensity > 0.15 || twinkleHalo > 0.05)) {
        const ga = glowIntensity > 0.55
          ? (glowIntensity - 0.55) / 0.45 * (0.18 + g * 0.35)
          : g * 0.4;
        const finalGa = ga > twinkleHalo ? ga : twinkleHalo;
        if (finalGa > 0.002) {
          const gR = dotR * (3.5 + g * 4 + tw * 1.5);
          ctx.globalAlpha = finalGa > 1 ? 1 : finalGa;
          ctx.drawImage(sprites[q], x - gR, y - gR, gR * 2, gR * 2);
          ctx.globalAlpha = 1;
        }
      }

      // Core dot
      ctx.beginPath();
      ctx.arc(x, y, dotR * (1 + g * 0.5), 0, 6.283185307179586);
      ctx.fillStyle = FILL[bucket[i] * (GLOW_LV + 1) + q];
      ctx.fill();
    }
  }

  /* ── LOOP CONTROL ───────────────────────────────── */
  function tick(now) {
    rafId = requestAnimationFrame(tick);
    const dt = lastT ? Math.min(now - lastT, 50) : 16.667;
    lastT = now;
    rotY += ROT_SPEED * (dt / 16.667); // frame-rate independent rotation (same speed on 120Hz)
    render(true);
  }
  function shouldRun() {
    return started && !destroyed && !contextLost && inView && !document.hidden &&
           W > 0 && H > 0 && !REDUCED.matches;
  }
  function syncLoop() {
    if (shouldRun()) {
      if (!rafId) { lastT = 0; rafId = requestAnimationFrame(tick); }
    } else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  /* ── EVENTS ─────────────────────────────────────── */
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const opt = passive => (ac ? { passive, signal: ac.signal } : { passive });
  const listeners = []; // fallback teardown list when AbortController is unavailable
  function on(target, type, fn, passive) {
    target.addEventListener(type, fn, opt(passive !== false));
    if (!ac) listeners.push([target, type, fn]);
  }

  on(window, 'mousemove', e => { pointerActive = true; pointerX = e.clientX; pointerY = e.clientY; });
  on(document.documentElement, 'mouseleave', () => { pointerActive = false; });
  on(window, 'blur', () => { pointerActive = false; });

  // Touch — passive, so a finger on the sphere never blocks page scrolling
  function touchAt(e) {
    const t = e.touches[0];
    if (!t) return;
    pointerActive = true; pointerX = t.clientX; pointerY = t.clientY;
  }
  function touchEnd() { pointerActive = false; }
  on(canvas, 'touchstart', touchAt);
  on(canvas, 'touchmove', touchAt);
  on(canvas, 'touchend', touchEnd);
  on(canvas, 'touchcancel', touchEnd);

  on(document, 'visibilitychange', syncLoop);
  on(window, 'resize', queueResize); // devicePixelRatio changes (zoom / moving between screens)

  // Canvas 2D context loss (GPU reset, memory pressure)
  // (2D contexts restore automatically unless the event is cancelled, so don't preventDefault)
  on(canvas, 'contextlost', () => { contextLost = true; syncLoop(); });
  on(canvas, 'contextrestored', () => {
    contextLost = false;
    buildSprites();
    canvas.width = 0; // force a full re-measure
    measure();
  });

  const onReducedChange = () => { measure(); syncLoop(); };
  if (REDUCED.addEventListener) REDUCED.addEventListener('change', onReducedChange);

  let ro = null, io = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(queueResize);
    ro.observe(container);
    if (container !== canvas) ro.observe(canvas);
  }
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver(entries => {
      inView = entries[entries.length - 1].isIntersecting;
      syncLoop();
    }, { rootMargin: '100px 0px' });
    io.observe(canvas);
  }

  /* ── TEARDOWN ───────────────────────────────────── */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (rafId) cancelAnimationFrame(rafId);
    if (resizeQueued) cancelAnimationFrame(resizeQueued);
    rafId = resizeQueued = 0;
    clearTimeout(fadeTimer);
    if (ac) ac.abort();
    listeners.forEach(([t, type, fn]) => t.removeEventListener(type, fn));
    listeners.length = 0;
    if (REDUCED.removeEventListener) REDUCED.removeEventListener('change', onReducedChange);
    if (ro) ro.disconnect();
    if (io) io.disconnect();
    sprites.forEach(c => { c.width = c.height = 0; });
    sprites = [];
    canvas.width = canvas.height = 0;
    delete window.KnackSphere;
  }
  window.KnackSphere = { destroy };

  /* ── INIT ───────────────────────────────────────── */
  measure();

  // Fade in after page settles
  canvas.style.opacity = '0';
  canvas.style.transition = 'opacity 1.2s ease';
  const fadeTimer = setTimeout(() => {
    started = true;
    measure();               // re-measure now that layout is final (also paints a first frame)
    canvas.style.opacity = '1';
  }, 700);
})();
