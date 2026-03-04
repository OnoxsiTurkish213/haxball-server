const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['*'], credentials: false },
    transports: ['websocket', 'polling'],
    pingInterval: 8000, pingTimeout: 4000, upgradeTimeout: 10000, allowEIO3: true
});

app.get('/', (req, res) => res.send('HaxBall Server v6 Çalışıyor!'));

// ================================================
// HARİTA TANIMLARI
// ================================================
const MAPS = {
    classic: { fw: 1200, fh: 600, gh: 150, gd: 55, bf: 0.987, pf: 0.91 },
    big:     { fw: 1500, fh: 750, gh: 180, gd: 60, bf: 0.988, pf: 0.92 },
    small:   { fw:  900, fh: 450, gh: 120, gd: 45, bf: 0.985, pf: 0.90 },
    hockey:  { fw: 1100, fh: 500, gh: 130, gd: 50, bf: 0.993, pf: 0.955 },
    futsal:  { fw: 1000, fh: 520, gh: 135, gd: 48, bf: 0.983, pf: 0.90 }
};

// ================================================
// FİZİK SABİTLERİ
// ================================================
const PR   = 19;
const BR   = 11;
const PSR  = 4;
const KF   = 7;
const PKF  = 22;
const PSP  = 7;
const PA   = 0.28;
const PMS  = 2.8;
const BMS  = 14;
const BD   = 0.62;
const PBD  = 0.24;
const BPF  = 0.35;
const RCF  = 18;
const KICK_HOLD_MAX = 60;
const PCD     = 2700;  // power shot cooldown ticks (~45s)
const PASS_CD = 420;   // pas cooldown ticks (~7s @ 60fps)
const FDT     = 1000 / 60;

// ================================================
// YARDIMCILAR
// ================================================
function dst(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
}
function clp(v, a, b) { return v < a ? a : v > b ? b : v; }
function nrm(x, y) {
    const l = Math.sqrt(x * x + y * y);
    return l < 1e-5 ? { x: 0, y: 0 } : { x: x / l, y: y / l };
}

// ================================================
// MEVKİ / TAKIM YARDIMCILARI
// ================================================
function slotCfg(ts) {
    if (ts <= 0) return { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    if (ts <= 4) return { GK: 1, DEF: 1, MID: 1, FWD: 1 };
    if (ts === 5) return { GK: 1, DEF: 2, MID: 1, FWD: 1 };
    if (ts === 6) return { GK: 1, DEF: 2, MID: 2, FWD: 1 };
    if (ts === 7) return { GK: 1, DEF: 2, MID: 2, FWD: 2 };
    if (ts === 8) return { GK: 1, DEF: 3, MID: 2, FWD: 2 };
    if (ts === 9) return { GK: 1, DEF: 3, MID: 3, FWD: 2 };
    if (ts === 10) return { GK: 1, DEF: 3, MID: 3, FWD: 3 };
    return { GK: 1, DEF: 4, MID: 3, FWD: 3 };
}
function tmSz(players, team) {
    let c = 0;
    for (const p of Object.values(players)) if (p.online !== false && p.team === team) c++;
    return c;
}
function cntPos(players, team, pos, ex) {
    let c = 0;
    for (const [id, p] of Object.entries(players)) {
        if (id === ex || p.online === false) continue;
        if (p.team === team && p.pos === pos) c++;
    }
    return c;
}
function aPos(players, team, pid) {
    let ts = tmSz(players, team);
    if (!(players[pid] && players[pid].team === team && players[pid].online !== false)) ts++;
    const c = slotCfg(ts);
    for (const pos of ['GK', 'DEF', 'MID', 'FWD']) {
        if (cntPos(players, team, pos, pid) < (c[pos] || 0)) return pos;
    }
    return 'MID';
}
function spPos(team, pos, idx, tot, m) {
    let bx = m.fw / 2;
    if (team === 'red') {
        if (pos === 'GK')       bx = 50;
        else if (pos === 'DEF') bx = m.fw * 0.18;
        else if (pos === 'MID') bx = m.fw * 0.34;
        else                    bx = m.fw * 0.45;
    } else {
        if (pos === 'GK')       bx = m.fw - 50;
        else if (pos === 'DEF') bx = m.fw * 0.82;
        else if (pos === 'MID') bx = m.fw * 0.66;
        else                    bx = m.fw * 0.55;
    }
    const sp = Math.min(68, (m.fh - 80) / Math.max(tot, 1));
    return { x: bx, y: m.fh / 2 - (tot - 1) * sp / 2 + idx * sp };
}

// ================================================
// ODA YÖNETİMİ
// ================================================
const rooms = {};

function makePlayer(id, name, m) {
    return {
        id, name,
        team: 'spectator', pos: '',
        x: m.fw / 2, y: m.fh / 2,
        vx: 0, vy: 0,
        kick: false, kickHeld: 0,
        iDx: 0, iDy: 0, iK: false, iP: false, iPw: false,
        pCD: 0, passCD: 0,
        rcVx: 0, rcVy: 0, rcT: 0,
        online: true
    };
}

function createRoom(code, hostId, mapKey, goalLimit, password) {
    const m = MAPS[mapKey] || MAPS.classic;
    rooms[code] = {
        code, hostId, mapKey,
        goalLimit: goalLimit || 5,
        password: password || '',
        players: {},
        state: 'lobby',
        ball: { x: m.fw / 2, y: m.fh / 2, vx: 0, vy: 0, fire: false, ft: 0 },
        match: { redScore: 0, blueScore: 0, time: 0, running: false, paused: false },
        goalFreeze: false, goalTimer: 0,
        lastToucher: null,  // { pid, team }
        prevToucher: null,  // { pid, team }
        stats: {},          // pid -> { name, team, goals, ownGoals, assists }
        gameLoop: null
    };
    return rooms[code];
}

function getLobbyData(code) {
    const room = rooms[code];
    if (!room) return null;
    const pOut = {};
    for (const [id, p] of Object.entries(room.players)) {
        if (p.online === false) continue;
        pOut[id] = { name: p.name, team: p.team, pos: p.pos || '' };
    }
    return { players: pOut, hostId: room.hostId, mapKey: room.mapKey, goalLimit: room.goalLimit, state: room.state };
}

function buildState(code) {
    const room = rooms[code];
    if (!room) return null;
    const pOut = {};
    for (const [id, p] of Object.entries(room.players)) {
        if (p.online === false) continue;
        pOut[id] = {
            x: +p.x.toFixed(2), y: +p.y.toFixed(2),
            vx: +p.vx.toFixed(3), vy: +p.vy.toFixed(3),
            kick: p.kick || false, team: p.team, pos: p.pos || '',
            name: p.name, pCD: p.pCD || 0
        };
    }
    return {
        players: pOut,
        ball: { x: +room.ball.x.toFixed(2), y: +room.ball.y.toFixed(2), vx: +room.ball.vx.toFixed(3), vy: +room.ball.vy.toFixed(3), fire: room.ball.fire },
        match: { ...room.match },
        goalFreeze: room.goalFreeze
    };
}

// ================================================
// İSTATİSTİK YARDIMCILARI
// ================================================
function ensureStat(room, pid) {
    if (!room.stats[pid]) {
        const p = room.players[pid];
        room.stats[pid] = { name: p ? p.name : '?', team: p ? p.team : '', goals: 0, ownGoals: 0, assists: 0 };
    }
}
function updateToucher(room, pid) {
    if (!pid) return;
    const p = room.players[pid];
    if (!p || p.team === 'spectator') return;
    if (room.lastToucher && room.lastToucher.pid !== pid) {
        room.prevToucher = room.lastToucher;
    }
    room.lastToucher = { pid, team: p.team };
}

// ================================================
// OYUN DÖNGÜSÜ
// ================================================
function startGameLoop(roomCode) {
    stopGameLoop(roomCode);
    const room = rooms[roomCode];
    if (!room) return;
    room.gameLoop = setInterval(() => {
        if (!rooms[roomCode]) { clearInterval(room.gameLoop); return; }
        hostPhysics(roomCode);
        const state = buildState(roomCode);
        if (state) io.to(roomCode).emit('state', state);
    }, FDT);
}
function stopGameLoop(roomCode) {
    const room = rooms[roomCode];
    if (room && room.gameLoop) { clearInterval(room.gameLoop); room.gameLoop = null; }
}

// ================================================
// RESET POZİSYONLAR
// ================================================
function resetPositions(roomCode) {
    const room = rooms[roomCode]; if (!room) return;
    const m = MAPS[room.mapKey] || MAPS.classic;
    room.ball.x = m.fw / 2; room.ball.y = m.fh / 2;
    room.ball.vx = 0; room.ball.vy = 0; room.ball.fire = false; room.ball.ft = 0;
    const rP = [], bP = [];
    for (const [id, p] of Object.entries(room.players)) {
        if (p.online === false) continue;
        if (p.team === 'red') rP.push(id);
        else if (p.team === 'blue') bP.push(id);
    }
    spawnGroup(roomCode, rP, 'red');
    spawnGroup(roomCode, bP, 'blue');
    room.lastToucher = null;
    room.prevToucher = null;
}
function spawnGroup(roomCode, pids, team) {
    const room = rooms[roomCode]; if (!room) return;
    const m = MAPS[room.mapKey] || MAPS.classic;
    const g = { GK: [], DEF: [], MID: [], FWD: [] };
    for (const id of pids) {
        const pos = (room.players[id] && room.players[id].pos) || 'MID';
        (g[pos] || (g[pos] = [])).push(id);
    }
    for (const [pos, arr] of Object.entries(g)) {
        for (let j = 0; j < arr.length; j++) {
            const s = spPos(team, pos, j, arr.length, m);
            const p = room.players[arr[j]];
            if (p) { p.x = s.x; p.y = s.y; p.vx = 0; p.vy = 0; p.kickHeld = 0; }
        }
    }
}
function findMate(roomCode, pid) {
    const room = rooms[roomCode]; if (!room) return null;
    const me = room.players[pid]; if (!me) return null;
    let best = null, bd = 1e9;
    for (const [id, p] of Object.entries(room.players)) {
        if (id === pid || p.team !== me.team || p.team === 'spectator' || p.online === false) continue;
        const d = dst(me.x, me.y, p.x, p.y);
        if (d < bd) { bd = d; best = p; }
    }
    return best;
}

// ================================================
// GOL — golcü, kendi kalesine, asist tespiti
// ================================================
function handleGoal(roomCode, ballEnterSide) {
    // ballEnterSide: 'left' (sol kaleye) veya 'right' (sağ kaleye)
    // Sol kale = kırmızı kalesi → blue skor
    // Sağ kale = mavi kalesi → red skor
    const room = rooms[roomCode];
    if (!room || room.goalFreeze) return;

    const lt = room.lastToucher;
    const pt = room.prevToucher;

    let scoringTeam, scorerPid = null, assistPid = null, ownGoal = false;

    // Hangi takim gol attı
    // Sol kaleye girdi = blue faydalandı
    const naturalWinner = ballEnterSide === 'left' ? 'blue' : 'red';

    if (lt) {
        if (lt.team === (ballEnterSide === 'left' ? 'red' : 'blue')) {
            // Kendi kalesine attı!
            ownGoal = true;
            scorerPid = lt.pid;
            scoringTeam = naturalWinner;
        } else {
            scorerPid = lt.pid;
            scoringTeam = lt.team;
            if (pt && pt.pid !== lt.pid && pt.team === lt.team) {
                assistPid = pt.pid;
            }
        }
    } else {
        scoringTeam = naturalWinner;
    }

    if (scoringTeam === 'red') room.match.redScore++;
    else room.match.blueScore++;

    if (scorerPid) {
        ensureStat(room, scorerPid);
        if (ownGoal) room.stats[scorerPid].ownGoals++;
        else room.stats[scorerPid].goals++;
    }
    if (assistPid) {
        ensureStat(room, assistPid);
        room.stats[assistPid].assists++;
    }

    room.goalFreeze = true;
    room.goalTimer  = 1800;
    room.ball.vx = 0; room.ball.vy = 0; room.ball.fire = false; room.ball.ft = 0;
    for (const p of Object.values(room.players)) { p.vx = 0; p.vy = 0; p.kickHeld = 0; }

    io.to(roomCode).emit('goal', {
        team:      scoringTeam,
        redScore:  room.match.redScore,
        blueScore: room.match.blueScore,
        scorerPid, assistPid, ownGoal
    });

    const gl = room.goalLimit;
    if (gl > 0 && (room.match.redScore >= gl || room.match.blueScore >= gl)) {
        setTimeout(() => {
            if (!rooms[roomCode]) return;
            room.match.running = false;
            stopGameLoop(roomCode);
            io.to(roomCode).emit('matchEnd', {
                reason: 'goal', winner: scoringTeam,
                redScore:  room.match.redScore,
                blueScore: room.match.blueScore,
                stats: room.stats
            });
        }, 1800 + 200);
    }
}

// ================================================
// ANA FİZİK
// ================================================
function hostPhysics(roomCode) {
    const room = rooms[roomCode]; if (!room) return;
    const m = MAPS[room.mapKey] || MAPS.classic;
    const { fw: FW, fh: FH, gh: GH, gd: GD, bf, pf } = m;
    const gT = FH / 2 - GH / 2, gB = FH / 2 + GH / 2;
    const dtS = FDT / 1000;
    const match = room.match;
    const B = room.ball;

    if (match.running && !match.paused && !room.goalFreeze) match.time += dtS;

    if (room.goalFreeze) {
        room.goalTimer -= FDT;
        if (room.goalTimer <= 0) {
            room.goalFreeze = false;
            resetPositions(roomCode);
            io.to(roomCode).emit('resetPositions', buildState(roomCode));
        }
        return;
    }
    if (match.paused || !match.running) return;

    const acts = Object.entries(room.players).filter(([, p]) => p.online !== false && p.team !== 'spectator');

    // ---- OYUNCU FİZİĞİ ----
    for (const [, pp] of acts) {
        if (pp.rcT > 0) { pp.x += pp.rcVx; pp.y += pp.rcVy; pp.rcVx *= 0.85; pp.rcVy *= 0.85; pp.rcT--; }
        const inL = Math.sqrt(pp.iDx * pp.iDx + pp.iDy * pp.iDy);
        if (inL > 0.05) { const nm = nrm(pp.iDx, pp.iDy); pp.vx += nm.x * PA * Math.min(inL, 1); pp.vy += nm.y * PA * Math.min(inL, 1); }
        const spd = Math.sqrt(pp.vx * pp.vx + pp.vy * pp.vy);
        if (spd > PMS) { pp.vx = (pp.vx / spd) * PMS; pp.vy = (pp.vy / spd) * PMS; }
        pp.vx *= pf; pp.vy *= pf;
        if (Math.abs(pp.vx) < 0.003) pp.vx = 0;
        if (Math.abs(pp.vy) < 0.003) pp.vy = 0;
        pp.x += pp.vx; pp.y += pp.vy;
        if (pp.iK) { if (pp.kickHeld < KICK_HOLD_MAX) pp.kickHeld++; pp.kick = true; }
        else { pp.kickHeld = 0; pp.kick = false; }
        if (pp.pCD > 0) pp.pCD--;
        if (pp.passCD > 0) pp.passCD--;

        if (pp.y < PR) { pp.y = PR; pp.vy = 0; }
        if (pp.y > FH - PR) { pp.y = FH - PR; pp.vy = 0; }
        if (pp.x < PR) {
            if (pp.y > gT && pp.y < gB) { if (pp.x < -GD + PR) pp.x = -GD + PR; }
            else { pp.x = PR; pp.vx = 0; }
        }
        if (pp.x > FW - PR) {
            if (pp.y > gT && pp.y < gB) { if (pp.x > FW + GD - PR) pp.x = FW + GD - PR; }
            else { pp.x = FW - PR; pp.vx = 0; }
        }
    }

    // ---- OYUNCU-OYUNCU ÇARPIŞMA ----
    for (let i = 0; i < acts.length; i++) {
        for (let j = i + 1; j < acts.length; j++) {
            const [, pa] = acts[i], [, pb] = acts[j];
            const cd = dst(pa.x, pa.y, pb.x, pb.y), mD = PR * 2;
            if (cd < mD && cd > 0.001) {
                const cnx = (pb.x - pa.x) / cd, cny = (pb.y - pa.y) / cd, ov = mD - cd;
                pa.x -= cnx * ov * 0.5; pa.y -= cny * ov * 0.5;
                pb.x += cnx * ov * 0.5; pb.y += cny * ov * 0.5;
                const dvx = pa.vx - pb.vx, dvy = pa.vy - pb.vy, dvn = dvx * cnx + dvy * cny;
                if (dvn > 0) { pa.vx -= dvn * cnx * PBD; pa.vy -= dvn * cny * PBD; pb.vx += dvn * cnx * PBD; pb.vy += dvn * cny * PBD; }
            }
        }
    }

    // ---- TOP FİZİĞİ ----
    if (B.ft > 0) { B.ft--; if (B.ft <= 0) B.fire = false; }
    B.vx *= bf; B.vy *= bf;
    if (Math.abs(B.vx) < 0.004) B.vx = 0;
    if (Math.abs(B.vy) < 0.004) B.vy = 0;
    B.x += B.vx; B.y += B.vy;
    const bsp = Math.sqrt(B.vx * B.vx + B.vy * B.vy);
    const maxB = B.fire ? BMS * 2 : BMS;
    if (bsp > maxB) { B.vx = (B.vx / bsp) * maxB; B.vy = (B.vy / bsp) * maxB; }

    // ---- OYUNCU-TOP ÇARPIŞMA & VURUŞ ----
    for (const [pid, bp] of acts) {
        const bd = dst(bp.x, bp.y, B.x, B.y);
        const touchRange = PR + BR;
        const kickRange  = PR + BR + (bp.kick ? 4 : 0);

        if (bd < kickRange && bd > 0.001) {
            const bnx = (B.x - bp.x) / bd, bny = (B.y - bp.y) / bd;
            if (bd < touchRange) { const bov = touchRange - bd; B.x += bnx * bov; B.y += bny * bov; }
            const bdvx = B.vx - bp.vx, bdvy = B.vy - bp.vy, bdvn = bdvx * bnx + bdvy * bny;

            // Topa dokunanı kaydet (assist/gol takibi)
            updateToucher(room, pid);

            if (bp.kick) {
                // POWER SHOT
                if (bp.iPw && bp.pCD <= 0) {
                    const holdR = Math.min(bp.kickHeld / KICK_HOLD_MAX, 1);
                    B.vx = bnx * PKF * (0.7 + holdR * 0.5);
                    B.vy = bny * PKF * (0.7 + holdR * 0.5);
                    B.fire = true; B.ft = 120;
                    bp.pCD = PCD; bp.iPw = false;
                    io.to(roomCode).emit('powerShot', { pid });
                }
                // PAS — sadece topa dokunulduğu anda ve passCD=0 ise çalışır
                else if (bp.iP && bp.passCD <= 0) {
                    const mate = findMate(roomCode, pid);
                    if (mate) {
                        const dn = nrm(mate.x - B.x, mate.y - B.y);
                        B.vx = dn.x * PSP; B.vy = dn.y * PSP;
                    } else {
                        if (bdvn < KF) { const addF = KF - Math.max(bdvn, 0); B.vx += bnx * addF; B.vy += bny * addF; }
                    }
                    bp.passCD = PASS_CD;
                    // İstemciye bildir
                    const sock = io.sockets.sockets.get(pid);
                    if (sock) sock.emit('passDone', { cd: PASS_CD });
                }
                // NORMAL VURUŞ
                else if (!bp.iP) {
                    if (bdvn < KF) { const addF = KF - Math.max(bdvn, 0); B.vx += bnx * addF; B.vy += bny * addF; }
                }
            } else {
                if (bdvn < 0) { B.vx -= bdvn * bnx * BPF; B.vy -= bdvn * bny * BPF; }
            }

            if (B.fire && bdvn < 0) {
                const bspd2 = Math.sqrt(B.vx * B.vx + B.vy * B.vy);
                if (bspd2 > 4) { bp.rcVx = -bnx * RCF; bp.rcVy = -bny * RCF; bp.rcT = 18; }
            }
            if (!B.fire && bdvn < -8) { bp.rcVx = -bnx * RCF * 0.5; bp.rcVy = -bny * RCF * 0.5; bp.rcT = 8; }
        }
    }

    // ---- KALE DİREKLERİ ----
    const posts = [{ x: 0, y: gT }, { x: 0, y: gB }, { x: FW, y: gT }, { x: FW, y: gB }];
    for (const po of posts) {
        const pd = dst(B.x, B.y, po.x, po.y);
        if (pd < BR + PSR && pd > 0.001) {
            const pnx = (B.x - po.x) / pd, pny = (B.y - po.y) / pd, pov = BR + PSR - pd;
            B.x += pnx * pov; B.y += pny * pov;
            const pdot = B.vx * pnx + B.vy * pny;
            if (pdot < 0) { B.vx -= 2 * pdot * pnx * BD; B.vy -= 2 * pdot * pny * BD; }
        }
    }

    // ---- SINIRLAR VE GOL ----
    if (B.y - BR < 0)   { B.y = BR;      if (B.vy < 0) B.vy = -B.vy * BD; }
    if (B.y + BR > FH)  { B.y = FH - BR; if (B.vy > 0) B.vy = -B.vy * BD; }

    if (B.x - BR < 0) {
        if (B.y > gT && B.y < gB) {
            if (B.x < -GD * 0.7) { handleGoal(roomCode, 'left'); return; }
            if (B.y - BR < gT) { B.y = gT + BR; if (B.vy < 0) B.vy = -B.vy * BD; }
            if (B.y + BR > gB) { B.y = gB - BR; if (B.vy > 0) B.vy = -B.vy * BD; }
        } else { B.x = BR; if (B.vx < 0) B.vx = -B.vx * BD; }
    }
    if (B.x + BR > FW) {
        if (B.y > gT && B.y < gB) {
            if (B.x > FW + GD * 0.7) { handleGoal(roomCode, 'right'); return; }
            if (B.y - BR < gT) { B.y = gT + BR; if (B.vy < 0) B.vy = -B.vy * BD; }
            if (B.y + BR > gB) { B.y = gB - BR; if (B.vy > 0) B.vy = -B.vy * BD; }
        } else { B.x = FW - BR; if (B.vx > 0) B.vx = -B.vx * BD; }
    }
    if (B.x < -GD)      { B.x = -GD + BR; B.vx = Math.abs(B.vx) * BD; }
    if (B.x > FW + GD)  { B.x = FW + GD - BR; B.vx = -Math.abs(B.vx) * BD; }
}

// ================================================
// SOCKET.IO EVENTS
// ================================================
io.on('connection', (socket) => {
    console.log('Bağlandı:', socket.id);

    socket.on('ping_custom', () => socket.emit('pong_custom'));

    socket.on('createRoom', (data, cb) => {
        const { code, playerName, mapKey, goalLimit, password } = data;
        if (rooms[code]) { if (cb) cb({ error: 'Kod zaten var' }); return; }
        const room = createRoom(code, socket.id, mapKey || 'classic', goalLimit || 5, password || '');
        const m = MAPS[room.mapKey] || MAPS.classic;
        room.players[socket.id] = makePlayer(socket.id, playerName || 'Oyuncu', m);
        socket.join(code); socket.roomCode = code;
        if (cb) cb({ ok: true, code });
        io.to(code).emit('lobbyUpdate', getLobbyData(code));
    });

    socket.on('joinRoom', (data, cb) => {
        const { code, playerName, password } = data;
        const room = rooms[code];
        if (!room) { if (cb) cb({ error: 'Oda bulunamadı' }); return; }
        if (room.password && room.password !== password) { if (cb) cb({ error: 'Yanlış şifre' }); return; }
        if (room.state === 'playing') { if (cb) cb({ error: 'Oyun devam ediyor' }); return; }
        const m = MAPS[room.mapKey] || MAPS.classic;
        room.players[socket.id] = makePlayer(socket.id, playerName || 'Oyuncu', m);
        socket.join(code); socket.roomCode = code;
        if (cb) cb({ ok: true, code, mapKey: room.mapKey, goalLimit: room.goalLimit, hostId: room.hostId });
        io.to(code).emit('lobbyUpdate', getLobbyData(code));
    });

    socket.on('changeTeam', (data) => {
        const room = rooms[socket.roomCode]; if (!room) return;
        const p = room.players[socket.id]; if (!p) return;
        if (data.team === 'spectator') { p.team = 'spectator'; p.pos = ''; }
        else {
            if (tmSz(room.players, data.team) >= 11) return;
            p.team = data.team; p.pos = aPos(room.players, data.team, socket.id);
        }
        io.to(socket.roomCode).emit('lobbyUpdate', getLobbyData(socket.roomCode));
    });

    socket.on('changePos', (data) => {
        const room = rooms[socket.roomCode]; if (!room) return;
        const p = room.players[socket.id]; if (!p || p.team === 'spectator') return;
        if (!['GK','DEF','MID','FWD'].includes(data.pos)) return;
        const ts = tmSz(room.players, p.team);
        const cfg = slotCfg(ts);
        if (cntPos(room.players, p.team, data.pos, socket.id) < (cfg[data.pos] || 0) || ts === 1) {
            p.pos = data.pos;
            io.to(socket.roomCode).emit('lobbyUpdate', getLobbyData(socket.roomCode));
        }
    });

    socket.on('changeGoalLimit', (data) => {
        const room = rooms[socket.roomCode]; if (!room || room.hostId !== socket.id) return;
        room.goalLimit = parseInt(data.goalLimit) || 0;
        io.to(socket.roomCode).emit('goalLimitChanged', { goalLimit: room.goalLimit });
        io.to(socket.roomCode).emit('lobbyUpdate', getLobbyData(socket.roomCode));
    });

    socket.on('adminChangeTeam', (data) => {
        const room = rooms[socket.roomCode]; if (!room || room.hostId !== socket.id) return;
        const p = room.players[data.pid]; if (!p) return;
        if (data.team === 'spectator') { p.team = 'spectator'; p.pos = ''; }
        else {
            if (tmSz(room.players, data.team) >= 11) return;
            p.team = data.team; p.pos = aPos(room.players, data.team, data.pid);
        }
        io.to(socket.roomCode).emit('lobbyUpdate', getLobbyData(socket.roomCode));
    });

    socket.on('startGame', (cb) => {
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) { if (cb) cb({ error: 'Yetkisiz' }); return; }
        let rc = 0, bc = 0;
        for (const p of Object.values(room.players)) {
            if (p.online === false) continue;
            if (p.team === 'red') rc++; if (p.team === 'blue') bc++;
        }
        if (rc < 1 || bc < 1) { if (cb) cb({ error: 'Her takımda en az 1 oyuncu olmalı' }); return; }
        for (const [id, p] of Object.entries(room.players)) {
            if (p.online === false) continue;
            if (p.team !== 'spectator' && !p.pos) p.pos = aPos(room.players, p.team, id);
        }
        room.state  = 'playing';
        room.match  = { redScore: 0, blueScore: 0, time: 0, running: true, paused: false };
        room.goalFreeze = false; room.goalTimer = 0;
        room.stats = {}; room.lastToucher = null; room.prevToucher = null;
        const m = MAPS[room.mapKey] || MAPS.classic;
        room.ball = { x: m.fw / 2, y: m.fh / 2, vx: 0, vy: 0, fire: false, ft: 0 };
        resetPositions(roomCode);
        startGameLoop(roomCode);
        io.to(roomCode).emit('gameStart', {
            mapKey: room.mapKey, goalLimit: room.goalLimit,
            players: getLobbyData(roomCode).players
        });
        if (cb) cb({ ok: true });
    });

    socket.on('input', (data) => {
        const room = rooms[socket.roomCode]; if (!room) return;
        const p = room.players[socket.id]; if (!p) return;
        p.iDx = clp(data.dx || 0, -1, 1);
        p.iDy = clp(data.dy || 0, -1, 1);
        p.iK  = data.ik  || false;
        p.iP  = data.ip  || false;
        p.iPw = data.ipw || false;
    });

    socket.on('chat', (data) => {
        const room = rooms[socket.roomCode]; if (!room) return;
        const p = room.players[socket.id]; if (!p) return;
        io.to(socket.roomCode).emit('chat', { pid: socket.id, name: p.name, msg: String(data.msg || '').substr(0, 100) });
    });

    socket.on('emoji', (data) => {
        const room = rooms[socket.roomCode]; if (!room) return;
        io.to(socket.roomCode).emit('emoji', { pid: socket.id, emoji: String(data.emoji || '').substr(0, 10) });
    });

    socket.on('adminPause', () => {
        const room = rooms[socket.roomCode]; if (!room || room.hostId !== socket.id) return;
        room.match.paused = !room.match.paused;
        io.to(socket.roomCode).emit('paused', room.match.paused);
    });

    socket.on('adminReset', () => {
        const room = rooms[socket.roomCode]; if (!room || room.hostId !== socket.id) return;
        room.match.redScore = 0; room.match.blueScore = 0; room.match.time = 0;
        room.goalFreeze = false; room.goalTimer = 0;
        room.stats = {}; room.lastToucher = null; room.prevToucher = null;
        resetPositions(socket.roomCode);
        io.to(socket.roomCode).emit('adminReset', buildState(socket.roomCode));
    });

    socket.on('adminLobby', () => {
        const room = rooms[socket.roomCode]; if (!room || room.hostId !== socket.id) return;
        room.state = 'lobby'; room.match.running = false; room.match.paused = false;
        stopGameLoop(socket.roomCode);
        io.to(socket.roomCode).emit('backToLobby');
    });

    socket.on('adminChangeMap', (data) => {
        const room = rooms[socket.roomCode]; if (!room || room.hostId !== socket.id) return;
        if (!MAPS[data.mapKey]) return;
        room.mapKey = data.mapKey;
        const m = MAPS[data.mapKey];
        room.ball = { x: m.fw / 2, y: m.fh / 2, vx: 0, vy: 0, fire: false, ft: 0 };
        resetPositions(socket.roomCode);
        io.to(socket.roomCode).emit('mapChanged', { mapKey: data.mapKey, state: buildState(socket.roomCode) });
        io.to(socket.roomCode).emit('lobbyUpdate', getLobbyData(socket.roomCode));
    });

    socket.on('adminKick', (data) => {
        const room = rooms[socket.roomCode]; if (!room || room.hostId !== socket.id) return;
        const target = io.sockets.sockets.get(data.pid);
        if (target) { target.emit('kicked'); target.leave(socket.roomCode); }
        delete room.players[data.pid];
        io.to(socket.roomCode).emit('lobbyUpdate', getLobbyData(socket.roomCode));
    });

    socket.on('backToLobby', () => {
        const room = rooms[socket.roomCode]; if (!room || room.hostId !== socket.id) return;
        room.state = 'lobby'; room.match.running = false; room.match.paused = false;
        stopGameLoop(socket.roomCode);
        io.to(socket.roomCode).emit('backToLobby');
    });

    socket.on('leaveRoom',  () => handleLeave(socket));
    socket.on('disconnect', () => handleLeave(socket));
});

function handleLeave(socket) {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    delete room.players[socket.id];
    socket.leave(code); socket.roomCode = null;
    const online = Object.values(room.players).filter(p => p.online !== false);
    if (online.length === 0) { stopGameLoop(code); delete rooms[code]; console.log('Oda silindi:', code); return; }
    if (room.hostId === socket.id) {
        room.hostId = online[0].id;
        io.to(code).emit('newHost', { hostId: room.hostId });
    }
    if (room.state === 'playing') {
        const rc = online.filter(p => p.team === 'red').length;
        const bc = online.filter(p => p.team === 'blue').length;
        if (rc === 0 || bc === 0) {
            room.match.running = false; stopGameLoop(code);
            io.to(code).emit('matchEnd', {
                reason: 'abandoned', winner: rc === 0 ? 'blue' : 'red',
                redScore: room.match.redScore, blueScore: room.match.blueScore,
                stats: room.stats
            });
            room.state = 'lobby';
        }
    }
    io.to(code).emit('lobbyUpdate', getLobbyData(code));
}

process.on('uncaughtException',  (err) => console.error('Hata:', err.message));
process.on('unhandledRejection', (err) => console.error('Promise Hata:', err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`HaxBall Server v6 → 0.0.0.0:${PORT}`);
});
