const express = require('express');
const http    = require('http');
const WebSocket = require('ws');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 3000;

const state = {
  players:      {},
  calledValues: [],
  spinning:     false,
  currentValue: null,
  winners:      [],
};
let wsCounter = 0;

app.use(express.json());
app.use(express.static(__dirname));
app.get('/',            (_req, res) => res.send(HTML_BALOTERA));
app.get('/presentador', (_req, res) => res.send(HTML_PRESENTER));
app.get('/jugar',       (_req, res) => res.send(HTML_PLAYER));
app.get('/admin',       (_req, res) => res.send(HTML_ADMIN));

const send  = (ws, d)   => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(d));
const bcast = (d, skip) => wss.clients.forEach(c => c._id !== skip && send(c, d));

function publicState() {
  return {
    type: 'state',
    calledValues: state.calledValues,
    currentValue: state.currentValue,
    spinning:     state.spinning,
    winners:      state.winners,
    players: Object.values(state.players).map(p => ({
      name:        p.name,
      markedCount: (p.marks || []).filter(Boolean).length,
      bingo:       p.bingo,
    })),
  };
}

wss.on('connection', ws => {
  ws._id   = ++wsCounter;
  ws._role = null;
  send(ws, { type: 'welcome', id: ws._id });
  send(ws, publicState());

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {

      case 'register': {
        ws._role = 'player';
        const name  = String(msg.name).trim().slice(0, 32);
        const board = genBoard();
        const marks = new Array(9).fill(false);
        marks[4] = true;
        state.players[ws._id] = { name, board, marks, bingo: false };
        send(ws, { type: 'board', board, marks });
        send(ws, publicState());
        bcast({ type: 'player_joined', name, total: Object.keys(state.players).length });
        bcast(publicState());
        break;
      }

      case 'mark': {
        const p = state.players[ws._id];
        if (!p || msg.idx === 4 || msg.idx < 0 || msg.idx > 8) break;
        p.marks[msg.idx] = !p.marks[msg.idx];
        send(ws, { type: 'marks', marks: p.marks });
        if (!p.bingo && hasBingo(p.marks)) {
          // Verificar que todos los valores marcados hayan salido en la balotera
          const unmarked = p.board
            .filter((v, i) => i !== 4 && p.marks[i] && !state.calledValues.includes(v));
          if (unmarked.length > 0) {
            // Hay valores marcados que aún no han salido — rechazar
            send(ws, { type: 'bingo_invalid', pending: unmarked });
          } else {
            p.bingo = true;
            state.winners.push(p.name);
            bcast({ type: 'bingo_winner', name: p.name, winners: state.winners });
            bcast(publicState());
          }
        }
        break;
      }

      case 'spin': {
        if (!['presenter','admin'].includes(ws._role) || state.spinning) break;
        const left = VALUES.filter(v => !state.calledValues.includes(v));
        if (!left.length) { send(ws, { type: 'error', msg: 'Todos los valores ya salieron' }); break; }
        state.spinning = true;
        bcast({ type: 'spinning' });
        setTimeout(() => {
          const val = left[Math.floor(Math.random() * left.length)];
          state.calledValues.push(val);
          state.currentValue = val;
          state.spinning     = false;
          bcast({ type: 'value_called', value: val, calledValues: state.calledValues });
          bcast(publicState());
        }, 4200);
        break;
      }

      case 'reset': {
        if (!['presenter','admin'].includes(ws._role)) break;
        state.calledValues = []; state.currentValue = null;
        state.spinning = false;  state.winners = [];
        Object.values(state.players).forEach(p => {
          p.marks = new Array(9).fill(false); p.marks[4] = true; p.bingo = false;
        });
        wss.clients.forEach(c => {
          if (c._role === 'player' && state.players[c._id])
            send(c, { type: 'marks', marks: state.players[c._id].marks });
        });
        bcast(publicState());
        break;
      }

      case 'set_role': {
        ws._role = msg.role;
        send(ws, { type: 'role_set', role: ws._role });
        send(ws, publicState());
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws._role === 'player' && state.players[ws._id]) {
      const name = state.players[ws._id].name;
      delete state.players[ws._id];
      bcast({ type: 'player_left', name, total: Object.keys(state.players).length });
      bcast(publicState());
    }
  });
});

const VALUES = [
  'Compromiso','Solidaridad','Lealtad','Constancia',
  'Perseverancia','Resiliencia','Fortaleza','Superación',
  'Responsabilidad','Integridad','Puntualidad','Honestidad',
  'Liderazgo','Inspiración','Servicio','Tolerancia',
  'Empatía','Gratitud','Colaboración','Creatividad',
  'Respeto','Comunicación','Justicia y equidad','Esperanza',
];

const BALL_COLORS = [
  '#e53935','#e67e22','#d4ac0d','#27ae60','#1e88e5',
  '#8e44ad','#c62828','#ef6c00','#00838f','#1565c0',
  '#6a1b9a','#2e7d32','#ad1457','#00695c','#bf360c',
  '#4527a0','#558b2f','#c62828','#0277bd','#6d4c41',
  '#37474f','#00695c','#7b1fa2','#c2185b',
];

function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
function genBoard() {
  const b = shuffle(VALUES).slice(0, 8);
  b.splice(4, 0, 'LIBRE');
  return b;
}
function hasBingo(marks) {
  // Tablero completo: las 9 celdas marcadas (índice 4 = LIBRE, siempre true)
  const m = [...marks]; m[4] = true;
  return m.every(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VISTA BALOTERA STANDALONE (ruta /)
// ═══════════════════════════════════════════════════════════════════════════════
const HTML_BALOTERA = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Bingo Habilidades Socioemocionales · 27 Jun 2026</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;font-family:'Inter',system-ui,sans-serif;background:#f0f2f7;color:#1a1a3e}
header{height:64px;background:#fff;border-bottom:4px solid #f5c200;padding:0 28px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;box-shadow:0 2px 8px rgba(0,0,0,.08);}
.logo-area{display:flex;align-items:center;gap:14px}
.logo-icon{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#0d1b6e,#1560bd);display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 2px 8px rgba(13,27,110,.3);}
.logo-text h1{font-size:19px;font-weight:800;color:#0d1b6e;letter-spacing:-.3px}
.logo-text p{font-size:12px;color:#999;font-weight:500;margin-top:2px}
.logo-text p span{color:#1560bd;font-weight:700}
.header-btns{display:flex;align-items:center;gap:10px}
.btn-hdr{padding:9px 20px;border-radius:9px;border:1.5px solid #e0e5f0;background:#fff;color:#555;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;transition:all .18s;display:flex;align-items:center;gap:6px;}
.btn-hdr:hover{background:#f5f7fa;border-color:#c5ccd8}
.main{height:calc(100vh - 64px);display:grid;grid-template-columns:1fr 340px;overflow:hidden;}
.left{display:flex;flex-direction:column;align-items:center;justify-content:space-evenly;padding:10px 20px;overflow:hidden;background:#f0f2f7;gap:8px;}
#bombo-canvas{display:block;max-width:100%;flex-shrink:1}
.output-row{display:flex;align-items:center;gap:12px;flex-shrink:0;width:100%;justify-content:center}
.val-card{background:#fff;border-radius:14px;border-left:5px solid #f5c200;padding:12px 22px;min-width:220px;box-shadow:0 2px 12px rgba(0,0,0,.08);flex-shrink:0;}
.vc-label{font-size:9px;font-weight:800;letter-spacing:1.8px;text-transform:uppercase;color:#f5c200;margin-bottom:5px}
.vc-val{font-size:clamp(18px,2.2vw,28px);font-weight:900;color:#0d1b6e;line-height:1.1;min-height:32px}
.arrow-lbl{font-size:22px;color:#c5ccd8;flex-shrink:0;transition:opacity .3s}
.stand{display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0}
.stand-base{width:72px;height:6px;border-radius:3px;background:linear-gradient(90deg,#7B4F1A,#A07028,#7B4F1A)}
.stand-pole{width:5px;height:16px;background:linear-gradient(90deg,#7B4F1A,#C4922A,#7B4F1A);border-radius:2px}
.ball-slot{width:66px;height:66px;border-radius:50%;border:2px dashed #d0d8e8;display:flex;align-items:center;justify-content:center;background:#e8ecf5;overflow:hidden}
.ball-slot.has-ball{border-color:transparent;background:transparent}
#stand-ball{width:62px;height:62px;border-radius:50%;display:none;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:5px;font-weight:900;font-size:9px;line-height:1.2;color:#fff;word-break:break-word;box-shadow:inset -4px -4px 9px rgba(0,0,0,.22),inset 2px 2px 5px rgba(255,255,255,.22),0 4px 12px rgba(0,0,0,.2);transform:scale(0);transition:transform .45s cubic-bezier(.34,1.56,.64,1);}
#stand-ball.show{display:flex;transform:scale(1)}
.stand-lbl{font-size:8px;color:#aaa;font-weight:700;letter-spacing:.8px;text-transform:uppercase}
.chips-row{display:flex;flex-wrap:wrap;gap:5px;justify-content:center;width:100%;max-height:54px;overflow-y:auto;flex-shrink:0}
.chip{padding:3px 11px;border-radius:20px;font-size:10px;font-weight:700;background:#fff;border:1.5px solid #d0d8ee;color:#555}
.chip.latest{background:#f5c200;border-color:#e6b800;color:#0d1b6e}
.btn-spin{background:linear-gradient(135deg,#0d1b6e,#1560bd);color:#fff;border:none;border-radius:10px;padding:12px 40px;font-family:inherit;font-size:15px;font-weight:800;cursor:pointer;transition:all .2s;flex-shrink:0;box-shadow:0 4px 14px rgba(21,96,189,.35);display:flex;align-items:center;gap:8px;letter-spacing:.2px;}
.btn-spin:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 18px rgba(21,96,189,.4)}
.btn-spin:disabled{opacity:.38;cursor:default;transform:none}
.side{background:#fff;border-left:1px solid #e4e8f0;display:flex;flex-direction:column;overflow:hidden}
.side-section{padding:16px 18px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid #edf0f7}
.side-section:last-child{border-bottom:none}
.sec-title{font-size:11px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:#1560bd;display:flex;align-items:center;gap:8px}
.sec-title::before{content:'';display:inline-block;width:4px;height:14px;background:#f5c200;border-radius:2px}
.hist-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;max-height:200px}
.hb-row{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:10px;border-left:3px solid transparent}
.hb-row.latest{background:#f5f8ff;border-left-color:#1560bd}
.hb-dot{width:36px;height:36px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:800;color:#fff;box-shadow:inset -2px -2px 4px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.15)}
.hb-info{display:flex;flex-direction:column;gap:2px}
.hb-name{font-size:14px;font-weight:700;color:#1a1a3e}
.hb-row.latest .hb-name{color:#0d1b6e;font-size:15px}
.hb-badge{font-size:9px;font-weight:700;color:#1560bd;background:#e8f0fe;padding:2px 8px;border-radius:10px;align-self:flex-start}
.count-bar{display:flex;align-items:center;justify-content:space-between;background:#f5f8ff;border-radius:10px;padding:10px 14px;}
.count-num{font-size:28px;font-weight:900;color:#0d1b6e;line-height:1}
.count-label{font-size:11px;color:#aaa;font-weight:600;margin-top:2px}
.count-total{font-size:12px;color:#bbb;font-weight:600;align-self:flex-end}
.progress-wrap{height:8px;background:#e8ecf5;border-radius:4px;overflow:hidden}
.progress-bar{height:100%;background:linear-gradient(90deg,#1560bd,#29aae1);border-radius:4px;transition:width .5s ease}
.link-banner{background:#fff;border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0;border:1.5px solid #e0e5f0;box-shadow:0 2px 8px rgba(0,0,0,.06);}
.link-icon{font-size:20px;flex-shrink:0}
.link-info{flex:1;min-width:0}
.link-label{font-size:9px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:#aaa;margin-bottom:3px}
.link-url{font-size:12px;font-weight:800;color:#1560bd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.btn-copy{padding:7px 14px;border-radius:8px;background:#e8f0fe;color:#1560bd;font-family:inherit;font-size:11px;font-weight:800;cursor:pointer;flex-shrink:0;transition:all .18s;border:1.5px solid #c5d8ff;}
.btn-copy:hover{background:#d0e2fd}
.btn-copy.copied{background:rgba(39,174,96,.12);color:#27ae60;border-color:rgba(39,174,96,.3)}
#val-overlay{display:none;position:fixed;inset:0;z-index:200;background:rgba(13,27,110,.92);backdrop-filter:blur(4px);flex-direction:column;align-items:center;justify-content:center;gap:20px;cursor:pointer;}
#val-overlay.show{display:flex}
.ov-ball{width:clamp(160px,22vw,220px);height:clamp(160px,22vw,220px);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:20px;font-weight:900;color:#fff;box-shadow:inset -12px -12px 24px rgba(0,0,0,.25),inset 6px 6px 14px rgba(255,255,255,.22),0 12px 40px rgba(0,0,0,.4);animation:ballIn .5s cubic-bezier(.34,1.56,.64,1);}
@keyframes ballIn{from{transform:scale(0) translateY(-40px);opacity:0}to{transform:scale(1) translateY(0);opacity:1}}
.ov-val-text{font-size:clamp(24px,4vw,38px);line-height:1.15;word-break:break-word}
.ov-title{font-size:clamp(13px,1.5vw,18px);color:rgba(255,255,255,.7);font-weight:600;letter-spacing:.5px}
.ov-hint{font-size:13px;color:rgba(255,255,255,.45);font-weight:500;margin-top:8px}
.ov-close{padding:10px 28px;border-radius:10px;border:2px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;transition:all .18s;}
.ov-close:hover{background:rgba(255,255,255,.22)}
#winner-overlay{display:none;position:fixed;inset:0;z-index:300;background:rgba(240,242,247,.96);backdrop-filter:blur(10px);flex-direction:column;align-items:center;justify-content:center;gap:16px}
#winner-overlay.show{display:flex}
.w-emoji{font-size:80px;animation:pop .4s ease}
@keyframes pop{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}
.w-title{font-size:clamp(44px,7vw,72px);font-weight:900;color:#f5c200;text-shadow:0 3px 0 #b8960a;letter-spacing:-1px}
.w-winner-name{font-size:clamp(22px,3.5vw,40px);font-weight:800;color:#0d1b6e}
.w-sub{font-size:14px;color:#777;font-weight:500}
.btn-cont{padding:11px 30px;border-radius:10px;border:none;background:linear-gradient(135deg,#0d1b6e,#1560bd);color:#fff;font-family:inherit;font-size:14px;font-weight:800;cursor:pointer;margin-top:4px;}
#confetti-canvas{position:fixed;inset:0;pointer-events:none;z-index:400}
#bingo-modal{display:none;position:fixed;inset:0;z-index:250;background:rgba(0,0,0,.4);backdrop-filter:blur(4px);align-items:center;justify-content:center}
#bingo-modal.show{display:flex}
.modal-box{background:#fff;border-radius:18px;padding:28px 32px;max-width:400px;width:90%;box-shadow:0 12px 40px rgba(0,0,0,.2);display:flex;flex-direction:column;gap:14px}
.modal-title{font-size:18px;font-weight:900;color:#0d1b6e}
.modal-sub{font-size:13px;color:#888;font-weight:500}
.modal-input{width:100%;padding:12px 16px;border-radius:10px;border:2px solid #e0e5f0;font-family:inherit;font-size:15px;font-weight:700;color:#1a1a3e;outline:none;transition:border-color .2s}
.modal-input:focus{border-color:#1560bd}
.modal-btns{display:flex;gap:10px}
.modal-btn{flex:1;padding:12px;border-radius:10px;border:none;font-family:inherit;font-size:14px;font-weight:800;cursor:pointer}
.modal-btn.confirm{background:linear-gradient(135deg,#0d1b6e,#1560bd);color:#fff;}
.modal-btn.cancel{background:#f0f2f7;color:#666;border:1.5px solid #e0e5f0}
</style>
</head>
<body>
<canvas id="confetti-canvas"></canvas>
<div id="val-overlay" onclick="closeValOverlay()">
  <div class="ov-title">¡VALOR EN JUEGO!</div>
  <div class="ov-ball" id="ov-ball"><div class="ov-val-text" id="ov-val-text">—</div></div>
  <div class="ov-hint">Toca en cualquier lugar para cerrar</div>
  <button class="ov-close" onclick="closeValOverlay()">Continuar →</button>
</div>
<div id="winner-overlay">
  <div class="w-emoji">🎉</div>
  <div class="w-title">¡BINGO!</div>
  <div class="w-winner-name" id="w-winner-name">¡Alguien ganó!</div>
  <div class="w-sub">Pídele que comparta algo sobre sí mismo</div>
  <button class="btn-cont" onclick="document.getElementById('winner-overlay').classList.remove('show')">Continuar →</button>
</div>
<div id="bingo-modal">
  <div class="modal-box">
    <div class="modal-title">🏆 ¿Quién gritó BINGO?</div>
    <div class="modal-sub">Escribe el nombre del participante ganador</div>
    <input class="modal-input" id="bingo-name-input" type="text" placeholder="Nombre del ganador..." maxlength="40"/>
    <div class="modal-btns">
      <button class="modal-btn cancel" onclick="document.getElementById('bingo-modal').classList.remove('show')">Cancelar</button>
      <button class="modal-btn confirm" onclick="confirmBingo()">¡Celebrar! 🎉</button>
    </div>
  </div>
</div>
<header>
  <div class="logo-area">
    <div class="logo-icon">🎱</div>
    <div class="logo-text">
      <h1>Bingo Habilidades Socioemocionales</h1>
      <p>Reunión Equipos Zonales · <span>27 Jun 2026</span></p>
    </div>
  </div>
  <div class="header-btns">
    <button class="btn-hdr" onclick="resetGame()">↺ Reiniciar</button>
  </div>
</header>
<div class="main">
  <div class="left">
    <div style="position:relative;display:flex;align-items:center;justify-content:center;width:100%;flex-shrink:1;min-height:0">
      <img src="/Hormy.png" alt="Hormy" style="position:absolute;left:0;bottom:0;height:clamp(80px,14vh,160px);object-fit:contain;z-index:2;pointer-events:none;filter:drop-shadow(2px 4px 8px rgba(0,0,0,.15))"/>
      <canvas id="bombo-canvas"></canvas>
    </div>
    <div class="output-row">
      <div class="val-card">
        <div class="vc-label">● Valor en juego</div>
        <div class="vc-val" id="cur-val">¡Gira la balotera!</div>
      </div>
      <div class="arrow-lbl" id="arrow-out" style="opacity:0">→</div>
      <div class="stand">
        <div class="ball-slot" id="ball-slot"><div id="stand-ball"></div></div>
        <div class="stand-pole"></div>
        <div class="stand-base"></div>
        <div class="stand-lbl">SALIÓ</div>
      </div>
    </div>
    <button class="btn-spin" id="btn-spin" onclick="spin()">🎱 Girar la balotera</button>
    <div class="chips-row" id="called-wrap"></div>
  </div>
  <div class="side">
    <div class="side-section" style="flex:0 0 auto">
      <div class="sec-title">Progreso</div>
      <div class="count-bar">
        <div><div class="count-num" id="count-num">0</div><div class="count-label">valores llamados</div></div>
        <div class="count-total">de 24</div>
      </div>
      <div class="progress-wrap"><div class="progress-bar" id="progress-bar" style="width:0%"></div></div>
    </div>
    <div class="side-section" style="flex:0 0 auto">
      <div class="sec-title">Últimas bolas</div>
      <div class="hist-list" id="hist-list"><span style="font-size:12px;color:#ccc;font-weight:500">Ninguna aún — gira la balotera</span></div>
    </div>
    <div class="side-section" style="flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column">
      <div class="sec-title">Participantes <span id="player-count" style="background:#e8f0fe;color:#1560bd;border-radius:20px;padding:1px 9px;font-size:10px;font-weight:800;margin-left:4px">0</span></div>
      <div id="players-list" style="display:flex;flex-direction:column;gap:4px;overflow-y:auto;flex:1">
        <span style="font-size:12px;color:#ccc;font-weight:500">Esperando participantes...</span>
      </div>
    </div>
    <div class="side-section" style="flex:0 0 auto;max-height:120px;overflow-y:auto">
      <div class="sec-title">Ganadores</div>
      <div id="winners-list" style="display:flex;flex-direction:column;gap:4px">
        <span style="font-size:12px;color:#ccc;font-weight:500">Nadie ha ganado aún</span>
      </div>
    </div>
    <div class="side-section" style="flex:0 0 auto">
      <div class="sec-title">Enlace para jugadores</div>
      <div class="link-banner">
        <div class="link-icon">📱</div>
        <div class="link-info">
          <div class="link-label">Tablero de cada participante</div>
          <div class="link-url">https://bingo-m31a.onrender.com/jugar</div>
        </div>
        <button class="btn-copy" id="btn-copy" onclick="navigator.clipboard.writeText('https://bingo-m31a.onrender.com/jugar').then(()=>{this.textContent='¡Copiado!';this.classList.add('copied');setTimeout(()=>{this.textContent='Copiar';this.classList.remove('copied')},2000)})">Copiar</button>
      </div>
    </div>
  </div>
</div>
<script>
const VALUES=["Compromiso","Solidaridad","Lealtad","Constancia","Perseverancia","Resiliencia","Fortaleza","Superación","Responsabilidad","Integridad","Puntualidad","Honestidad","Liderazgo","Inspiración","Servicio","Tolerancia","Empatía","Gratitud","Colaboración","Creatividad","Respeto","Comunicación","Justicia y equidad","Esperanza"];
const BALL_COLORS=["#e53935","#e67e22","#d4ac0d","#27ae60","#1e88e5","#8e44ad","#c62828","#ef6c00","#00838f","#1565c0","#6a1b9a","#2e7d32","#ad1457","#00695c","#bf360c","#4527a0","#558b2f","#c62828","#0277bd","#6d4c41","#37474f","#00695c","#7b1fa2","#c2185b"];
let calledValues=[],isSpinning=false,drumAngle=0,lastT=0,winners=[];
const FLOAT_BALLS=VALUES.map((v,i)=>({v,color:BALL_COLORS[i%BALL_COLORS.length],x:0,y:0,vx:(Math.random()-.5)*1.2,vy:(Math.random()-.5)*1.2}));
const BC=document.getElementById('bombo-canvas');
const bctx=BC.getContext('2d');
function resizeCanvas(){const panel=BC.parentElement;const availH=Math.max(100,panel.clientHeight-190);const availW=panel.clientWidth-32;const W=Math.min(availW,availH/0.60,520);const H=Math.round(W*0.60);BC.width=W;BC.height=H;FLOAT_BALLS.forEach(b=>{b.x=W*0.43+(Math.random()-.5)*W*.20;b.y=H*.50+(Math.random()-.5)*H*.20;});}
resizeCanvas();window.addEventListener('resize',resizeCanvas);
function drawScene(ts){const W=BC.width,H=BC.height;bctx.clearRect(0,0,W,H);const cx=W*.43,cy=H*.50,rx=W*.31,ry=H*.42;[cx-rx*.68,cx+rx*.68].forEach(lx=>{bctx.fillStyle='#6B3D14';bctx.fillRect(lx-7,cy+ry*.58,14,H*.20);bctx.fillStyle='#4A2A0A';bctx.fillRect(lx-13,cy+ry*.58+H*.20-4,26,8);});bctx.strokeStyle='#A0622A';bctx.lineWidth=6;bctx.beginPath();bctx.moveTo(cx-rx*.84,cy);bctx.lineTo(cx+rx*.90,cy);bctx.stroke();const mX=cx+rx*.90,mY=cy;bctx.strokeStyle='#C4922A';bctx.lineWidth=4;bctx.beginPath();bctx.moveTo(mX,mY);bctx.lineTo(mX+18,mY);bctx.stroke();const ca=ts*3;bctx.beginPath();bctx.moveTo(mX+18,mY);bctx.lineTo(mX+18+Math.cos(ca)*12,mY+Math.sin(ca)*12);bctx.strokeStyle='#8B5A1A';bctx.lineWidth=3.5;bctx.stroke();bctx.beginPath();bctx.arc(mX+18+Math.cos(ca)*12,mY+Math.sin(ca)*12,4,0,Math.PI*2);bctx.fillStyle='#6B3D14';bctx.fill();bctx.save();bctx.beginPath();bctx.ellipse(cx,cy,rx*.90,ry*.88,0,0,Math.PI*2);bctx.clip();const bg=bctx.createRadialGradient(cx-rx*.2,cy-ry*.2,6,cx,cy,rx);bg.addColorStop(0,'rgba(230,240,255,0.98)');bg.addColorStop(1,'rgba(200,222,255,0.95)');bctx.fillStyle=bg;bctx.fill();bctx.save();bctx.translate(cx,cy);bctx.rotate(drumAngle);for(let i=0;i<8;i++){const a=i*Math.PI/4;bctx.strokeStyle='rgba(139,90,20,.40)';bctx.lineWidth=2.5;bctx.beginPath();bctx.moveTo(Math.cos(a)*rx*.14,Math.sin(a)*ry*.14);bctx.lineTo(Math.cos(a)*rx*.86,Math.sin(a)*ry*.86);bctx.stroke();}bctx.restore();const ballR=Math.min(rx,ry)*.108;FLOAT_BALLS.forEach(b=>{if(calledValues.includes(b.v))return;b.x+=b.vx;b.y+=b.vy;const dx=(b.x-cx)/rx,dy=(b.y-cy)/ry;if(dx*dx+dy*dy>.58){b.vx*=-.88;b.vy*=-.88;b.x=cx+(b.x-cx)*.94;b.y=cy+(b.y-cy)*.94;}if(!isSpinning){if(Math.abs(b.vx)<.22)b.vx+=(Math.random()-.5)*.045;if(Math.abs(b.vy)<.22)b.vy+=(Math.random()-.5)*.045;}const g=bctx.createRadialGradient(b.x-ballR*.3,b.y-ballR*.3,1,b.x,b.y,ballR);g.addColorStop(0,'rgba(255,255,255,.58)');g.addColorStop(1,b.color);bctx.beginPath();bctx.arc(b.x,b.y,ballR,0,Math.PI*2);bctx.fillStyle=g;bctx.fill();bctx.strokeStyle='rgba(0,0,0,.08)';bctx.lineWidth=1;bctx.stroke();const fs=Math.max(5.5,ballR*.46);bctx.font='800 '+fs+'px Inter,sans-serif';bctx.textAlign='center';bctx.textBaseline='middle';bctx.fillStyle='#fff';bctx.shadowColor='rgba(0,0,0,.4)';bctx.shadowBlur=2;const words=b.v.split(' ');if(words.length===1||b.v.length<=7)bctx.fillText(b.v.length>8?b.v.slice(0,8):b.v,b.x,b.y);else{bctx.fillText(words[0].slice(0,8),b.x,b.y-fs*.62);bctx.fillText(words[1].slice(0,8),b.x,b.y+fs*.62);}bctx.shadowBlur=0;});bctx.restore();const frame=bctx.createLinearGradient(cx-rx,cy-ry,cx+rx,cy+ry);frame.addColorStop(0,'#C4922A');frame.addColorStop(.5,'#F5C200');frame.addColorStop(1,'#8B5A2B');bctx.strokeStyle=frame;bctx.lineWidth=13;bctx.beginPath();bctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2);bctx.stroke();bctx.strokeStyle='rgba(255,255,255,.38)';bctx.lineWidth=3.5;bctx.beginPath();bctx.ellipse(cx,cy-ry*.08,rx*.66,ry*.20,-0.5,Math.PI*1.18,Math.PI*1.88);bctx.stroke();bctx.beginPath();bctx.arc(cx,cy,7,0,Math.PI*2);bctx.fillStyle='#6B3D14';bctx.fill();bctx.strokeStyle='#F5C200';bctx.lineWidth=2;bctx.stroke();const tX=cx+rx+1,tY=cy,tW=W*.085,tH=ry*.28;const tg=bctx.createLinearGradient(tX,tY-tH,tX,tY+tH);tg.addColorStop(0,'#C4922A');tg.addColorStop(1,'#8B5A2B');bctx.fillStyle=tg;bctx.beginPath();bctx.roundRect(tX,tY-tH/2,tW,tH,4);bctx.fill();bctx.strokeStyle='#6B3D14';bctx.lineWidth=1.5;bctx.stroke();}
function animFlyBall(color,value,onDone){const W=BC.width,H=BC.height,cx=W*.43,cy=H*.50,rx=W*.31;const sX=cx+rx+W*.02,sY=cy,eX=sX+W*.10;const ballR=Math.min(W,H)*.075;let t=0;function frame(){t+=.045;const p=Math.min(t,1);const px=sX+(eX-sX)*p,py=sY-Math.sin(p*Math.PI)*H*.09;bctx.save();const g=bctx.createRadialGradient(px-ballR*.3,py-ballR*.3,1,px,py,ballR);g.addColorStop(0,'rgba(255,255,255,.52)');g.addColorStop(1,color);bctx.beginPath();bctx.arc(px,py,ballR,0,Math.PI*2);bctx.fillStyle=g;bctx.fill();bctx.strokeStyle='rgba(0,0,0,.10)';bctx.lineWidth=1.5;bctx.stroke();bctx.fillStyle='#fff';const fs=Math.max(7,ballR*.40);bctx.font='800 '+fs+'px Inter,sans-serif';bctx.textAlign='center';bctx.textBaseline='middle';bctx.shadowColor='rgba(0,0,0,.4)';bctx.shadowBlur=2;const words=value.split(' ');if(words.length===1||value.length<=7)bctx.fillText(value.slice(0,8),px,py);else{bctx.fillText(words[0].slice(0,8),px,py-fs*.58);bctx.fillText(words[1].slice(0,8),px,py+fs*.58);}bctx.shadowBlur=0;bctx.restore();if(t<1)requestAnimationFrame(frame);else onDone&&onDone();}requestAnimationFrame(frame);}
function mainLoop(ts){const dt=(ts-lastT)/1000;lastT=ts;drumAngle+=isSpinning?dt*4.6:dt*.32;drawScene(ts/1000);requestAnimationFrame(mainLoop);}
requestAnimationFrame(mainLoop);
function showStandBall(value,color){const sb=document.getElementById('stand-ball');sb.classList.remove('show');sb.style.background='radial-gradient(circle at 35% 35%,rgba(255,255,255,.45),'+color+')';const words=value.split(' ');sb.innerHTML=words.map(w=>'<span style="display:block;font-size:'+(words.length>1?'7.5px':'9.5px')+';line-height:1.25;font-weight:900">'+esc(w)+'</span>').join('');document.getElementById('ball-slot').classList.add('has-ball');document.getElementById('arrow-out').style.opacity='1';setTimeout(()=>sb.classList.add('show'),60);}
function spin(){if(isSpinning)return;ws&&ws.readyState===1&&ws.send(JSON.stringify({type:'spin'}));}
function showValOverlay(value,color){const ball=document.getElementById('ov-ball');ball.style.background='radial-gradient(circle at 35% 35%,rgba(255,255,255,.38),'+color+')';ball.style.boxShadow='inset -12px -12px 24px rgba(0,0,0,.25),inset 6px 6px 14px rgba(255,255,255,.18),0 12px 40px '+color+'88';document.getElementById('ov-val-text').textContent=value;document.getElementById('val-overlay').classList.add('show');}
function closeValOverlay(){document.getElementById('val-overlay').classList.remove('show');}
function renderChips(){const latest=calledValues[calledValues.length-1];document.getElementById('called-wrap').innerHTML=calledValues.map(v=>'<span class="chip'+(v===latest?' latest':'')+'">'+esc(v)+'</span>').join('');}
function renderHistList(){const el=document.getElementById('hist-list');if(!calledValues.length){el.innerHTML='<span style="font-size:12px;color:#ccc;font-weight:500">Ninguna aún — gira la balotera</span>';return;}const rev=[...calledValues].reverse().slice(0,8);el.innerHTML=rev.map((v,i)=>{const idx=VALUES.indexOf(v);const col=BALL_COLORS[idx%BALL_COLORS.length];return '<div class="hb-row'+(i===0?' latest':'')+'"><div class="hb-dot" style="background:radial-gradient(circle at 35% 35%,rgba(255,255,255,.45),'+col+')">'+v.slice(0,3).toUpperCase()+'</div><div class="hb-info"><span class="hb-name">'+esc(v)+'</span>'+(i===0?'<span class="hb-badge">● Actual</span>':'')+'</div></div>';}).join('');}
function renderWinners(){const el=document.getElementById('winners-list');if(!winners.length){el.innerHTML='<span style="font-size:12px;color:#ccc;font-weight:500">Nadie ha ganado aún</span>';return;}el.innerHTML=winners.map(w=>'<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:10px;background:#f0fdf4;border-left:3px solid #27ae60;font-size:13px;font-weight:700;color:#1a1a3e"><span style="font-size:16px">🏆</span> '+esc(w)+'</div>').join('');}
function confirmBingo(){const name=document.getElementById('bingo-name-input').value.trim()||'Un participante';document.getElementById('bingo-modal').classList.remove('show');winners.push(name);renderWinners();document.getElementById('w-winner-name').textContent=name;document.getElementById('winner-overlay').classList.add('show');launchConfetti();}
document.getElementById('bingo-name-input').addEventListener('keydown',e=>{if(e.key==='Enter')confirmBingo();if(e.key==='Escape')document.getElementById('bingo-modal').classList.remove('show');});
function resetGame(){if(!confirm('¿Reiniciar el juego? Se borrará el progreso.'))return;ws&&ws.readyState===1&&ws.send(JSON.stringify({type:'reset'}));}
function renderPlayers(players){const el=document.getElementById('players-list');const cnt=document.getElementById('player-count');if(!players||!players.length){el.innerHTML='<span style="font-size:12px;color:#ccc;font-weight:500">Esperando participantes...</span>';cnt.textContent='0';return;}cnt.textContent=players.length;el.innerHTML=players.map(p=>{const initials=p.name.trim().split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();const hue=p.name.split('').reduce((a,c)=>a+c.charCodeAt(0),0)%360;return '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;background:#f5f8ff;border-left:3px solid hsl('+hue+',60%,48%)">'+    '<div style="width:28px;height:28px;border-radius:50%;background:hsl('+hue+',60%,48%);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:900;color:#fff;flex-shrink:0">'+initials+'</div>'+    '<div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:700;color:#1a1a3e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(p.name)+'</div>'+    '<div style="font-size:9px;color:#aaa;font-weight:600">'+p.markedCount+' marcados'+(p.bingo?' · 🏆 BINGO':'')+'</div></div></div>';}).join('');}
function applyServerState(s){calledValues=s.calledValues||[];winners=s.winners||[];isSpinning=!!s.spinning;document.getElementById('count-num').textContent=calledValues.length;document.getElementById('progress-bar').style.width=(calledValues.length/24*100)+'%';renderChips();renderHistList();renderWinners();renderPlayers(s.players||[]);if(s.currentValue){const idx=VALUES.indexOf(s.currentValue);const col=BALL_COLORS[idx%BALL_COLORS.length];document.getElementById('cur-val').textContent=s.currentValue;showStandBall(s.currentValue,col);}document.getElementById('btn-spin').disabled=isSpinning;}
const cc=document.getElementById('confetti-canvas');const ccx=cc.getContext('2d');
function launchConfetti(){cc.width=innerWidth;cc.height=innerHeight;const ps=Array.from({length:200},()=>({x:Math.random()*cc.width,y:-10,w:7+Math.random()*9,h:3+Math.random()*5,color:['#f5c200','#1e88e5','#0d1b6e','#27ae60','#e53935','#8e44ad'][Math.floor(Math.random()*6)],speed:2.5+Math.random()*4,angle:Math.random()*Math.PI*2,spin:(Math.random()-.5)*.18,drift:(Math.random()-.5)*2}));(function loop(){ccx.clearRect(0,0,cc.width,cc.height);const r=ps.filter(p=>p.y<cc.height+20);r.forEach(p=>{p.y+=p.speed;p.x+=p.drift;p.angle+=p.spin;ccx.save();ccx.translate(p.x,p.y);ccx.rotate(p.angle);ccx.fillStyle=p.color;ccx.fillRect(-p.w/2,-p.h/2,p.w,p.h);ccx.restore();});if(r.length)requestAnimationFrame(loop);else ccx.clearRect(0,0,cc.width,cc.height);})();}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
let ws;
function conectar(){
  const proto=location.protocol==='https:'?'wss':'ws';
  ws=new WebSocket(proto+'://'+location.host);
  ws.onopen=()=>ws.send(JSON.stringify({type:'set_role',role:'presenter'}));
  ws.onmessage=e=>{
    let m;try{m=JSON.parse(e.data);}catch{return;}
    if(m.type==='state'){applyServerState(m);}
    else if(m.type==='spinning'){isSpinning=true;document.getElementById('btn-spin').disabled=true;document.getElementById('cur-val').textContent='Girando...';}
    else if(m.type==='value_called'){
      const val=m.value;calledValues=m.calledValues;isSpinning=false;
      document.getElementById('cur-val').textContent=val;
      document.getElementById('count-num').textContent=calledValues.length;
      document.getElementById('progress-bar').style.width=(calledValues.length/24*100)+'%';
      renderChips();renderHistList();
      const idx=VALUES.indexOf(val);const color=BALL_COLORS[idx%BALL_COLORS.length];
      animFlyBall(color,val,()=>{showStandBall(val,color);showValOverlay(val,color);});
      document.getElementById('btn-spin').disabled=false;
    }
    else if(m.type==='bingo_winner'){winners=m.winners;renderWinners();document.getElementById('w-winner-name').textContent=m.name;document.getElementById('winner-overlay').classList.add('show');launchConfetti();}
    else if(m.type==='player_joined'||m.type==='player_left'){/* state update follows */}
  };
  ws.onclose=()=>setTimeout(conectar,2000);
}
conectar();
</script>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════════════════════
//  VISTA PRESENTADOR
// ═══════════════════════════════════════════════════════════════════════════════
const HTML_PRESENTER = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Balotera · Presentador</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{font-family:'Inter',system-ui,sans-serif;background:#f0f2f7;color:#1a1a3e;display:flex;flex-direction:column;}

/* ─── HEADER ─────────────────────────────────────────── */
header{
  background:#fff;
  border-bottom:4px solid #f5c200;
  padding:0 28px;
  height:64px;
  flex-shrink:0;
  display:flex;align-items:center;justify-content:space-between;
  box-shadow:0 2px 8px rgba(0,0,0,.08);
}
.logo-area{display:flex;align-items:center;gap:14px}
.logo-icon{
  width:44px;height:44px;border-radius:12px;
  background:linear-gradient(135deg,#0d1b6e,#1560bd);
  display:flex;align-items:center;justify-content:center;
  font-size:22px;flex-shrink:0;
  box-shadow:0 2px 8px rgba(13,27,110,.3);
}
.logo-text h1{font-size:19px;font-weight:800;color:#0d1b6e;letter-spacing:-.3px}
.logo-text p{font-size:12px;color:#999;font-weight:500;margin-top:2px}
.logo-text p span{color:#1560bd;font-weight:700}
.btn-reiniciar{
  padding:9px 20px;border-radius:9px;border:1.5px solid #e0e5f0;
  background:#fff;color:#555;font-family:inherit;font-size:13px;font-weight:700;
  cursor:pointer;transition:all .18s;display:flex;align-items:center;gap:6px;
}
.btn-reiniciar:hover{background:#f5f7fa;border-color:#c5ccd8}

/* ─── LAYOUT ─────────────────────────────────────────── */
.main{flex:1;min-height:0;display:grid;grid-template-columns:1fr 320px;overflow:hidden}

/* ─── PANEL IZQUIERDO ────────────────────────────────── */
.left{
  display:flex;flex-direction:column;
  align-items:center;justify-content:space-evenly;
  padding:10px 20px;overflow:hidden;background:#f0f2f7;gap:8px;
}

/* Balotera canvas */
#bombo-canvas{display:block;max-width:100%;flex-shrink:1}

/* Fila de salida */
.output-row{display:flex;align-items:center;gap:10px;flex-shrink:0;width:100%;justify-content:center}

/* Tarjeta "VALOR EN JUEGO" — estilo cronograma */
.val-card{
  background:#fff;
  border-radius:12px;
  border-left:5px solid #f5c200;
  padding:10px 18px;
  min-width:210px;
  box-shadow:0 2px 10px rgba(0,0,0,.07);
  flex-shrink:0;
}
.val-card .vc-label{
  font-size:9px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;
  color:#f5c200;margin-bottom:4px;
}
.val-card .vc-val{
  font-size:clamp(17px,2vw,26px);font-weight:900;color:#0d1b6e;
  line-height:1.1;min-height:30px;
}

.arrow-lbl{font-size:20px;color:#c5ccd8;flex-shrink:0;transition:opacity .3s}

/* Soporte */
.stand{display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0}
.stand-base{width:72px;height:6px;border-radius:3px;background:linear-gradient(90deg,#7B4F1A,#A07028,#7B4F1A)}
.stand-pole{width:5px;height:16px;background:linear-gradient(90deg,#7B4F1A,#C4922A,#7B4F1A);border-radius:2px}
.ball-slot{width:62px;height:62px;border-radius:50%;border:2px dashed #d0d8e8;display:flex;align-items:center;justify-content:center;background:#e8ecf5;overflow:hidden}
.ball-slot.has-ball{border-color:transparent;background:transparent}
#stand-ball{width:58px;height:58px;border-radius:50%;display:none;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:5px;font-weight:900;font-size:9px;line-height:1.2;color:#fff;word-break:break-word;box-shadow:inset -4px -4px 9px rgba(0,0,0,.22),inset 2px 2px 5px rgba(255,255,255,.22),0 4px 12px rgba(0,0,0,.2);transform:scale(0);transition:transform .45s cubic-bezier(.34,1.56,.64,1)}
#stand-ball.show{display:flex;transform:scale(1)}
.stand-lbl{font-size:8px;color:#aaa;font-weight:700;letter-spacing:.8px;text-transform:uppercase}

/* Historial chips */
.chips-row{
  display:flex;flex-wrap:wrap;gap:5px;justify-content:center;
  width:100%;max-height:52px;overflow-y:auto;flex-shrink:0;
}
.chip{
  padding:3px 11px;border-radius:20px;font-size:10px;font-weight:700;
  background:#fff;border:1.5px solid #d0d8ee;color:#555;
}
.chip.latest{background:#f5c200;border-color:#e6b800;color:#0d1b6e}

/* Botón girar */
.btn-spin{
  background:linear-gradient(135deg,#0d1b6e,#1560bd);
  color:#fff;border:none;border-radius:10px;
  padding:11px 36px;font-family:inherit;font-size:14px;font-weight:800;
  cursor:pointer;transition:all .18s;flex-shrink:0;
  box-shadow:0 4px 14px rgba(21,96,189,.35);
  display:flex;align-items:center;gap:8px;
  letter-spacing:.2px;
}
.btn-spin:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 18px rgba(21,96,189,.4)}
.btn-spin:disabled{opacity:.38;cursor:default;transform:none}

/* ─── PANEL DERECHO ──────────────────────────────────── */
.side{
  background:#fff;
  border-left:1px solid #e4e8f0;
  display:flex;flex-direction:column;overflow:hidden;
}
.side-section{
  padding:16px 18px;
  display:flex;flex-direction:column;gap:8px;
  border-bottom:1px solid #edf0f7;
}
.side-section:last-child{border-bottom:none}
.sec-title{
  font-size:11px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;
  color:#1560bd;display:flex;align-items:center;gap:8px;
}
.sec-title::before{content:'';display:inline-block;width:4px;height:14px;background:#f5c200;border-radius:2px}

/* Últimas bolas */
.hist-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;max-height:180px}
.hb-row{
  display:flex;align-items:center;gap:10px;
  padding:7px 10px;border-radius:10px;
  border-left:3px solid transparent;
  transition:background .15s;
}
.hb-row.latest{background:#f5f8ff;border-left-color:#1560bd}
.hb-dot{
  width:36px;height:36px;border-radius:50%;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;
  font-size:8px;font-weight:800;color:#fff;
  box-shadow:inset -2px -2px 4px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.15);
}
.hb-info{display:flex;flex-direction:column;gap:2px}
.hb-name{font-size:14px;font-weight:700;color:#1a1a3e}
.hb-row.latest .hb-name{color:#0d1b6e;font-size:15px}
.hb-badge{font-size:9px;font-weight:700;color:#1560bd;background:#e8f0fe;padding:2px 8px;border-radius:10px;align-self:flex-start}

/* Participantes */
.players-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:5px}
.p-card{
  display:flex;align-items:center;gap:10px;
  padding:8px 10px;border-radius:10px;
  border-left:3px solid #e4e8f0;
  background:#fafbfd;transition:all .15s;
}
.p-card.bingo{border-left-color:#27ae60;background:#f0fdf4}
.p-avatar{
  width:34px;height:34px;border-radius:9px;
  background:linear-gradient(135deg,#0d1b6e,#1560bd);
  color:#fff;display:flex;align-items:center;justify-content:center;
  font-weight:800;font-size:13px;flex-shrink:0;
}
.p-info{flex:1;min-width:0}
.p-name{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#1a1a3e}
.p-sub{font-size:10px;color:#aaa;font-weight:600;margin-top:1px}
.p-bingo-badge{font-size:9px;font-weight:800;color:#27ae60;background:#dcfce7;padding:3px 9px;border-radius:10px}
.empty-hint{font-size:12px;color:#bbb;text-align:center;padding:20px 10px;line-height:1.8}
.empty-url{font-size:13px;color:#1560bd;font-weight:800;display:block;margin-top:4px}

/* Ganadores */
.w-row{
  display:flex;align-items:center;gap:8px;
  padding:7px 10px;border-radius:10px;
  background:#f0fdf4;border-left:3px solid #27ae60;
  font-size:13px;font-weight:700;color:#1a1a3e;
}
.trophy{font-size:16px}
.no-winner{font-size:12px;color:#ccc;font-weight:500}

/* ─── WINNER OVERLAY ─────────────────────────────────── */
#winner-overlay{display:none;position:fixed;inset:0;z-index:300;background:rgba(240,242,247,.96);backdrop-filter:blur(10px);flex-direction:column;align-items:center;justify-content:center;gap:16px}
#winner-overlay.show{display:flex}
.w-ov-icon{font-size:80px;animation:pop .4s ease}
@keyframes pop{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}
.w-ov-title{font-size:clamp(44px,7vw,72px);font-weight:900;color:#f5c200;text-shadow:0 3px 0 #b8960a;letter-spacing:-1px}
.w-ov-name{font-size:clamp(22px,3.5vw,40px);font-weight:800;color:#0d1b6e}
.w-ov-sub{font-size:14px;color:#777;font-weight:500}
.btn-cont{padding:11px 30px;border-radius:10px;border:none;background:linear-gradient(135deg,#0d1b6e,#1560bd);color:#fff;font-family:inherit;font-size:14px;font-weight:800;cursor:pointer;margin-top:4px;box-shadow:0 4px 14px rgba(21,96,189,.3)}

#confetti-canvas{position:fixed;inset:0;pointer-events:none;z-index:400}
</style>
</head>
<body>
<canvas id="confetti-canvas"></canvas>

<div id="winner-overlay">
  <div class="w-ov-icon">🎉</div>
  <div class="w-ov-title">¡BINGO!</div>
  <div class="w-ov-name" id="w-name"></div>
  <div class="w-ov-sub">Pídele que comparta algo sobre sí mismo</div>
  <button class="btn-cont" onclick="document.getElementById('winner-overlay').classList.remove('show')">Continuar →</button>
</div>

<header>
  <div class="logo-area">
    <div class="logo-icon">🎱</div>
    <div class="logo-text">
      <h1>Bingo Habilidades Socioemocionales</h1>
      <p>Vista del presentador · <span id="conn-count">0</span> participantes</p>
    </div>
  </div>
  <button class="btn-reiniciar" onclick="resetGame()">↺ Reiniciar juego</button>
</header>

<div class="main">

  <!-- ── IZQUIERDA ── -->
  <div class="left">
    <canvas id="bombo-canvas"></canvas>

    <div class="output-row">
      <div class="val-card">
        <div class="vc-label">● Valor en juego</div>
        <div class="vc-val" id="cur-val">¡Gira la balotera!</div>
      </div>
      <div class="arrow-lbl" id="arrow-out" style="opacity:0">→</div>
      <div class="stand">
        <div class="ball-slot" id="ball-slot">
          <div id="stand-ball"></div>
        </div>
        <div class="stand-pole"></div>
        <div class="stand-base"></div>
        <div class="stand-lbl">SALIÓ</div>
      </div>
    </div>

    <button class="btn-spin" id="btn-spin" onclick="spin()">🎱 Girar la balotera</button>

    <div class="chips-row" id="called-wrap"></div>
  </div>

  <!-- ── DERECHA ── -->
  <div class="side">

    <div class="side-section" style="flex:0 0 auto">
      <div class="sec-title">Últimas bolas</div>
      <div class="hist-list" id="hist-list">
        <span style="font-size:11px;color:#ccc;font-weight:500">Ninguna aún</span>
      </div>
    </div>

    <div class="side-section" style="flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column">
      <div class="sec-title">Participantes</div>
      <div class="players-list" id="players-list">
        <div class="empty-hint" id="empty-hint">
          Comparte el enlace:<br/>
          <span class="empty-url" id="player-url"></span>
        </div>
      </div>
    </div>

    <div class="side-section" style="flex:0 0 auto">
      <div class="sec-title">Ganadores</div>
      <div id="winners-box"><span class="no-winner">Nadie ha ganado aún</span></div>
    </div>

  </div>
</div>

<script>
const VALUES=["Compromiso","Solidaridad","Lealtad","Constancia","Perseverancia","Resiliencia","Fortaleza","Superación","Responsabilidad","Integridad","Puntualidad","Honestidad","Liderazgo","Inspiración","Servicio","Tolerancia","Empatía","Gratitud","Colaboración","Creatividad","Respeto","Comunicación","Justicia y equidad","Esperanza"];
const BALL_COLORS=["#e53935","#e67e22","#d4ac0d","#27ae60","#1e88e5","#8e44ad","#c62828","#ef6c00","#00838f","#1565c0","#6a1b9a","#2e7d32","#ad1457","#00695c","#bf360c","#4527a0","#558b2f","#c62828","#0277bd","#6d4c41","#37474f","#00695c","#7b1fa2","#c2185b"];

let calledValues=[],isSpinning=false,drumAngle=0,lastT=0;

const FLOAT_BALLS=VALUES.map((v,i)=>({
  v,color:BALL_COLORS[i%BALL_COLORS.length],
  x:0,y:0,vx:(Math.random()-.5)*1.2,vy:(Math.random()-.5)*1.2,
}));

const BC=document.getElementById('bombo-canvas');
const bctx=BC.getContext('2d');

function resizeCanvas(){
  const panel=BC.parentElement;
  const otherH=190;
  const availH=Math.max(100,panel.clientHeight-otherH);
  const availW=panel.clientWidth-32;
  const W=Math.min(availW,availH/0.60,500);
  const H=Math.round(W*0.60);
  BC.width=W;BC.height=H;
  FLOAT_BALLS.forEach(b=>{b.x=W*0.43+(Math.random()-.5)*W*.20;b.y=H*.50+(Math.random()-.5)*H*.20;});
}
resizeCanvas();
window.addEventListener('resize',resizeCanvas);

function drawScene(ts){
  const W=BC.width,H=BC.height;
  bctx.clearRect(0,0,W,H);
  const cx=W*.43,cy=H*.50,rx=W*.31,ry=H*.42;

  // Patas
  [cx-rx*.68,cx+rx*.68].forEach(lx=>{
    bctx.fillStyle='#6B3D14';bctx.fillRect(lx-7,cy+ry*.58,14,H*.20);
    bctx.fillStyle='#4A2A0A';bctx.fillRect(lx-13,cy+ry*.58+H*.20-4,26,8);
  });
  // Eje
  bctx.strokeStyle='#A0622A';bctx.lineWidth=6;
  bctx.beginPath();bctx.moveTo(cx-rx*.84,cy);bctx.lineTo(cx+rx*.90,cy);bctx.stroke();
  // Manivela
  const mX=cx+rx*.90,mY=cy;
  bctx.strokeStyle='#C4922A';bctx.lineWidth=4;
  bctx.beginPath();bctx.moveTo(mX,mY);bctx.lineTo(mX+18,mY);bctx.stroke();
  const ca=ts*3;
  bctx.beginPath();bctx.moveTo(mX+18,mY);bctx.lineTo(mX+18+Math.cos(ca)*12,mY+Math.sin(ca)*12);
  bctx.strokeStyle='#8B5A1A';bctx.lineWidth=3.5;bctx.stroke();
  bctx.beginPath();bctx.arc(mX+18+Math.cos(ca)*12,mY+Math.sin(ca)*12,4,0,Math.PI*2);
  bctx.fillStyle='#6B3D14';bctx.fill();

  // Clip interior
  bctx.save();
  bctx.beginPath();bctx.ellipse(cx,cy,rx*.90,ry*.88,0,0,Math.PI*2);bctx.clip();
  const bg=bctx.createRadialGradient(cx-rx*.2,cy-ry*.2,6,cx,cy,rx);
  bg.addColorStop(0,'rgba(230,240,255,0.98)');bg.addColorStop(1,'rgba(200,222,255,0.95)');
  bctx.fillStyle=bg;bctx.fill();
  // Barras
  bctx.save();bctx.translate(cx,cy);bctx.rotate(drumAngle);
  for(let i=0;i<8;i++){const a=i*Math.PI/4;bctx.strokeStyle='rgba(139,90,20,.40)';bctx.lineWidth=2.5;bctx.beginPath();bctx.moveTo(Math.cos(a)*rx*.14,Math.sin(a)*ry*.14);bctx.lineTo(Math.cos(a)*rx*.86,Math.sin(a)*ry*.86);bctx.stroke();}
  bctx.restore();
  // Bolas
  const ballR=Math.min(rx,ry)*.108;
  FLOAT_BALLS.forEach(b=>{
    if(calledValues.includes(b.v))return;
    b.x+=b.vx;b.y+=b.vy;
    const dx=(b.x-cx)/rx,dy=(b.y-cy)/ry;
    if(dx*dx+dy*dy>.58){b.vx*=-.88;b.vy*=-.88;b.x=cx+(b.x-cx)*.94;b.y=cy+(b.y-cy)*.94;}
    if(!isSpinning){if(Math.abs(b.vx)<.22)b.vx+=(Math.random()-.5)*.045;if(Math.abs(b.vy)<.22)b.vy+=(Math.random()-.5)*.045;}
    const g=bctx.createRadialGradient(b.x-ballR*.3,b.y-ballR*.3,1,b.x,b.y,ballR);
    g.addColorStop(0,'rgba(255,255,255,.58)');g.addColorStop(1,b.color);
    bctx.beginPath();bctx.arc(b.x,b.y,ballR,0,Math.PI*2);bctx.fillStyle=g;bctx.fill();
    bctx.strokeStyle='rgba(0,0,0,.08)';bctx.lineWidth=1;bctx.stroke();
    const fs=Math.max(5.5,ballR*.46);
    bctx.font='800 '+fs+'px Inter,sans-serif';
    bctx.textAlign='center';bctx.textBaseline='middle';bctx.fillStyle='#fff';
    bctx.shadowColor='rgba(0,0,0,.4)';bctx.shadowBlur=2;
    const words=b.v.split(' ');
    if(words.length===1||b.v.length<=7)bctx.fillText(b.v.length>8?b.v.slice(0,8):b.v,b.x,b.y);
    else{bctx.fillText(words[0].slice(0,8),b.x,b.y-fs*.62);bctx.fillText(words[1].slice(0,8),b.x,b.y+fs*.62);}
    bctx.shadowBlur=0;
  });
  bctx.restore();

  // Marco dorado
  const frame=bctx.createLinearGradient(cx-rx,cy-ry,cx+rx,cy+ry);
  frame.addColorStop(0,'#C4922A');frame.addColorStop(.5,'#F5C200');frame.addColorStop(1,'#8B5A2B');
  bctx.strokeStyle=frame;bctx.lineWidth=13;
  bctx.beginPath();bctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2);bctx.stroke();
  bctx.strokeStyle='rgba(255,255,255,.38)';bctx.lineWidth=3.5;
  bctx.beginPath();bctx.ellipse(cx,cy-ry*.08,rx*.66,ry*.20,-0.5,Math.PI*1.18,Math.PI*1.88);bctx.stroke();
  bctx.beginPath();bctx.arc(cx,cy,7,0,Math.PI*2);bctx.fillStyle='#6B3D14';bctx.fill();
  bctx.strokeStyle='#F5C200';bctx.lineWidth=2;bctx.stroke();

  // Tubo
  const tX=cx+rx+1,tY=cy,tW=W*.085,tH=ry*.28;
  const tg=bctx.createLinearGradient(tX,tY-tH,tX,tY+tH);
  tg.addColorStop(0,'#C4922A');tg.addColorStop(1,'#8B5A2B');
  bctx.fillStyle=tg;bctx.beginPath();bctx.roundRect(tX,tY-tH/2,tW,tH,4);bctx.fill();
  bctx.strokeStyle='#6B3D14';bctx.lineWidth=1.5;bctx.stroke();
}

function animFlyBall(color,value,onDone){
  const W=BC.width,H=BC.height,cx=W*.43,cy=H*.50,rx=W*.31;
  const sX=cx+rx+W*.02,sY=cy,eX=sX+W*.10,ballR=Math.min(W,H)*.075;
  let t=0;
  function frame(){
    t+=.045;const p=Math.min(t,1);
    const px=sX+(eX-sX)*p,py=sY-Math.sin(p*Math.PI)*H*.09;
    bctx.save();
    const g=bctx.createRadialGradient(px-ballR*.3,py-ballR*.3,1,px,py,ballR);
    g.addColorStop(0,'rgba(255,255,255,.52)');g.addColorStop(1,color);
    bctx.beginPath();bctx.arc(px,py,ballR,0,Math.PI*2);bctx.fillStyle=g;bctx.fill();
    bctx.strokeStyle='rgba(0,0,0,.10)';bctx.lineWidth=1.5;bctx.stroke();
    bctx.fillStyle='#fff';
    const fs=Math.max(7,ballR*.40);
    bctx.font='800 '+fs+'px Inter,sans-serif';
    bctx.textAlign='center';bctx.textBaseline='middle';
    bctx.shadowColor='rgba(0,0,0,.4)';bctx.shadowBlur=2;
    const words=value.split(' ');
    if(words.length===1||value.length<=7)bctx.fillText(value.slice(0,8),px,py);
    else{bctx.fillText(words[0].slice(0,8),px,py-fs*.58);bctx.fillText(words[1].slice(0,8),px,py+fs*.58);}
    bctx.shadowBlur=0;bctx.restore();
    if(t<1)requestAnimationFrame(frame);else onDone&&onDone();
  }
  requestAnimationFrame(frame);
}

function mainLoop(ts){
  const dt=(ts-lastT)/1000;lastT=ts;
  drumAngle+=isSpinning?dt*4.6:dt*.32;
  drawScene(ts/1000);
  requestAnimationFrame(mainLoop);
}
requestAnimationFrame(mainLoop);

function showStandBall(value,color){
  const sb=document.getElementById('stand-ball');
  sb.classList.remove('show');
  sb.style.background='radial-gradient(circle at 35% 35%,rgba(255,255,255,.45),'+color+')';
  const words=value.split(' ');
  sb.innerHTML=words.map(w=>'<span style="display:block;font-size:'+(words.length>1?'7.5px':'9.5px')+';line-height:1.25;font-weight:900">'+esc(w)+'</span>').join('');
  document.getElementById('ball-slot').classList.add('has-ball');
  document.getElementById('arrow-out').style.opacity='1';
  setTimeout(()=>sb.classList.add('show'),60);
}

function renderHistList(list){
  const el=document.getElementById('hist-list');
  if(!list.length){el.innerHTML='<span style="font-size:11px;color:#ccc;font-weight:500">Ninguna aún</span>';return;}
  const rev=[...list].reverse().slice(0,7);
  el.innerHTML=rev.map((v,i)=>{
    const idx=VALUES.indexOf(v);
    const col=BALL_COLORS[idx%BALL_COLORS.length];
    const abbr=v.slice(0,3).toUpperCase();
    return '<div class="hb-row'+(i===0?' latest':'')+'">'+
      '<div class="hb-dot" style="background:radial-gradient(circle at 35% 35%,rgba(255,255,255,.45),'+col+')">'+abbr+'</div>'+
      '<div class="hb-info">'+
        '<span class="hb-name">'+esc(v)+'</span>'+
        (i===0?'<span class="hb-badge">● Actual</span>':'')+
      '</div></div>';
  }).join('');
}

const proto=location.protocol==='https:'?'wss':'ws';
const ws=new WebSocket(proto+'://'+location.host);
ws.onopen=()=>ws.send(JSON.stringify({type:'set_role',role:'presenter'}));
ws.onmessage=e=>{
  const m=JSON.parse(e.data);
  if(m.type==='state')applyState(m);
  if(m.type==='spinning'){isSpinning=true;document.getElementById('btn-spin').disabled=true;}
  if(m.type==='value_called')onValueCalled(m.value,m.calledValues);
  if(m.type==='bingo_winner')onBingo(m.name);
};

function applyState(s){
  calledValues=s.calledValues||[];
  document.getElementById('conn-count').textContent=s.players.length;
  renderChips(calledValues,s.currentValue);
  renderHistList(calledValues);
  if(s.currentValue){
    document.getElementById('cur-val').textContent=s.currentValue;
    const idx=VALUES.indexOf(s.currentValue);
    if(idx>=0)showStandBall(s.currentValue,BALL_COLORS[idx%BALL_COLORS.length]);
  }
  document.getElementById('btn-spin').disabled=s.spinning;
  renderPlayers(s.players);
  renderWinners(s.winners);
}
function renderChips(list,latest){
  document.getElementById('called-wrap').innerHTML=list.map(v=>
    '<span class="chip'+(v===latest?' latest':'')+'">'+esc(v)+'</span>'
  ).join('');
}
function renderPlayers(players){
  const list=document.getElementById('players-list');
  const hint=document.getElementById('empty-hint');
  if(!players.length){if(hint)hint.style.display='';return;}
  if(hint)hint.style.display='none';
  list.innerHTML=players.map(p=>{
    const ini=(p.name||'?')[0].toUpperCase();
    const marked=p.markedCount||0;
    return '<div class="p-card'+(p.bingo?' bingo':'')+'">'+
      '<div class="p-avatar">'+ini+'</div>'+
      '<div class="p-info">'+
        '<div class="p-name">'+esc(p.name)+'</div>'+
        '<div class="p-sub">'+(p.bingo?'':'marcó '+marked+' valor'+(marked!==1?'es':''))+'</div>'+
      '</div>'+
      (p.bingo?'<span class="p-bingo-badge">BINGO ✓</span>':'')+
    '</div>';
  }).join('');
}
function renderWinners(winners){
  document.getElementById('winners-box').innerHTML=(winners&&winners.length)
    ?winners.map((w,i)=>'<div class="w-row"><span class="trophy">🏆</span>'+esc(w)+'</div>').join('')
    :'<span class="no-winner">Nadie ha ganado aún</span>';
}
function onValueCalled(val,called){
  isSpinning=false;
  setTimeout(()=>{
    calledValues=called;
    document.getElementById('cur-val').textContent=val;
    renderChips(called,val);
    renderHistList(called);
    document.getElementById('btn-spin').disabled=false;
    const idx=VALUES.indexOf(val);
    const color=BALL_COLORS[idx%BALL_COLORS.length];
    animFlyBall(color,val,()=>showStandBall(val,color));
  },380);
}
function onBingo(name){
  document.getElementById('w-name').textContent=name;
  document.getElementById('winner-overlay').classList.add('show');
  launchConfetti();
}
function spin(){if(!isSpinning)ws.send(JSON.stringify({type:'spin'}));}
function resetGame(){
  if(!confirm('¿Reiniciar el juego?'))return;
  ws.send(JSON.stringify({type:'reset'}));
  calledValues=[];
  document.getElementById('cur-val').textContent='¡Gira la balotera!';
  document.getElementById('called-wrap').innerHTML='';
  document.getElementById('stand-ball').classList.remove('show');
  document.getElementById('ball-slot').classList.remove('has-ball');
  document.getElementById('arrow-out').style.opacity='0';
  renderHistList([]);
  FLOAT_BALLS.forEach(b=>{b.vx=(Math.random()-.5)*1.2;b.vy=(Math.random()-.5)*1.2;});
}
document.getElementById('player-url').textContent=location.origin+'/jugar';

const cc=document.getElementById('confetti-canvas');
const ccx=cc.getContext('2d');
function launchConfetti(){
  cc.width=innerWidth;cc.height=innerHeight;
  const ps=Array.from({length:180},()=>({x:Math.random()*cc.width,y:-10,w:7+Math.random()*9,h:3+Math.random()*5,color:['#f5c200','#1e88e5','#0d1b6e','#27ae60','#e53935','#8e44ad'][Math.floor(Math.random()*6)],speed:2.5+Math.random()*4,angle:Math.random()*Math.PI*2,spin:(Math.random()-.5)*.18,drift:(Math.random()-.5)*2}));
  (function loop(){ccx.clearRect(0,0,cc.width,cc.height);const r=ps.filter(p=>p.y<cc.height+20);r.forEach(p=>{p.y+=p.speed;p.x+=p.drift;p.angle+=p.spin;ccx.save();ccx.translate(p.x,p.y);ccx.rotate(p.angle);ccx.fillStyle=p.color;ccx.fillRect(-p.w/2,-p.h/2,p.w,p.h);ccx.restore();});if(r.length)requestAnimationFrame(loop);else ccx.clearRect(0,0,cc.width,cc.height);})();
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
</script>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════════════════════
//  VISTA JUGADOR  /jugar
// ═══════════════════════════════════════════════════════════════════════════════
const HTML_PLAYER = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<title>Balotera · Mi Tablero</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;background:#f0f2f7;color:#1a1a3e;min-height:100vh;display:flex;flex-direction:column;align-items:center;}

/* ── REGISTRO ── */
#screen-reg{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  min-height:100vh;gap:18px;padding:32px 20px;width:100%;max-width:400px;
}
.reg-icon{width:64px;height:64px;border-radius:18px;background:linear-gradient(135deg,#0d1b6e,#1560bd);display:flex;align-items:center;justify-content:center;font-size:32px;box-shadow:0 6px 20px rgba(13,27,110,.3)}
.reg-title{font-size:26px;font-weight:900;color:#0d1b6e;text-align:center;letter-spacing:-.5px;line-height:1.15}
.reg-sub{font-size:13px;color:#777;text-align:center;line-height:1.6;font-weight:500;max-width:300px}
.tag-badge{background:#e8f0fe;color:#1560bd;font-size:11px;font-weight:800;padding:4px 14px;border-radius:20px;letter-spacing:.5px;border:1.5px solid #c5d8ff}
.input-wrap{width:100%;position:relative}
.input-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);font-size:16px;opacity:.5}
.input-field{width:100%;padding:14px 18px 14px 42px;border-radius:12px;border:2px solid #e0e5f0;background:#fff;color:#1a1a3e;font-size:16px;font-family:inherit;font-weight:600;outline:none;transition:all .2s;box-shadow:0 2px 8px rgba(0,0,0,.05)}
.input-field::placeholder{color:#c0c8d8;font-weight:500}
.input-field:focus{border-color:#1560bd;box-shadow:0 0 0 4px rgba(21,96,189,.10)}
.btn-join{width:100%;padding:15px;border-radius:12px;border:none;background:linear-gradient(135deg,#0d1b6e,#1560bd);color:#fff;font-size:16px;font-weight:800;font-family:inherit;cursor:pointer;transition:all .2s;box-shadow:0 4px 16px rgba(21,96,189,.35);letter-spacing:.2px}
.btn-join:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(21,96,189,.4)}
.btn-join:disabled{opacity:.4;cursor:default;transform:none}

/* ── JUEGO ── */
#screen-game{display:none;flex-direction:column;align-items:center;width:100%;max-width:400px;padding:0 14px 28px;}

/* Topbar */
.topbar{
  width:100%;display:flex;align-items:center;justify-content:space-between;
  padding:12px 0 10px;border-bottom:2px solid #e8ecf5;margin-bottom:14px;
}
.topbar h2{font-size:14px;font-weight:800;color:#0d1b6e;display:flex;align-items:center;gap:6px}
.who-badge{background:#e8f0fe;color:#1560bd;font-size:10px;font-weight:800;padding:3px 10px;border-radius:20px;border:1.5px solid #c5d8ff}

/* Bola valor */
.val-section{width:100%;margin-bottom:16px}
.val-sec-label{font-size:9px;font-weight:800;letter-spacing:1.8px;text-transform:uppercase;color:#aaa;margin-bottom:8px;padding-left:2px}
.val-ball-card{
  background:#fff;border-radius:14px;
  border-left:5px solid #1560bd;
  padding:12px 16px;
  display:flex;align-items:center;gap:14px;
  box-shadow:0 2px 10px rgba(0,0,0,.07);
  transition:border-left-color .4s;
}
.val-ball-dot{
  width:52px;height:52px;border-radius:50%;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;
  font-size:8px;font-weight:900;color:#fff;text-align:center;line-height:1.2;word-break:break-word;padding:6px;
  box-shadow:inset -4px -4px 8px rgba(0,0,0,.2),inset 2px 2px 5px rgba(255,255,255,.2),0 4px 12px rgba(0,0,0,.15);
  background:radial-gradient(circle at 35% 35%,rgba(255,255,255,.45),#1560bd);
  transition:background .4s;
}
.val-ball-dot.pulse{animation:bpop .35s ease}
@keyframes bpop{0%{transform:scale(1)}50%{transform:scale(1.15)}100%{transform:scale(1)}}
.val-text{display:flex;flex-direction:column;gap:2px}
.val-name{font-size:20px;font-weight:900;color:#0d1b6e;line-height:1}
.val-hint{font-size:10px;color:#aaa;font-weight:600}

/* TABLERO 3x3 */
.board-label{font-size:9px;font-weight:800;letter-spacing:1.8px;text-transform:uppercase;color:#aaa;margin-bottom:8px;width:100%;padding-left:2px}
#board{
  display:grid;grid-template-columns:repeat(3,1fr);
  gap:6px;width:100%;
}
.cell{
  aspect-ratio:1;border-radius:14px;
  background:#fff;
  border:2px solid #e4e8f2;
  border-bottom:4px solid #d0d8ee;
  display:flex;align-items:center;justify-content:center;
  text-align:center;padding:4px;
  font-size:clamp(9px,3.2vw,13px);font-weight:800;
  color:#1a1a3e;cursor:pointer;
  transition:all .18s;
  overflow-wrap:break-word;hyphens:auto;line-height:1.15;
  user-select:none;-webkit-tap-highlight-color:transparent;
  box-shadow:0 3px 8px rgba(0,0,0,.07);
  overflow:hidden;
}
.cell:active{transform:scale(.88);box-shadow:none}
.cell.marked{
  background:linear-gradient(135deg,#0d1b6e,#1560bd);
  border-color:#0d1b6e;border-bottom-color:#0a1555;
  color:#fff;
  box-shadow:0 4px 14px rgba(13,27,110,.35);
}
.cell.free{
  background:linear-gradient(135deg,#d4ac0d,#f5c200);
  border-color:#d4ac0d;border-bottom-color:#a88400;
  color:#fff;cursor:default;
  box-shadow:0 4px 14px rgba(212,172,13,.3);
  font-size:clamp(12px,4vw,16px);
}
.cell.winning{
  background:linear-gradient(135deg,#1a7a3c,#27ae60) !important;
  border-color:#1a7a3c !important;border-bottom-color:#145c2e !important;
  color:#fff !important;
  animation:glow .55s ease infinite alternate;
  box-shadow:0 4px 16px rgba(39,174,96,.45) !important;
}
@keyframes glow{from{box-shadow:0 4px 10px rgba(39,174,96,.3)}to{box-shadow:0 4px 22px rgba(39,174,96,.75)}}

/* Mensaje bingo */
#bingo-msg{
  width:100%;margin:12px 0 4px;text-align:center;min-height:26px;
  font-size:15px;font-weight:800;color:#27ae60;
}

/* Chips llamados */
.called-section{width:100%;margin-top:10px}
.called-sec-lbl{font-size:9px;font-weight:800;letter-spacing:1.8px;text-transform:uppercase;color:#aaa;margin-bottom:6px;padding-left:2px}
.called-chips{display:flex;flex-wrap:wrap;gap:5px}
.chip{padding:3px 10px;border-radius:16px;font-size:10px;font-weight:700;background:#fff;border:1.5px solid #d8dff0;color:#555}

/* Overlay girar */
#spin-overlay{display:none;position:fixed;inset:0;z-index:100;background:rgba(240,242,247,.97);backdrop-filter:blur(8px);flex-direction:column;align-items:center;justify-content:center;gap:18px}
#spin-overlay.show{display:flex}
.spin-circle{width:100px;height:100px;border-radius:50%;background:linear-gradient(135deg,#0d1b6e,#1560bd);display:flex;align-items:center;justify-content:center;font-size:48px;animation:rotar 1.2s linear infinite;box-shadow:0 8px 24px rgba(21,96,189,.35)}
@keyframes rotar{to{transform:rotate(360deg)}}
.spin-txt{font-size:22px;font-weight:900;color:#0d1b6e;letter-spacing:-.3px}
.spin-sub{font-size:13px;color:#888;font-weight:500;text-align:center;padding:0 24px}

#conn-dot{position:fixed;top:10px;right:12px;font-size:10px;padding:3px 11px;border-radius:20px;background:#fff;border:1.5px solid #e0e5f0;box-shadow:0 1px 6px rgba(0,0,0,.08);z-index:200;font-weight:700}
#conn-dot.ok{color:#27ae60;border-color:#a8ddb5} #conn-dot.err{color:#e53935;border-color:#f5baba}
</style>
</head>
<body>
<div id="conn-dot" class="err">● desconectado</div>

<div id="spin-overlay">
  <div class="spin-circle">🎱</div>
  <div class="spin-txt">¡Girando la balotera!</div>
  <div class="spin-sub">Espera el valor y búscalo en tu tablero</div>
</div>

<div id="screen-reg">
  <div class="reg-icon">🎱</div>
  <span class="tag-badge">BALOTERA SOCIOEMOCIONAL</span>
  <h1 class="reg-title">¡Hola!<br/>¿Cómo te llamas?</h1>
  <p class="reg-sub">Recibirás un tablero 3×3 personalizado. Cuando salga una bola, búscala y tócala para marcarla.</p>
  <div class="input-wrap">
    <span class="input-icon">👤</span>
    <input class="input-field" id="name-in" type="text" placeholder="Tu nombre completo" maxlength="32" autocomplete="off"/>
  </div>
  <button class="btn-join" id="btn-join" onclick="join()">Entrar al juego →</button>
</div>

<div id="screen-game">
  <div class="topbar">
    <h2>🎱 Tu tablero</h2>
    <span class="who-badge" id="player-tag">—</span>
  </div>

  <div class="val-section">
    <div class="val-sec-label">Valor en juego</div>
    <div class="val-ball-card" id="val-card">
      <div class="val-ball-dot" id="val-dot">—</div>
      <div class="val-text">
        <div class="val-name" id="val-name">Esperando...</div>
        <div class="val-hint">Búscalo en tu tablero y tócalo</div>
      </div>
    </div>
  </div>

  <div class="board-label">Tu tablero — ¡marca la línea!</div>
  <div id="board"></div>
  <div id="bingo-msg"></div>

  <div class="called-section">
    <div class="called-sec-lbl">Valores llamados</div>
    <div class="called-chips" id="called-chips"></div>
  </div>
</div>

<script>
const VALUES=["Compromiso","Solidaridad","Lealtad","Constancia","Perseverancia","Resiliencia","Fortaleza","Superación","Responsabilidad","Integridad","Puntualidad","Honestidad","Liderazgo","Inspiración","Servicio","Tolerancia","Empatía","Gratitud","Colaboración","Creatividad","Respeto","Comunicación","Justicia y equidad","Esperanza"];
const BALL_COLORS=["#e53935","#e67e22","#d4ac0d","#27ae60","#1e88e5","#8e44ad","#c62828","#ef6c00","#00838f","#1565c0","#6a1b9a","#2e7d32","#ad1457","#00695c","#bf360c","#4527a0","#558b2f","#c62828","#0277bd","#6d4c41","#37474f","#00695c","#7b1fa2","#c2185b"];

let board=[],marks=[],playerName='',ws,joined=false;
const proto=location.protocol==='https:'?'wss':'ws';

function connect(){
  ws=new WebSocket(proto+'://'+location.host);
  ws.onopen=()=>{setConn(true);if(playerName&&!joined)register();};
  ws.onclose=()=>{setConn(false);setTimeout(connect,2500);};
  ws.onerror=()=>setConn(false);
  ws.onmessage=e=>{
    const m=JSON.parse(e.data);
    if(m.type==='board'){board=m.board;marks=m.marks;renderBoard();}
    if(m.type==='marks'){marks=m.marks;renderBoard();}
    if(m.type==='state')applyState(m);
    if(m.type==='spinning')document.getElementById('spin-overlay').classList.add('show');
    if(m.type==='value_called'){
      document.getElementById('spin-overlay').classList.remove('show');
      setValDisplay(m.value);
      document.getElementById('called-chips').innerHTML=m.calledValues.map(v=>'<span class="chip">'+esc(v)+'</span>').join('');
    }
    if(m.type==='bingo_winner')document.getElementById('bingo-msg').textContent='🏆 ¡'+esc(m.name)+' ganó!';
    if(m.type==='bingo_invalid'){
      const msg=document.getElementById('bingo-msg');
      msg.style.color='#e53935';
      msg.textContent='⏳ Aún falta: '+m.pending.map(v=>esc(v)).join(', ');
      setTimeout(()=>{msg.style.color='';if(msg.textContent.includes('falta'))msg.textContent='';},5000);
    }
  };
}

function setValDisplay(value){
  const idx=VALUES.indexOf(value);
  const color=idx>=0?BALL_COLORS[idx%BALL_COLORS.length]:'#1560bd';
  const dot=document.getElementById('val-dot');
  const card=document.getElementById('val-card');
  dot.style.background='radial-gradient(circle at 35% 35%,rgba(255,255,255,.45),'+color+')';
  card.style.borderLeftColor=color;
  const words=value.split(' ');
  dot.innerHTML=words.map(w=>'<span style="display:block;font-size:'+(words.length>1?'7px':'9px')+';line-height:1.2;font-weight:900">'+esc(w)+'</span>').join('');
  document.getElementById('val-name').textContent=value;
  dot.classList.remove('pulse');void dot.offsetWidth;dot.classList.add('pulse');
}

function join(){
  const n=document.getElementById('name-in').value.trim();
  if(!n)return document.getElementById('name-in').focus();
  playerName=n;
  document.getElementById('player-tag').textContent=n;
  document.getElementById('btn-join').disabled=true;
  document.getElementById('screen-reg').style.display='none';
  document.getElementById('screen-game').style.display='flex';
  register();
}
function register(){
  if(ws&&ws.readyState===WebSocket.OPEN){ws.send(JSON.stringify({type:'register',name:playerName}));joined=true;}
}
function renderBoard(){
  const m=[...marks];m[4]=true;
  const allMarked=m.every(Boolean);
  document.getElementById('board').innerHTML=board.map((v,i)=>{
    if(v==='LIBRE')return '<div class="cell free">⭐ LIBRE</div>';
    const cls='cell'+(marks[i]?' marked':'')+(allMarked?' winning':'');
    const fs=v.length>12?'clamp(7px,2.4vw,10px)':v.length>8?'clamp(8px,2.8vw,12px)':'clamp(9px,3.2vw,13px)';
    return '<div class="'+cls+'" onclick="mark('+i+')" style="font-size:'+fs+'">'+esc(v)+'</div>';
  }).join('');
  const msg=document.getElementById('bingo-msg');
  if(allMarked&&!msg.textContent.includes('ganó')&&!msg.textContent.includes('falta'))
    msg.textContent='¡Tablero completo! Grita BINGO 🎉';
}
function mark(idx){if(!ws||ws.readyState!==WebSocket.OPEN)return;ws.send(JSON.stringify({type:'mark',idx}));}
function applyState(s){
  if(s.currentValue)setValDisplay(s.currentValue);
  document.getElementById('called-chips').innerHTML=(s.calledValues||[]).map(v=>'<span class="chip">'+esc(v)+'</span>').join('');
  if(s.winners&&s.winners.length)document.getElementById('bingo-msg').textContent='🏆 ¡'+esc(s.winners[0])+' ganó!';
}
function setConn(ok){
  const el=document.getElementById('conn-dot');
  el.textContent=ok?'● conectado':'● desconectado';
  el.className=ok?'ok':'err';
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
document.getElementById('name-in').addEventListener('keydown',e=>{if(e.key==='Enter')join();});
connect();
</script>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════════════════════
//  VISTA ADMIN  /admin
// ═══════════════════════════════════════════════════════════════════════════════
const HTML_ADMIN = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Balotera · Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;background:#f0f2f7;color:#1a1a3e;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px;gap:14px}
.logo-row{display:flex;align-items:center;gap:10px}
.logo-icon{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#0d1b6e,#1560bd);display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 4px 12px rgba(13,27,110,.3)}
.logo-text h1{font-size:18px;font-weight:900;color:#0d1b6e}
.logo-text p{font-size:11px;color:#aaa;font-weight:500}
.cur-card{background:#fff;border-radius:14px;border-left:5px solid #f5c200;padding:14px 20px;width:100%;max-width:340px;box-shadow:0 2px 10px rgba(0,0,0,.07)}
.cur-lbl{font-size:9px;font-weight:800;letter-spacing:1.8px;text-transform:uppercase;color:#f5c200;margin-bottom:5px}
.cur-val{font-size:26px;font-weight:900;color:#0d1b6e;min-height:34px}
.btn{width:100%;max-width:340px;padding:14px;border-radius:11px;border:none;font-size:15px;font-weight:800;font-family:inherit;cursor:pointer;transition:all .18s;letter-spacing:.2px}
.btn:hover{transform:translateY(-1px)} .btn:disabled{opacity:.35;cursor:default;transform:none}
.btn-spin{background:linear-gradient(135deg,#0d1b6e,#1560bd);color:#fff;box-shadow:0 4px 14px rgba(21,96,189,.3)}
.btn-reset{background:#fff;color:#555;border:2px solid #e0e5f0}
.stat{font-size:12px;color:#888;font-weight:600}
.stat span{color:#1560bd;font-weight:800}
.chips-wrap{display:flex;flex-wrap:wrap;gap:5px;justify-content:center;max-width:360px}
.chip{padding:3px 11px;border-radius:16px;font-size:10px;font-weight:700;background:#fff;border:1.5px solid #d8dff0;color:#555}
#conn{font-size:10px;padding:4px 12px;border-radius:20px;background:#fff;border:1.5px solid #e0e5f0;font-weight:700}
#conn.ok{color:#27ae60;border-color:#a8ddb5} #conn.err{color:#e53935;border-color:#f5baba}
</style>
</head>
<body>
<div id="conn" class="err">● desconectado</div>
<div class="logo-row">
  <div class="logo-icon">🎱</div>
  <div class="logo-text"><h1>Balotera</h1><p>Control del presentador</p></div>
</div>
<div class="cur-card">
  <div class="cur-lbl">● Valor actual</div>
  <div class="cur-val" id="cur">—</div>
</div>
<button class="btn btn-spin" id="btn-spin" onclick="spin()">🎱 Girar la balotera</button>
<button class="btn btn-reset" onclick="reset()">↺ Reiniciar juego</button>
<div class="stat">Llamados: <span id="cnt">0</span>/24 · Participantes: <span id="pc">0</span></div>
<div class="chips-wrap" id="chips"></div>
<script>
const proto=location.protocol==='https:'?'wss':'ws';
const ws=new WebSocket(proto+'://'+location.host);
ws.onopen=()=>{setConn(true);ws.send(JSON.stringify({type:'set_role',role:'admin'}));};
ws.onclose=()=>setConn(false);
ws.onmessage=e=>{
  const m=JSON.parse(e.data);
  if(m.type==='state'){
    document.getElementById('cur').textContent=m.currentValue||'—';
    document.getElementById('cnt').textContent=m.calledValues.length;
    document.getElementById('pc').textContent=m.players.length;
    document.getElementById('chips').innerHTML=m.calledValues.map(v=>'<span class="chip">'+v+'</span>').join('');
    document.getElementById('btn-spin').disabled=m.spinning;
  }
  if(m.type==='spinning')document.getElementById('btn-spin').disabled=true;
  if(m.type==='value_called')document.getElementById('cur').textContent=m.value;
};
function spin(){ws.send(JSON.stringify({type:'spin'}));}
function reset(){if(confirm('¿Reiniciar el juego?'))ws.send(JSON.stringify({type:'reset'}));}
function setConn(ok){const el=document.getElementById('conn');el.textContent=ok?'● conectado':'● desconectado';el.className=ok?'ok':'err';}
</script>
</body>
</html>`;

// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log('Servidor corriendo en puerto ' + PORT));
