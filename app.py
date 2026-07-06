"""
Smart Adaptive Traffic Light System — Python Simulation Engine v4
=================================================================
Changes in this version:
  - Double lanes per direction (2 lanes southbound, 2 lanes northbound,
    2 lanes westbound, 2 lanes eastbound).
  - Indian LHT keep-left traffic rules apply to all 4 approaches.
  - Vehicles spawn in either the inner lane (0) or outer lane (1) depending
    on which lane has a shorter queue.
  - Car-following model applies independently per lane.
  - Emergency vehicle triggers in the shorter lane.
"""

import threading
import time
import math
import random
from flask import Flask, render_template, jsonify, request

app = Flask(__name__)

# ─── Canvas / World constants ─────────────────────────────────────────────────
CANVAS_W   = 900
CANVAS_H   = 700
CX, CY     = 450, 350
ROAD_HALF  = 60

# ─── 2 Lanes per direction offsets ────────────────────────────────────────────
# Lane 0 = Inner lane (closer to road center line)
# Lane 1 = Outer lane (closer to road curb)
LANE_OFFSETS = [16, 44]

# ─── Signal timing ────────────────────────────────────────────────────────────
TICK_RATE  = 30
MIN_GREEN  = 20.0
MAX_GREEN  = 90.0
SEC_PER_VEH = 2.0          # 2 seconds allocated per vehicle in queue
YELLOW_T   = 3.0
EMG_GREEN  = 20.0
TRAD_GREEN = 60.0

DIRS       = ['N', 'E', 'S', 'W']
DIR_LABELS = {'N': 'North', 'E': 'East', 'S': 'South', 'W': 'West'}

# ─── Lane position helpers (Indian LHT) ───────────────────────────────────────
# N approach = southbound (heading down): left-hand side of N-S road (East side, x > CX)
# S approach = northbound (heading up): left-hand side of N-S road (West side, x < CX)
# E approach = westbound (heading left): left-hand side of E-W road (South side, y > CY)
# W approach = eastbound (heading right): left-hand side of E-W road (North side, y < CY)

def get_lane_coords(direction, lane_idx):
    off = LANE_OFFSETS[lane_idx]
    if direction == 'N':
        return (CX + off, -55), (CX + off, CY - ROAD_HALF)
    elif direction == 'S':
        return (CX - off, CANVAS_H + 55), (CX - off, CY + ROAD_HALF)
    elif direction == 'E':
        return (CANVAS_W + 55, CY + off), (CX + ROAD_HALF, CY + off)
    elif direction == 'W':
        return (-55, CY - off), (CX - ROAD_HALF, CY - off)
    return (0, 0), (0, 0)

# Exiting lanes map:
# south exit = southbound lanes (East side of road, x > CX)
# north exit = northbound lanes (West side of road, x < CX)
# east exit = eastbound lanes (North side of road, y < CY)
# west exit = westbound lanes (South side of road, y > CY)

def get_exit_coords(exit_dir, lane_idx):
    off = LANE_OFFSETS[lane_idx]
    if exit_dir == 'south':
        return (CX + off, CY + ROAD_HALF), (CX + off, CANVAS_H + 100)
    elif exit_dir == 'north':
        return (CX - off, CY - ROAD_HALF), (CX - off, -100)
    elif exit_dir == 'east':
        return (CX + ROAD_HALF, CY - off), (CANVAS_W + 100, CY - off)
    elif exit_dir == 'west':
        return (CX - ROAD_HALF, CY + off), (-100, CY + off)
    return (0, 0), (0, 0)


APPROACH = {
    'N': {'axis': 'y', 'fwd':  1},
    'S': {'axis': 'y', 'fwd': -1},
    'E': {'axis': 'x', 'fwd': -1},
    'W': {'axis': 'x', 'fwd':  1},
}

TURN_MAP = {
    'N': {'straight': 'south', 'left': 'east',  'right': 'west'},
    'S': {'straight': 'north', 'left': 'west',  'right': 'east'},
    'E': {'straight': 'west',  'left': 'south', 'right': 'north'},
    'W': {'straight': 'east',  'left': 'north', 'right': 'south'},
}

APPROACH_ANGLE = {'N': 180, 'S': 0,   'E': 270, 'W': 90}
EXIT_ANGLE     = {'south': 180, 'north': 0, 'east': 90, 'west': 270}

VEHICLE_SPECS = {
    'car':       {'w': 13, 'h': 23, 'max_spd': 85,  'color': '#5aa9e6'},
    'bike':      {'w':  6, 'h': 13, 'max_spd': 105, 'color': '#9aa5b1'},
    'bus':       {'w': 16, 'h': 35, 'max_spd': 55,  'color': '#f4c430'},
    'truck':     {'w': 16, 'h': 37, 'max_spd': 50,  'color': '#c77b3a'},
    'ambulance': {'w': 14, 'h': 27, 'max_spd': 120, 'color': '#f8f8f8'},
    'auto':      {'w':  9, 'h': 17, 'max_spd': 80,  'color': '#ff9f1c'},
}

_vid = 0


# ─── Vehicle ──────────────────────────────────────────────────────────────────
class Vehicle:
    def __init__(self, direction, vtype='car', is_emergency=False, lane_idx=0):
        global _vid
        _vid += 1
        self.id            = _vid
        self.dir           = direction
        self.vtype         = vtype
        self.is_emergency  = is_emergency or (vtype == 'ambulance')
        self.lane_idx      = lane_idx
        self.turn          = self._random_turn()

        spec = VEHICLE_SPECS[vtype]
        spawn_pos, _ = get_lane_coords(direction, lane_idx)

        self.x       = float(spawn_pos[0])
        self.y       = float(spawn_pos[1])
        self.w       = spec['w']
        self.h       = spec['h']
        self.max_spd = spec['max_spd']
        self.speed   = self.max_spd * 0.55
        self.angle   = float(APPROACH_ANGLE[direction])
        self.color   = spec['color']
        self.state   = 'approaching'

        # ── Indian traffic rules ──
        self.is_free_left = (
            self.turn == 'left' and
            not is_emergency and
            random.random() < 0.70
        )
        rl_chance = {'bike': 0.16, 'auto': 0.12}.get(vtype, 0.06)
        self.runs_red = (
            not self.is_free_left and
            not is_emergency and
            random.random() < rl_chance
        )

        # ── Crossing / Bezier state ──
        self.cross_t   = 0.0
        self.cross_spd = 0.30 + random.uniform(-0.04, 0.04)
        self.bz_s = self.bz_c = self.bz_e = None
        self.exit_dir  = None
        self.exit_vx   = 0.0
        self.exit_vy   = 0.0



        self.siren_t = 0.0

    def _random_turn(self):
        r = random.random()
        return 'straight' if r < 0.55 else ('left' if r < 0.80 else 'right')

    def dist_to_stop(self):
        cfg = APPROACH[self.dir]
        _, stop_pos = get_lane_coords(self.dir, self.lane_idx)
        if cfg['axis'] == 'y':
            return (stop_pos[1] - self.y) * cfg['fwd']
        return (stop_pos[0] - self.x) * cfg['fwd']

    def lead_gap(self, lead):
        cfg = APPROACH[self.dir]
        if cfg['axis'] == 'y':
            raw = (lead.y - self.y) * cfg['fwd']
            return raw - (lead.h + self.h) / 2
        raw = (lead.x - self.x) * cfg['fwd']
        return raw - (lead.w + self.w) / 2

    def _setup_bezier(self):
        cfg = APPROACH[self.dir]
        _, stop_pos = get_lane_coords(self.dir, self.lane_idx)
        self.exit_dir = TURN_MAP[self.dir][self.turn]

        # exit lane index assignment:
        # left turns -> outer lane (1)
        # right turns -> inner lane (0)
        # straight -> keep same lane
        exit_lane = self.lane_idx
        if self.turn == 'left':
            exit_lane = 1
        elif self.turn == 'right':
            exit_lane = 0

        end_pos, target_pos = get_exit_coords(self.exit_dir, exit_lane)

        sx, sy = stop_pos
        ex, ey = end_pos

        if self.turn == 'straight':
            ctrl = ((sx + ex) / 2, (sy + ey) / 2)
        elif cfg['axis'] == 'y':
            ctrl = (sx, ey)
        else:
            ctrl = (ex, sy)

        self.bz_s, self.bz_c, self.bz_e = stop_pos, ctrl, end_pos

        tx, ty = target_pos
        d = math.hypot(tx - ex, ty - ey)
        self.exit_vx = (tx - ex) / d if d else 0
        self.exit_vy = (ty - ey) / d if d else 0

    def _bz_pos(self, t):
        p0, p1, p2 = self.bz_s, self.bz_c, self.bz_e
        mt = 1 - t
        return (mt*mt*p0[0] + 2*mt*t*p1[0] + t*t*p2[0],
                mt*mt*p0[1] + 2*mt*t*p1[1] + t*t*p2[1])

    def _bz_angle(self, t):
        p0, p1, p2 = self.bz_s, self.bz_c, self.bz_e
        mt = 1 - t
        dx = 2*mt*(p1[0]-p0[0]) + 2*t*(p2[0]-p1[0])
        dy = 2*mt*(p1[1]-p0[1]) + 2*t*(p2[1]-p1[1])
        return math.degrees(math.atan2(dx, -dy)) % 360

    def update(self, dt, lead, can_go, crossing_vehicles):
        if self.is_emergency:
            self.siren_t = (self.siren_t + dt * 5.0) % 2.0



        effective_go = can_go or self.is_free_left or self.runs_red

        if self.state == 'approaching':
            dist        = self.dist_to_stop()
            desired_spd = self.max_spd

            # ── car-following ──
            if lead and lead.state == 'approaching':
                gap = self.lead_gap(lead)
                if gap < 8:
                    desired_spd = 0.0
                elif gap < 100:
                    ratio = max(0.0, (gap - 8) / 92.0)
                    desired_spd = min(desired_spd,
                                     lead.speed + ratio * (self.max_spd - lead.speed))

            # ── stop-line enforcement ──
            if not effective_go:
                if dist <= 4:
                    desired_spd = 0.0
                elif dist < 130:
                    ratio = max(0.0, (dist - 4) / 126.0)
                    desired_spd = min(desired_spd, self.max_spd * ratio * ratio)

            if self.runs_red and not can_go and dist < 50:
                desired_spd = self.max_spd * 0.75

            ACCEL, BRAKE = 170.0, 320.0
            if self.speed < desired_spd:
                self.speed = min(desired_spd, self.speed + ACCEL * dt)
            else:
                self.speed = max(desired_spd, self.speed - BRAKE * dt)

            cfg  = APPROACH[self.dir]
            move = self.speed * dt
            if cfg['axis'] == 'y':
                self.y += cfg['fwd'] * move
            else:
                self.x += cfg['fwd'] * move

            if not effective_go and self.dist_to_stop() < 0:
                _, stop_pos = get_lane_coords(self.dir, self.lane_idx)
                if cfg['axis'] == 'y':
                    self.y = float(stop_pos[1])
                else:
                    self.x = float(stop_pos[0])
                self.speed = 0.0

            # ── transition to crossing ──
            if effective_go and dist <= 3:
                too_close = any(
                    v.dir == self.dir and v.lane_idx == self.lane_idx and v.cross_t < 0.24
                    for v in crossing_vehicles
                )
                if not too_close:
                    self.state   = 'crossing'
                    self.cross_t = 0.0
                    self._setup_bezier()
                    _, stop_pos = get_lane_coords(self.dir, self.lane_idx)
                    if cfg['axis'] == 'y':
                        self.y = float(stop_pos[1])
                    else:
                        self.x = float(stop_pos[0])
                    self.speed = self.max_spd * 0.45

        elif self.state == 'crossing':
            spd_mult = 1.5 if self.is_emergency else 1.0
            if self.runs_red:
                spd_mult = 1.3
            self.cross_t = min(1.0, self.cross_t + self.cross_spd * spd_mult * dt)
            self.x, self.y = self._bz_pos(self.cross_t)
            if self.cross_t < 1.0:
                self.angle = self._bz_angle(self.cross_t)
            if self.cross_t >= 1.0:
                self.state = 'exiting'
                self.angle = float(EXIT_ANGLE[self.exit_dir])
                self.speed = self.max_spd * 0.7

        elif self.state == 'exiting':
            self.speed = min(self.max_spd, self.speed + 90.0 * dt)
            self.x += self.exit_vx * self.speed * dt
            self.y += self.exit_vy * self.speed * dt
            if (self.x < -130 or self.x > CANVAS_W + 130 or
                    self.y < -130 or self.y > CANVAS_H + 130):
                self.state = 'done'



    def to_dict(self):
        return {
            'id':          self.id,
            'x':           round(self.x, 1),
            'y':           round(self.y, 1),
            'w':           self.w,
            'h':           self.h,
            'angle':       round(self.angle, 1),
            'vtype':       self.vtype,
            'color':       self.color,
            'state':       self.state,
            'lane_idx':    self.lane_idx,
            'is_emg':      self.is_emergency,
            'is_free_left': self.is_free_left,
            'runs_red':    self.runs_red,
            'siren_on':    self.is_emergency and int(self.siren_t) == 0,
            'speed':       round(self.speed, 1),

        }





# ─── Traffic Simulation ───────────────────────────────────────────────────────
class TrafficSim:
    def __init__(self):
        self.mode    = 'smart'
        self.density = {'N': 80, 'E': 20, 'S': 40, 'W': 30}

        self.queues   = {d: [] for d in DIRS}
        self.crossing = []

        self.seq_idx   = 0
        self.active    = DIRS[0]
        self.phase     = 'green'
        self.timer     = 0.0
        self.green_dur = 0.0

        self.emg_on  = False
        self.emg_dir = None

        self.spawn_t       = {d: random.uniform(0, 4) for d in DIRS}


        self.logs = []
        self._start_phase(self.active)
        self._log('Smart 4-Lane Adaptive Traffic System initialised.', 'success')

    def _log(self, msg, lvl='info'):
        self.logs.append({'time': time.strftime('%H:%M:%S'), 'msg': msg, 'lvl': lvl})
        self.logs = self.logs[-80:]

    def _q_len(self, d):
        return sum(1 for v in self.queues[d] if v.state == 'approaching')

    def _smart_green(self, d):
        # Base green calculation off the longest queue among the two lanes
        q0 = sum(1 for v in self.queues[d] if v.state == 'approaching' and v.lane_idx == 0)
        q1 = sum(1 for v in self.queues[d] if v.state == 'approaching' and v.lane_idx == 1)
        max_q = max(q0, q1)
        return int(max(MIN_GREEN, min(MAX_GREEN, max_q * SEC_PER_VEH)))

    def _start_phase(self, d):
        self.active    = d
        self.phase     = 'green'
        self.seq_idx   = DIRS.index(d)
        self.green_dur = self._smart_green(d) if self.mode == 'smart' else int(TRAD_GREEN)
        self.timer     = float(self.green_dur)
        self._log(
            f'GREEN → {DIR_LABELS[d]}  longest_lane_q={self._smart_green(d)//2}  dur={self.green_dur}s  [{self.mode.upper()}]',
            'success'
        )

    def _next_phase(self):
        self.seq_idx = (self.seq_idx + 1) % len(DIRS)
        self._start_phase(DIRS[self.seq_idx])

    def trigger_emergency(self, d):
        if self.emg_on:
            self._log('Emergency already active — ignored.', 'warning')
            return
        self.emg_on  = True
        self.emg_dir = d
        lbl = DIR_LABELS[d]

        # Spawn emergency vehicle in the lane with shorter queue
        q0 = sum(1 for v in self.queues[d] if v.lane_idx == 0)
        q1 = sum(1 for v in self.queues[d] if v.lane_idx == 1)
        lane_idx = 0 if q0 <= q1 else 1

        cfg = APPROACH[d]
        _, stop_pos = get_lane_coords(d, lane_idx)
        amb = Vehicle(d, 'ambulance', is_emergency=True, lane_idx=lane_idx)
        if cfg['axis'] == 'y':
            amb.x = float(stop_pos[0])
            amb.y = stop_pos[1] - cfg['fwd'] * (amb.h / 2 + 6)
        else:
            amb.y = float(stop_pos[1])
            amb.x = stop_pos[0] - cfg['fwd'] * (amb.w / 2 + 6)
        amb.speed = 0.0

        # Insert at the very front of the approach queue
        self.queues[d].insert(0, amb)

        if self.active == d and self.phase == 'green':
            self.timer = max(self.timer, 20.0)
            self._log(f'🚨 EMERGENCY: {lbl} already GREEN — holding.', 'danger')
        else:
            if self.phase == 'green':
                self.phase = 'yellow'
                self.timer = YELLOW_T
            self._log(f'🚨 EMERGENCY override → {lbl}! Clearing intersection.', 'danger')

    def set_density(self, d, val):
        self.density[d] = max(0, min(100, int(val)))

    def toggle_mode(self):
        self.mode = 'traditional' if self.mode == 'smart' else 'smart'
        self._log(f'Mode switched to {self.mode.upper()}', 'info')

    def _spawn_interval(self, d):
        dens = self.density[d]
        if dens <= 0:
            return 99999.0
        # Multi-lane roadway allows higher spawn rates: 0.8s to 12s
        return max(0.8, 12.0 - dens * 0.112)

    @staticmethod
    def _random_vtype():
        r = random.random()
        if r < 0.02: return 'ambulance'
        if r < 0.40: return 'car'
        if r < 0.58: return 'bike'
        if r < 0.68: return 'auto'
        if r < 0.80: return 'bus'
        return 'truck'

    def _spawn_vehicles(self, dt):
        MAX_Q_PER_LANE = 12
        for d in DIRS:
            self.spawn_t[d] += dt
            interval = self._spawn_interval(d)
            if self.spawn_t[d] >= interval:
                q0 = sum(1 for v in self.queues[d] if v.lane_idx == 0)
                q1 = sum(1 for v in self.queues[d] if v.lane_idx == 1)

                if q0 < MAX_Q_PER_LANE or q1 < MAX_Q_PER_LANE:
                    lane_idx = 0 if q0 <= q1 else 1
                    self.spawn_t[d] = 0.0
                    v = Vehicle(d, self._random_vtype(), lane_idx=lane_idx)
                    self.queues[d].append(v)



    def update(self, dt):
        self._spawn_vehicles(dt)
        can_go = {d: (self.active == d and self.phase == 'green') for d in DIRS}

        # Update approaching queues (car-following model calculated per lane)
        for d in DIRS:
            q = self.queues[d]
            for lane_idx in [0, 1]:
                lane_vehicles = [v for v in q if v.lane_idx == lane_idx]
                for i, v in enumerate(lane_vehicles):
                    lead = lane_vehicles[i - 1] if i > 0 else None
                    v.update(dt, lead, can_go[d], self.crossing)

        # Harvest crossing vehicles
        new_cross = []
        for d in DIRS:
            remaining = []
            for v in self.queues[d]:
                if v.state in ('crossing', 'exiting', 'done'):
                    if v.state != 'done':
                        new_cross.append(v)
                else:
                    remaining.append(v)
            self.queues[d] = remaining

        # Update existing crossing/exiting
        for v in self.crossing:
            v.update(dt, None, True, self.crossing)

        self.crossing = [v for v in self.crossing if v.state != 'done']
        self.crossing.extend(new_cross)

        # Check for any approaching emergency vehicles to trigger green light automatically
        detected_emg_dir = None
        for d in DIRS:
            if any(v.is_emergency for v in self.queues[d]):
                detected_emg_dir = d
                break

        if detected_emg_dir:
            if not self.emg_on:
                self.emg_on  = True
                self.emg_dir = detected_emg_dir
                lbl = DIR_LABELS[detected_emg_dir]
                if self.active == detected_emg_dir and self.phase == 'green':
                    self.timer = max(self.timer, EMG_GREEN)
                    self._log(f'🚨 AUTOMATIC EMERGENCY: {lbl} already GREEN — holding.', 'danger')
                elif self.phase == 'green':
                    self.phase = 'yellow'
                    self.timer = YELLOW_T
                    self._log(f'🚨 AUTOMATIC EMERGENCY override → {lbl}! Switching currently green light to yellow.', 'danger')
                elif self.phase == 'yellow':
                    self._log(f'🚨 AUTOMATIC EMERGENCY override → {lbl}! Redirecting active yellow light transition.', 'danger')
                else:
                    self.phase = 'yellow'
                    self.timer = YELLOW_T
                    self._log(f'🚨 AUTOMATIC EMERGENCY override → {lbl}! Switching to yellow.', 'danger')
            elif self.emg_dir == detected_emg_dir:
                if self.active == detected_emg_dir and self.phase == 'green':
                    self.timer = max(self.timer, 5.0)

        # Hold green light if the active emergency vehicle is crossing the intersection
        if self.emg_on and self.active == self.emg_dir and self.phase == 'green':
            has_active_emg = (
                any(v.is_emergency for v in self.queues[self.active]) or
                any(v.is_emergency for v in self.crossing if v.dir == self.active)
            )
            if has_active_emg:
                self.timer = max(self.timer, 5.0)




        # Signal state machine
        self.timer -= dt
        if self.timer <= 0:
            if self.phase == 'green':
                self.phase = 'yellow'
                self.timer = YELLOW_T
                self._log(f'YELLOW → {DIR_LABELS[self.active]}', 'warning')

            elif self.phase == 'yellow':
                if self.emg_on and self.active != self.emg_dir:
                    self.active    = self.emg_dir
                    self.seq_idx   = DIRS.index(self.emg_dir)
                    self.phase     = 'green'
                    self.green_dur = EMG_GREEN
                    self.timer     = EMG_GREEN
                    self._log(
                        f'🚨 EMERGENCY GREEN → {DIR_LABELS[self.emg_dir]} for {EMG_GREEN}s!',
                        'danger')
                elif self.emg_on and self.active == self.emg_dir:
                    self.emg_on  = False
                    self.emg_dir = None
                    self._log('Emergency cleared. Resuming normal cycle.', 'success')
                    self._next_phase()
                else:
                    self._next_phase()

    def get_state(self):
        vehicles = []
        for d in DIRS:
            for v in self.queues[d]:
                vehicles.append(v.to_dict())
        for v in self.crossing:
            vehicles.append(v.to_dict())

        signals = {d: (self.phase if self.active == d else 'red') for d in DIRS}

        if self.mode == 'smart':
            green_times = {d: self._smart_green(d) for d in DIRS}
            # For formula, display active longest queue size
            green_formula = {}
            for d in DIRS:
                q0 = sum(1 for v in self.queues[d] if v.state == 'approaching' and v.lane_idx == 0)
                q1 = sum(1 for v in self.queues[d] if v.state == 'approaching' and v.lane_idx == 1)
                green_formula[d] = f'max_q={max(q0,q1)} × 2 = {self._smart_green(d)}s'
        else:
            green_times   = {d: int(TRAD_GREEN) for d in DIRS}
            green_formula = {d: f'Fixed {int(TRAD_GREEN)}s' for d in DIRS}

        return {
            'mode':          self.mode,
            'active':        self.active,
            'phase':         self.phase,
            'timer':         round(max(0.0, self.timer), 1),
            'green_dur':     self.green_dur,
            'signals':       signals,
            'queue_sizes':   {d: self._q_len(d) for d in DIRS},
            'green_times':   green_times,
            'green_formula': green_formula,
            'density':       dict(self.density),
            'emg_on':        self.emg_on,
            'emg_dir':       self.emg_dir,

            'vehicles':      vehicles,
            'logs':          self.logs[-10:],
            'canvas_w':      CANVAS_W,
            'canvas_h':      CANVAS_H,
        }


# ─── Flask app & background simulation thread ─────────────────────────────────
sim      = TrafficSim()
sim_lock = threading.Lock()


def _sim_loop():
    dt = 1.0 / TICK_RATE
    while True:
        t0 = time.perf_counter()
        with sim_lock:
            sim.update(dt)
        elapsed = time.perf_counter() - t0
        time.sleep(max(0.0, dt - elapsed))


threading.Thread(target=_sim_loop, daemon=True).start()


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/state')
def api_state():
    with sim_lock:
        state = sim.get_state()
    return jsonify(state)


@app.route('/api/action', methods=['POST'])
def api_action():
    data = request.get_json(force=True) or {}
    act  = data.get('action', '')
    with sim_lock:
        if act == 'toggle_mode':
            sim.toggle_mode()
        elif act == 'set_density':
            sim.set_density(data['dir'], data['value'])
        elif act == 'emergency':
            sim.trigger_emergency(data['dir'])
    return jsonify({'ok': True})


if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=5000, use_reloader=False)
