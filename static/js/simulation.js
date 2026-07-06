/**
 * Smart Traffic Light System — Canvas Renderer v3
 * ================================================
 * All physics/logic → Python backend (app.py)
 * This file ONLY renders state received from /api/state
 *
 * New in v3:
 *   - Collision explosion & spin animation
 *   - Red-runner highlight (orange tint)
 *   - Free-left-turn badge (green arrow)
 *   - Crash counter on HUD
 *   - Updated formula display: queue × 2 s
 */

// ─── Canvas setup ─────────────────────────────────────────────────────────────
const canvas = document.getElementById('simCanvas');
const ctx    = canvas.getContext('2d');

const CANVAS_W  = 900;
const CANVAS_H  = 700;
const CX        = 450;
const CY        = 350;
const ROAD_HALF = 60;
const LANE_OFF  = 28;

canvas.width  = CANVAS_W;
canvas.height = CANVAS_H;

const LIGHT_POS = {
    N: { x: CX - ROAD_HALF - 14, y: CY - ROAD_HALF - 26, vert: true  },
    S: { x: CX + ROAD_HALF + 14, y: CY + ROAD_HALF + 26, vert: true  },
    E: { x: CX + ROAD_HALF + 26, y: CY + ROAD_HALF + 14, vert: false },
    W: { x: CX - ROAD_HALF - 26, y: CY - ROAD_HALF - 14, vert: false },
};

const DIR_COL = { N: '#5aa9e6', E: '#f4c430', S: '#ff9f1c', W: '#7fd8a6' };

let gState   = null;
let lastLogs = [];

// ─── API helpers ──────────────────────────────────────────────────────────────
async function pollState() {
    try {
        const r = await fetch('/api/state');
        gState  = await r.json();
        updateDashboard();
        appendNewLogs();
    } catch (_) {}
}
setInterval(pollState, 50);

async function sendAction(payload) {
    try {
        await fetch('/api/action', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } catch (_) {}
}

// ─── Road renderer ────────────────────────────────────────────────────────────
function drawRoads() {
    // Background
    ctx.fillStyle = '#1a2e1e';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Subtle grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth   = 1;
    for (let gx = 0; gx < CANVAS_W; gx += 40) {
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, CANVAS_H); ctx.stroke();
    }
    for (let gy = 0; gy < CANVAS_H; gy += 40) {
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(CANVAS_W, gy); ctx.stroke();
    }

    // Roads
    ctx.fillStyle = '#2b3039';
    ctx.fillRect(CX - ROAD_HALF, 0,             ROAD_HALF * 2, CANVAS_H);
    ctx.fillRect(0,              CY - ROAD_HALF, CANVAS_W,      ROAD_HALF * 2);

    // Intersection box
    ctx.fillStyle = '#333a44';
    ctx.fillRect(CX - ROAD_HALF, CY - ROAD_HALF, ROAD_HALF * 2, ROAD_HALF * 2);

    // Kerb lines
    ctx.strokeStyle = '#4a5260';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([]);
    [
        [CX-ROAD_HALF, 0,            CX-ROAD_HALF, CY-ROAD_HALF],
        [CX-ROAD_HALF, CY+ROAD_HALF, CX-ROAD_HALF, CANVAS_H   ],
        [CX+ROAD_HALF, 0,            CX+ROAD_HALF, CY-ROAD_HALF],
        [CX+ROAD_HALF, CY+ROAD_HALF, CX+ROAD_HALF, CANVAS_H   ],
        [0,            CY-ROAD_HALF, CX-ROAD_HALF, CY-ROAD_HALF],
        [CX+ROAD_HALF, CY-ROAD_HALF, CANVAS_W,     CY-ROAD_HALF],
        [0,            CY+ROAD_HALF, CX-ROAD_HALF, CY+ROAD_HALF],
        [CX+ROAD_HALF, CY+ROAD_HALF, CANVAS_W,     CY+ROAD_HALF],
    ].forEach(([x1,y1,x2,y2]) => {
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    });

    // Yellow dashed centrelines
    ctx.strokeStyle = '#c9a82a';
    ctx.lineWidth   = 1.8;
    ctx.setLineDash([14, 14]);
    [[CX, 0, CX, CY-ROAD_HALF],[CX, CY+ROAD_HALF, CX, CANVAS_H],
     [0, CY, CX-ROAD_HALF, CY],[CX+ROAD_HALF, CY, CANVAS_W, CY]].forEach(([x1,y1,x2,y2]) => {
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    });
    ctx.setLineDash([]);

    // Stop lines (LHT placement)
    ctx.strokeStyle = '#dde3ea';
    ctx.lineWidth   = 3;
    ctx.beginPath(); ctx.moveTo(CX, CY-ROAD_HALF);         ctx.lineTo(CX+ROAD_HALF, CY-ROAD_HALF); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(CX-ROAD_HALF, CY+ROAD_HALF); ctx.lineTo(CX, CY+ROAD_HALF);         ctx.stroke();
    ctx.beginPath(); ctx.moveTo(CX+ROAD_HALF, CY);         ctx.lineTo(CX+ROAD_HALF, CY+ROAD_HALF); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(CX-ROAD_HALF, CY-ROAD_HALF); ctx.lineTo(CX-ROAD_HALF, CY);         ctx.stroke();

    // Lane dividers (between inner and outer lanes)
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([8, 12]);
    [
        [CX + 30, 0, CX + 30, CY - ROAD_HALF],
        [CX + 30, CY + ROAD_HALF, CX + 30, CANVAS_H],
        [CX - 30, 0, CX - 30, CY - ROAD_HALF],
        [CX - 30, CY + ROAD_HALF, CX - 30, CANVAS_H],
        [0, CY + 30, CX - ROAD_HALF, CY + 30],
        [CX + ROAD_HALF, CY + 30, CANVAS_W, CY + 30],
        [0, CY - 30, CX - ROAD_HALF, CY - 30],
        [CX + ROAD_HALF, CY - 30, CANVAS_W, CY - 30],
    ].forEach(([x1,y1,x2,y2]) => {
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    });
    ctx.setLineDash([]);

    // Direction arrows (two arrows per approach for double lanes)
    drawArrow(CX+16, CY-ROAD_HALF-50, 0,          'rgba(255,255,255,0.13)');
    drawArrow(CX+44, CY-ROAD_HALF-50, 0,          'rgba(255,255,255,0.13)');

    drawArrow(CX-16, CY+ROAD_HALF+50, Math.PI,    'rgba(255,255,255,0.13)');
    drawArrow(CX-44, CY+ROAD_HALF+50, Math.PI,    'rgba(255,255,255,0.13)');

    drawArrow(CX+ROAD_HALF+50, CY+16, -Math.PI/2, 'rgba(255,255,255,0.13)');
    drawArrow(CX+ROAD_HALF+50, CY+44, -Math.PI/2, 'rgba(255,255,255,0.13)');

    drawArrow(CX-ROAD_HALF-50, CY-16,  Math.PI/2, 'rgba(255,255,255,0.13)');
    drawArrow(CX-ROAD_HALF-50, CY-44,  Math.PI/2, 'rgba(255,255,255,0.13)');
}

function drawArrow(x, y, angle, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -14); ctx.lineTo(-7, 5); ctx.lineTo(0, 0); ctx.lineTo(7, 5);
    ctx.closePath(); ctx.fill();
    ctx.restore();
}

// ─── Sensor zones ─────────────────────────────────────────────────────────────
function drawSensorZones(mode) {
    if (mode !== 'smart') return;
    const ZONE = 170;
    [
        { col: '#5aa9e6', x: CX,              y: CY-ROAD_HALF-ZONE, w: ROAD_HALF,  h: ZONE    },
        { col: '#ff9f1c', x: CX-ROAD_HALF,    y: CY+ROAD_HALF,      w: ROAD_HALF,  h: ZONE    },
        { col: '#f4c430', x: CX+ROAD_HALF,    y: CY,                w: ZONE,       h: ROAD_HALF },
        { col: '#7fd8a6', x: CX-ROAD_HALF-ZONE, y: CY-ROAD_HALF,    w: ZONE,       h: ROAD_HALF },
    ].forEach(z => {
        ctx.globalAlpha = 0.08;
        ctx.fillStyle   = z.col;
        ctx.fillRect(z.x, z.y, z.w, z.h);
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = z.col;
        ctx.lineWidth   = 1;
        ctx.setLineDash([5, 6]);
        ctx.strokeRect(z.x, z.y, z.w, z.h);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
    });
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.font      = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('SENSOR', CX + ROAD_HALF/2, CY - ROAD_HALF - ZONE + 14);
    ctx.fillText('SENSOR', CX - ROAD_HALF/2, CY + ROAD_HALF + ZONE - 6);
    ctx.textAlign = 'left';
    ctx.fillText('SENSOR', CX + ROAD_HALF + 4, CY - ROAD_HALF/2);
    ctx.fillText('SENSOR', CX - ROAD_HALF - ZONE + 4, CY + ROAD_HALF/2 - 4);
}

// ─── Traffic lights ───────────────────────────────────────────────────────────
function drawTrafficLights(signals) {
    if (!signals) return;
    ['N','E','S','W'].forEach(d => {
        const p = LIGHT_POS[d];
        drawOneLight(p.x, p.y, signals[d], p.vert, d);
    });
}

function drawOneLight(x, y, signal, vertical, dir) {
    const GAP = 13;
    ctx.strokeStyle = '#444c55';
    ctx.lineWidth   = 3;
    if (vertical) {
        ctx.beginPath(); ctx.moveTo(x, y+GAP+8); ctx.lineTo(x, y+GAP+28); ctx.stroke();
    } else {
        ctx.beginPath(); ctx.moveTo(x+GAP+8, y); ctx.lineTo(x+GAP+28, y); ctx.stroke();
    }
    const hw = vertical ? 14 : GAP*3+10;
    const hh = vertical ? GAP*3+10 : 14;
    ctx.fillStyle   = '#111820';
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth   = 1;
    rrect(ctx, x-hw/2, y-hh/2, hw, hh, 4); ctx.fill(); ctx.stroke();

    [
        { name:'red',    lit:'#e63946', dim:'#3d0a10', offs:-GAP },
        { name:'yellow', lit:'#f4c430', dim:'#3a2c06', offs:   0 },
        { name:'green',  lit:'#2ecc71', dim:'#093d20', offs:  GAP },
    ].forEach(b => {
        const bx = vertical ? x       : x+b.offs;
        const by = vertical ? y+b.offs : y;
        const on = b.name === signal;
        ctx.fillStyle = on ? b.lit : b.dim;
        ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI*2); ctx.fill();
        if (on) {
            ctx.shadowColor = b.lit; ctx.shadowBlur = 16;
            ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI*2); ctx.fill();
            ctx.shadowBlur = 0;
            const g = ctx.createRadialGradient(bx, by, 0, bx, by, 18);
            g.addColorStop(0, b.lit+'55'); g.addColorStop(1, b.lit+'00');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(bx, by, 18, 0, Math.PI*2); ctx.fill();
        }
    });

    ctx.fillStyle = DIR_COL[dir]+'cc';
    ctx.font      = 'bold 9px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(dir, vertical ? x-10 : x, vertical ? y+GAP+38 : y-10);
}

// ─── Vehicle renderer ─────────────────────────────────────────────────────────
function drawVehicles(vehicles) {
    if (!vehicles) return;
    vehicles.forEach(v => drawVehicle(v));
}

/** Draw a normally-operating vehicle. */
function drawVehicle(v) {
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.rotate(v.angle * Math.PI / 180);

    const w = v.w, h = v.h;

    // ── Red-runner highlight: orange/red tint aura ──
    if (v.runs_red && v.state === 'crossing') {
        const aura = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 2.5);
        aura.addColorStop(0, 'rgba(255,80,0,0.35)');
        aura.addColorStop(1, 'rgba(255,80,0,0)');
        ctx.fillStyle = aura;
        ctx.beginPath(); ctx.arc(0, 0, w * 2.5, 0, Math.PI*2); ctx.fill();
    }

    // ── Free-left-turn vehicle: subtle green glow ──
    if (v.is_free_left && v.state === 'crossing') {
        const ga = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 2);
        ga.addColorStop(0, 'rgba(0,255,120,0.22)');
        ga.addColorStop(1, 'rgba(0,255,120,0)');
        ctx.fillStyle = ga;
        ctx.beginPath(); ctx.arc(0, 0, w * 2, 0, Math.PI*2); ctx.fill();
    }

    // ── Headlight cone ──
    const hg = ctx.createRadialGradient(0, -h/2-2, 0, 0, -h/2-10, 38);
    hg.addColorStop(0, 'rgba(255,240,140,0.22)');
    hg.addColorStop(1, 'rgba(255,240,140,0)');
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.moveTo(-w*0.4, -h/2); ctx.lineTo(-w*1.8, -h/2-45);
    ctx.lineTo(w*1.8, -h/2-45); ctx.lineTo(w*0.4, -h/2);
    ctx.closePath(); ctx.fill();

    // ── Body ──
    ctx.fillStyle   = v.color;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth   = 1;
    rrect(ctx, -w/2, -h/2, w, h, 3); ctx.fill(); ctx.stroke();

    // ── Type-specific detail ──
    switch (v.vtype) {
        case 'car':
            ctx.fillStyle = 'rgba(160,225,255,0.22)';
            rrect(ctx, -w/2+1.5, -h/2+2, w-3, h/4, 1); ctx.fill();
            rrect(ctx, -w/2+1.5, h/4-1, w-3, h/5, 1); ctx.fill();
            break;
        case 'bike':
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI*2); ctx.fill();
            break;
        case 'auto':
            // Three-wheeler body detail
            ctx.fillStyle = 'rgba(255,220,100,0.3)';
            rrect(ctx, -w/2+1, -h/2+2, w-2, h/3, 1); ctx.fill();
            ctx.fillStyle = 'rgba(0,0,0,0.4)';
            ctx.beginPath(); ctx.arc(-w/3, h/2-2, 3, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.arc(w/3, h/2-2, 3, 0, Math.PI*2); ctx.fill();
            break;
        case 'bus': case 'truck':
            ctx.fillStyle = 'rgba(160,225,255,0.18)';
            rrect(ctx, -w/2+1.5, -h/2+2, w-3, h/7, 1); ctx.fill();
            for (let ry = -h/2+h/6; ry < h/2-6; ry += 8) {
                ctx.fillStyle = 'rgba(160,225,255,0.10)';
                ctx.fillRect(-w/2+1, ry, 2, 5);
                ctx.fillRect( w/2-3, ry, 2, 5);
            }
            break;
        case 'ambulance':
            ctx.fillStyle = '#e63946';
            ctx.fillRect(-1.5, -h/5, 3, h/2.5);
            ctx.fillRect(-w/3.5, -1.5, w/1.8, 3);
            ctx.fillStyle = 'rgba(255,80,80,0.5)';
            ctx.fillRect(-w/2+1, -1, w-2, 2);
            const sc = v.siren_on ? '#3b82f6' : '#e63946';
            ctx.shadowColor = sc; ctx.shadowBlur = 20;
            ctx.fillStyle   = sc;
            ctx.beginPath(); ctx.ellipse(0, -h/2+2, 4, 2.5, 0, 0, Math.PI*2); ctx.fill();
            ctx.shadowBlur = 0;
            const eg = ctx.createRadialGradient(0, -h/2, 0, 0, -h/2, 24);
            eg.addColorStop(0, sc+'66'); eg.addColorStop(1, sc+'00');
            ctx.fillStyle = eg;
            ctx.beginPath(); ctx.arc(0, -h/2, 24, 0, Math.PI*2); ctx.fill();
            break;
    }

    // ── Headlights (front) ──
    ctx.fillStyle = 'rgba(255,245,150,0.9)';
    ctx.beginPath(); ctx.arc(-w/3, -h/2+1.2, 1.3, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc( w/3, -h/2+1.2, 1.3, 0, Math.PI*2); ctx.fill();

    // ── Tail lights (rear — brighter when stopped) ──
    const rLit = v.speed < 2 ? 'rgba(255,40,40,0.85)' : 'rgba(180,30,30,0.4)';
    ctx.fillStyle = rLit;
    ctx.beginPath(); ctx.arc(-w/3, h/2-1.2, 1.3, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc( w/3, h/2-1.2, 1.3, 0, Math.PI*2); ctx.fill();

    // ── Small badge: R (red runner) or L (free left) ──
    if (v.runs_red) {
        ctx.rotate(-v.angle * Math.PI / 180);
        ctx.fillStyle = 'rgba(255,60,0,0.9)';
        ctx.font      = 'bold 8px "Inter", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('R', 0, -h/2 - 6);
    } else if (v.is_free_left) {
        ctx.rotate(-v.angle * Math.PI / 180);
        ctx.fillStyle = 'rgba(0,230,100,0.9)';
        ctx.font      = 'bold 8px "Inter", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('◄', 0, -h/2 - 6);
    }

    ctx.restore();
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function drawHUD(s) {
    if (!s) return;

    // Countdown badge
    const lp = LIGHT_POS[s.active];
    if (lp) {
        const tx = lp.vert ? lp.x - 22 : lp.x;
        const ty = lp.vert ? lp.y      : lp.y - 22;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        rrect(ctx, tx-18, ty-11, 36, 16, 5); ctx.fill();
        ctx.fillStyle = s.phase==='green'?'#2ecc71':s.phase==='yellow'?'#f4c430':'#e63946';
        ctx.font      = 'bold 11px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.ceil(s.timer)}s`, tx, ty+1);
    }



    // Direction labels
    ctx.font = 'bold 11px "Inter", sans-serif';
    ctx.textAlign = 'center';
    [
        {d:'N', x:CX+30,            y:18           },
        {d:'S', x:CX-30,            y:CANVAS_H-8   },
        {d:'E', x:CANVAS_W-10,      y:CY+30+8      },
        {d:'W', x:10,               y:CY-30-4      },
    ].forEach(it => {
        ctx.fillStyle = DIR_COL[it.d]+'cc';
        ctx.fillText(it.d, it.x, it.y);
    });

    // Emergency overlay
    if (s.emg_on) {
        const blink = (Date.now() % 700) < 350;
        ctx.strokeStyle = blink ? '#e63946' : 'rgba(230,57,70,0.25)';
        ctx.lineWidth   = 5;
        ctx.strokeRect(2, 2, CANVAS_W-4, CANVAS_H-4);
        ctx.fillStyle = 'rgba(15,0,0,0.35)';
        ctx.fillRect(0, 0, CANVAS_W, 38);
        ctx.fillStyle  = '#e63946';
        ctx.font       = 'bold 13px "Inter", sans-serif';
        ctx.textAlign  = 'left';
        ctx.fillText('⚠  EMERGENCY PRIORITY ACTIVE', 14, 24);
    }
}

// ─── Dashboard update ─────────────────────────────────────────────────────────
function updateDashboard() {
    if (!gState) return;
    const s = gState;

    const badge = document.getElementById('systemModeBadge');
    if (badge) {
        badge.textContent = s.mode === 'smart' ? 'SMART MODE ACTIVE' : 'TRADITIONAL MODE';
        badge.className   = 'system-mode-badge' + (s.mode!=='smart' ? ' traditional' : '');
    }
    document.getElementById('btnSmartMode')?.classList.toggle('active', s.mode==='smart');
    document.getElementById('btnTradMode') ?.classList.toggle('active', s.mode!=='smart');



    ['N','E','S','W'].forEach(d => {
        const sig  = s.signals[d];
        const q    = s.queue_sizes[d];
        const gt   = s.green_times[d];
        const form = s.green_formula?.[d] ?? `—`;

        document.getElementById(`queue${d}`)?.let     (el => el.textContent = q);
        document.getElementById(`calcGreen${d}`)?.let (el => el.textContent = form);

        const bEl = document.getElementById(`badge${d}`);
        if (bEl) { bEl.textContent = sig.toUpperCase(); bEl.className = `light-badge ${sig}`; }

        document.getElementById(`row${d}`)?.classList.toggle('active-phase', s.active===d);
    });

    // Sliders
    ['N','E','S','W'].forEach(d => {
        const sl = document.getElementById(`slider${d}`);
        if (sl && document.activeElement !== sl) {
            sl.value = s.density[d];
            const vl = document.getElementById(`val${d}`);
            if (vl) vl.textContent = s.density[d] + '%';
        }
    });
}

// Polyfill .let for elements (keeps code readable)
HTMLElement.prototype.let = function(fn) { fn(this); return this; };

// ─── Log updater ──────────────────────────────────────────────────────────────
function appendNewLogs() {
    if (!gState?.logs) return;
    const container = document.getElementById('logsContainer');
    if (!container) return;
    gState.logs.forEach(l => {
        const already = lastLogs.some(o => o.time===l.time && o.msg===l.msg);
        if (already) return;
        const el = document.createElement('div');
        el.className = `log-entry ${l.lvl}`;
        el.innerHTML = `<span class="log-time">${l.time}</span> ${l.msg}`;
        container.appendChild(el);
    });
    const added = gState.logs.filter(l => !lastLogs.some(o => o.time===l.time && o.msg===l.msg));
    if (added.length) {
        container.scrollTop = container.scrollHeight;
        lastLogs = gState.logs.slice();
    }
}

// ─── Canvas utility ───────────────────────────────────────────────────────────
function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.lineTo(x+w-r, y); ctx.quadraticCurveTo(x+w, y,   x+w, y+r);
    ctx.lineTo(x+w, y+h-r); ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
    ctx.lineTo(x+r, y+h); ctx.quadraticCurveTo(x, y+h,   x, y+h-r);
    ctx.lineTo(x, y+r); ctx.quadraticCurveTo(x, y,      x+r, y);
    ctx.closePath();
}

// ─── Render loop ──────────────────────────────────────────────────────────────
function render() {
    drawRoads();
    if (gState) {
        drawSensorZones(gState.mode);
        drawVehicles(gState.vehicles);
        drawTrafficLights(gState.signals);
        drawHUD(gState);
    }
    requestAnimationFrame(render);
}

// ─── UI bindings ──────────────────────────────────────────────────────────────
document.getElementById('btnSmartMode')?.addEventListener('click', () => {
    if (gState?.mode !== 'smart') sendAction({action:'toggle_mode'});
});
document.getElementById('btnTradMode')?.addEventListener('click', () => {
    if (gState?.mode !== 'traditional') sendAction({action:'toggle_mode'});
});

['N','E','S','W'].forEach(d => {
    document.getElementById(`btnEmg${d}`)?.addEventListener('click', () =>
        sendAction({action:'emergency', dir:d})
    );
    document.getElementById(`slider${d}`)?.addEventListener('input', e => {
        const val = parseInt(e.target.value);
        document.getElementById(`val${d}`).textContent = val + '%';
        sendAction({action:'set_density', dir:d, value:val});
    });
});

window.addEventListener('keydown', e => {
    const k = e.key.toUpperCase();
    if      (k === 'T')   sendAction({action:'toggle_mode'});
    else if (e.key==='F1'){e.preventDefault();sendAction({action:'emergency',dir:'N'});}
    else if (e.key==='F2'){e.preventDefault();sendAction({action:'emergency',dir:'E'});}
    else if (e.key==='F3'){e.preventDefault();sendAction({action:'emergency',dir:'S'});}
    else if (e.key==='F4'){e.preventDefault();sendAction({action:'emergency',dir:'W'});}
    else if (k==='1') nudgeDensity('N', 10); else if (k==='Q') nudgeDensity('N',-10);
    else if (k==='2') nudgeDensity('E', 10); else if (k==='W') nudgeDensity('E',-10);
    else if (k==='3') nudgeDensity('S', 10); else if (k==='E') nudgeDensity('S',-10);
    else if (k==='4') nudgeDensity('W', 10); else if (k==='R') nudgeDensity('W',-10);
});

function nudgeDensity(dir, delta) {
    const sl = document.getElementById(`slider${dir}`);
    if (!sl) return;
    const nv = Math.max(0, Math.min(100, parseInt(sl.value)+delta));
    sl.value = nv;
    document.getElementById(`val${dir}`).textContent = nv + '%';
    sendAction({action:'set_density', dir, value:nv});
}

// ─── Start ────────────────────────────────────────────────────────────────────
pollState();
render();
