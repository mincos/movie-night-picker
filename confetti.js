// Tiny dependency-free confetti burst, themed to the app's palette.
// No library, no build step — just a fixed canvas that cleans itself up.

const COLORS = ['#E3AE4C', '#F3ECDD', '#5B8C6E', '#C1443C', '#A9853F'];
const GRAVITY = 0.28;
const FADE = 0.006;

let canvas = null;
let ctx = null;
let pieces = [];
let raf = null;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.id = 'confetti-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
}

function spawnBurst(x, y, angle, count) {
  for (let i = 0; i < count; i++) {
    const a = angle + (Math.random() - 0.5) * 0.9;
    const speed = 9 + Math.random() * 9;
    pieces.push({
      x, y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      size: 5 + Math.random() * 6,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      rot: Math.random() * Math.PI,
      vrot: (Math.random() - 0.5) * 0.3,
      life: 1,
      ribbon: Math.random() < 0.35,
    });
  }
}

function frame() {
  const w = window.innerWidth, h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);

  pieces = pieces.filter(p => p.life > 0 && p.y < h + 40);

  for (const p of pieces) {
    p.vy += GRAVITY;
    p.vx *= 0.99;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vrot;
    p.life -= FADE;

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    if (p.ribbon) ctx.fillRect(-p.size / 2, -p.size / 6, p.size, p.size / 3);
    else ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
    ctx.restore();
  }

  if (pieces.length) {
    raf = requestAnimationFrame(frame);
  } else {
    ctx.clearRect(0, 0, w, h);
    raf = null;
  }
}

// Fires two angled bursts from the bottom corners, then a smaller second wave.
export function celebrate() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  ensureCanvas();
  const w = window.innerWidth, h = window.innerHeight;
  const count = w < 500 ? 45 : 70;

  spawnBurst(0, h, -Math.PI / 3, count);
  spawnBurst(w, h, -2 * Math.PI / 3, count);
  if (!raf) raf = requestAnimationFrame(frame);

  setTimeout(() => {
    spawnBurst(w * 0.5, h, -Math.PI / 2, Math.round(count * 0.6));
    if (!raf) raf = requestAnimationFrame(frame);
  }, 280);
}
