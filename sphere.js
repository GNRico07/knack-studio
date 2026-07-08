/**
 * KNACK_STUDIOS — Particle Sphere
 * Pure Canvas 2D — no dependencies
 * Orange dot cloud with depth grading + mouse self-heal effect
 */
(function () {
  const canvas = document.getElementById('hero-sphere');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  /* ── CONFIG ─────────────────────────────────────── */
  const N          = 1800;   // number of dots
  const SPRING     = 0.038;  // how fast dots snap back
  const DAMPING    = 0.80;   // velocity friction
  const MOUSE_R    = 0.18;   // cursor influence radius (fraction of sphere R)
  const PUSH_F     = 0.055;  // push strength
  const ROT_SPEED  = 0.0022; // auto-rotation speed

  /* ── STATE ──────────────────────────────────────── */
  let W, H, cx, cy, R, mR;
  let rotY = 0;
  const mouse = { x: -9999, y: -9999 };

  /* ── FIBONACCI SPHERE ───────────────────────────── */
  // Evenly distributes N points on a unit sphere
  const pts = (function () {
    const out = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y     = 1 - (i / (N - 1)) * 2;
      const r     = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      out.push({
        ox: Math.cos(theta) * r,
        oy: y,
        oz: Math.sin(theta) * r,
        dx: 0, dy: 0,
        vx: 0, vy: 0,
        glow: 0,
        twinkle: 0,          // 0 = off, >0 = brightness boost
        twinkleDir: 0,       // 1 = rising, -1 = falling
        twinkleTimer: Math.random() * 300  // stagger initial triggers
      });
    }
    return out;
  })();

  /* ── RESIZE ─────────────────────────────────────── */
  function resize() {
    W  = canvas.clientWidth  || 400;
    H  = canvas.clientHeight || 400;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = W / 2;
    cy = H / 2;
    R  = Math.min(W, H) * 0.28;
    mR = R * MOUSE_R;
  }

  /* ── ANIMATION LOOP ─────────────────────────────── */
  function frame() {
    requestAnimationFrame(frame);
    rotY += ROT_SPEED;
    ctx.clearRect(0, 0, W, H);

    const cosY = Math.cos(rotY);
    const sinY = Math.sin(rotY);

    // Build projected list
    const list = pts.map(p => {
      // Rotate original position around Y axis
      const rx =  p.ox * cosY + p.oz * sinY;
      const ry =  p.oy;
      const rz = -p.ox * sinY + p.oz * cosY;

      // Perspective projection
      const fov   = 2.8;
      const scale = fov / (fov + rz + 1);
      const px    = cx + rx * R * scale + p.dx;
      const py    = cy + ry * R * scale + p.dy;

      return { p, px, py, rz, scale };
    });

    // Mouse push + glow trigger (screen-space)
    list.forEach(({ p, px, py }) => {
      const dx   = px - mouse.x;
      const dy   = py - mouse.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < mR && dist > 0.1) {
        const force = (1 - dist / mR) * PUSH_F * R;
        p.vx += (dx / dist) * force;
        p.vy += (dy / dist) * force;
        // Light up instantly on contact
        p.glow = Math.min(1, p.glow + 0.25);
      } else {
        // Fade back smoothly when out of range
        p.glow = Math.max(0, p.glow - 0.04);
      }
    });

    // Spring + damping for displacement
    pts.forEach(p => {
      p.vx = (p.vx - p.dx * SPRING) * DAMPING;
      p.vy = (p.vy - p.dy * SPRING) * DAMPING;
      p.dx += p.vx;
      p.dy += p.vy;

      // Twinkle logic
      p.twinkleTimer--;
      if (p.twinkleTimer <= 0 && p.twinkleDir === 0) {
        // Reduced to ~0.08% of dots per frame — much more sparse
        if (Math.random() < 0.0008) {
          p.twinkleDir = 1;
          p.twinkleTimer = 0;
        } else {
          p.twinkleTimer = 5;
        }
      }
      if (p.twinkleDir === 1) {
        p.twinkle += 0.06;
        if (p.twinkle >= 1) { p.twinkle = 1; p.twinkleDir = -1; }
      } else if (p.twinkleDir === -1) {
        p.twinkle -= 0.035;
        if (p.twinkle <= 0) {
          p.twinkle = 0; p.twinkleDir = 0;
          // Longer rest between twinkles
          p.twinkleTimer = 180 + Math.random() * 480;
        }
      }
    });

    // Sort back-to-front so near dots render on top
    list.sort((a, b) => a.rz - b.rz);

    // Draw dots
    list.forEach(({ px, py, rz, scale, p }) => {
      // depth t: 0 = back, 1 = front
      const t = (rz + 1) / 2;

      // Size: tiny at back, visible at front
      const dotR = Math.max(0.25, (0.6 + t * 2.6) * scale);

      // Alpha: nearly invisible at back, full at front
      const alpha = 0.08 + t * 0.92;

      // Base depth color
      const br = Math.round(30  + (255 - 30)  * t);
      const bg = Math.round(38  + (59  - 38)  * t);
      const bb = Math.round(60  + (0   - 60)  * t);

      // Glow color: bright white-orange
      const gr = 255, gg = 160, gb = 60;

      // Combine cursor glow + twinkle (twinkle is subtler)
      const g = Math.min(1, p.glow + p.twinkle * 0.22);
      const tw = p.twinkle;
      const r = Math.round(br + (gr - br) * g);
      const gv = Math.round(bg + (gg - bg) * g);
      const b = Math.round(bb + (gb - bb) * g);
      const a = alpha + g * (1 - alpha);

      // Glow halo — larger and brighter when lit
      const glowThresh = t > 0.55 ? t : 0;
      const glowIntensity = Math.max(glowThresh, g);
      // Twinkle gets a smaller, crisper halo than cursor glow
      const twinkleHalo = tw * 0.10;
      if (glowIntensity > 0.15 || twinkleHalo > 0.05) {
        const gR = dotR * (3.5 + g * 4 + tw * 1.5);
        const grd = ctx.createRadialGradient(px, py, 0, px, py, gR);
        const ga = glowIntensity > 0.55
          ? (glowIntensity - 0.55) / 0.45 * (0.18 + g * 0.35)
          : g * 0.4;
        const finalGa = Math.max(ga, twinkleHalo);
        grd.addColorStop(0, `rgba(255,${140 + Math.round(g * 80)},${Math.round(g * 20)},${finalGa})`);
        grd.addColorStop(1, 'rgba(255,59,0,0)');
        ctx.beginPath();
        ctx.arc(px, py, gR, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();
      }

      // Core dot
      ctx.beginPath();
      ctx.arc(px, py, dotR * (1 + g * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${gv},${b},${a})`;
      ctx.fill();
    });
  }

  /* ── EVENTS ─────────────────────────────────────── */
  window.addEventListener('mousemove', e => {
    const rect  = canvas.getBoundingClientRect();
    mouse.x = e.clientX - rect.left;
    mouse.y = e.clientY - rect.top;
  });

  // Touch support
  canvas.addEventListener('touchmove', e => {
    const rect  = canvas.getBoundingClientRect();
    const t     = e.touches[0];
    mouse.x = t.clientX - rect.left;
    mouse.y = t.clientY - rect.top;
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchend', () => {
    mouse.x = -9999; mouse.y = -9999;
  });

  window.addEventListener('resize', () => { resize(); });

  /* ── INIT ───────────────────────────────────────── */
  resize();

  // Fade in after page settles
  canvas.style.opacity = '0';
  canvas.style.transition = 'opacity 1.2s ease';
  setTimeout(() => {
    canvas.style.opacity = '1';
    frame();
  }, 700);

})();
