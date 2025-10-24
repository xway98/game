// ============================================================================
// Battleship Client — Polished, Fixed & Organized
// ============================================================================

// ---------------------------------------------------------------------------
// 1. DOM & CONSTANTS
// ---------------------------------------------------------------------------
const SIZE = 10;
const EMPTY = 0;
const SHIPS = [5, 4, 3, 3, 2];

const myBoardEl    = document.getElementById("myBoard");
const enemyBoardEl = document.getElementById("enemyBoard");
const statusEl     = document.getElementById("status");
const pillEl       = document.getElementById("pill");

const btnCreate     = document.getElementById("btnCreate");
const btnJoin       = document.getElementById("btnJoin");
const roomCodeInput = document.getElementById("roomCode");
const btnAuto       = document.getElementById("btnAuto");
const btnReady      = document.getElementById("btnReady");
const btnManual     = document.getElementById("btnManual");
const btnRotate     = document.getElementById("btnRotate");
const btnClearLocal = document.getElementById("btnClearLocal");
const shipInfo      = document.getElementById("shipInfo");
const fleetEl       = document.getElementById("fleetTracker");
const toastEl       = document.getElementById("toast");

// ---------------------------------------------------------------------------
// 2. STATE
// ---------------------------------------------------------------------------
let ws = null;
let state = initState();
let soundPlayed = false;

let prev = {
  turn: null,
  phase: null,
  marks: emptyBoard(),     // YOUR shots on ENEMY board
  oppMarks: emptyBoard(),  // OPPONENT shots on YOUR board
};
let prevSunkOpp = new Set();

let placing = {
  enabled: false,
  dir: "H",
  queue: [5, 4, 3, 3, 2],
  nextIndex: 0,
  previewCells: []
};

function initState() {
  return {
    code: null,
    phase: "placing",
    me: { id: null, board: emptyBoard(), ships: [], marks: emptyBoard(), ready: false },
    opp: null,
    turn: null,
    winner: null
  };
}

function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
}

// ---------------------------------------------------------------------------
// 3. KEYBOARD SHORTCUTS
// ---------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if (!placing.enabled) return;
  if (e.key.toLowerCase() === "r") {
    placing.dir = placing.dir === "H" ? "V" : "H";
    updateShipInfo();
  }
});

// ---------------------------------------------------------------------------
// 4. BUILD GRIDS
// ---------------------------------------------------------------------------
buildGrid(myBoardEl, onMyCellClick, onMyCellEnter, onMyCellLeave);
buildGrid(enemyBoardEl, onEnemyCellClick);
paint();

function buildGrid(el, clickHandler, enterHandler, leaveHandler) {
  el.innerHTML = "";
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const d = document.createElement("div");
      d.className = "cell";
      d.dataset.rc = r + "," + c;
      if (clickHandler)  d.addEventListener("click",       () => clickHandler(r, c));
      if (enterHandler)  d.addEventListener("mouseenter",  () => enterHandler(r, c));
      if (leaveHandler)  d.addEventListener("mouseleave",  () => leaveHandler(r, c));
      el.appendChild(d);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. WEBSOCKET CONNECTION
// ---------------------------------------------------------------------------
function wsUrl() {
  if (location.host)
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  return "ws://localhost:8080";
}

function connect() {
  try { ws = new WebSocket(wsUrl()); }
  catch { return setStatus("WebSocket init failed. Is the server running? (npm start)"); }

  ws.addEventListener("open",   () => setStatus("Connected to server."));
  ws.addEventListener("close",  () => setStatus("Disconnected. (Check server & firewall)"));
  ws.addEventListener("error",  () => setStatus("WebSocket error."));
  ws.addEventListener("message", (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "ROOM_CREATED") {
      roomCodeInput.value = msg.code;
      setStatus(`Room created: ${msg.code}`);
      send({ type: "JOIN_ROOM", code: msg.code }); // auto-join creator
    }

    if (msg.type === "ROOM_STATE") applyRoomState(msg);
    if (msg.type === "ERROR") setStatus("Error: " + msg.error);
  });
}
function send(o){ if(ws&&ws.readyState===1) ws.send(JSON.stringify(o)); }
function requestState(){ send({type:"REQUEST_STATE"}); }
connect();

// ---------------------------------------------------------------------------
// 6. BUTTON HANDLERS
// ---------------------------------------------------------------------------
btnCreate.onclick = () => send({ type: "CREATE_ROOM" });
btnJoin.onclick = () => {
  const code = roomCodeInput.value.trim();
  if (code.length !== 6) return setStatus("Enter 6-digit code");
  send({ type: "JOIN_ROOM", code });
};

btnManual.onclick = () => {
  placing.enabled = true;
  placing.dir = "H";
  placing.queue = [5,4,3,3,2];
  placing.nextIndex = 0;
  clearPreview();
  state.me.board = emptyBoard();
  state.me.ships = [];
  state.me.ready = false;
  paint();
  updateShipInfo();
  setStatus("Manual placement: hover, click to place. Press R to rotate.");
};
btnRotate.onclick = () => { placing.dir = placing.dir === "H" ? "V" : "H"; updateShipInfo(); };
btnClearLocal.onclick = () => {
  clearPreview();
  placing.enabled = false;
  state.me.board = emptyBoard();
  state.me.ships = [];
  state.me.ready = false;
  paint();
  updateShipInfo();
};
btnAuto.onclick = () => {
  placing.enabled = false;
  const { board, ships } = autoFleet();
  state.me.board = board;
  state.me.ships = ships;
  state.me.ready = false;
  send({ type:"PLACE_FLEET", payload:{ board, ships }, ready:false });
  setStatus("Fleet placed. Click 'I’m ready' when done.");
  paint();
  updateShipInfo();
};
btnReady.onclick = () => {
  if (placing.enabled) return setStatus("Place all ships first, then click 'I’m ready'.");
  if ((state.me.ships?.length||0)!==5)
    return setStatus("You must place all 5 ships (lengths 5,4,3,3,2).");
  send({ type:"PLACE_FLEET", payload:{ board:state.me.board, ships:state.me.ships }, ready:true });
};

// ---------------------------------------------------------------------------
// 7. GAME LOGIC (placement helpers & manual placement)
// ---------------------------------------------------------------------------
function autoFleet(){ const board=emptyBoard(),ships=[]; for(const len of SHIPS) placeRandomShip(board,ships,len); return{board,ships}; }
function placeRandomShip(board,ships,length){
  for(let t=0;t<2000;t++){
    const h=Math.random()<.5; const r=(Math.random()*SIZE)|0; const c=(Math.random()*SIZE)|0;
    if(canPlace(board,r,c,length,h)){ placeShip(board,ships,r,c,length,h); return; }
  }
}
function canPlace(board,r,c,len,h){
  if(h&&c+len>SIZE) return false;
  if(!h&&r+len>SIZE) return false;
  for(let i=0;i<len;i++){
    const rr=r+(h?0:i), cc=c+(h?i:0);
    if(board[rr][cc]!==EMPTY) return false;
  }
  return true;
}
function placeShip(board,ships,r,c,len,h){
  const id=ships.length+1, cells=[];
  for(let i=0;i<len;i++){ const rr=r+(h?0:i), cc=c+(h?i:0); board[rr][cc]=id; cells.push([rr,cc]); }
  ships.push({id,length:len,cells});
}

// --- Enemy Fleet Tracker (names always visible; red when sunk) ------------
function renderFleetTracker(){
  if (!fleetEl) return;
  const ships = state.opp?.ships || [];
  if (!ships.length){ fleetEl.innerHTML = ''; return; }

  const sorted = [...ships].sort((a,b)=>{
    if (a.length !== b.length) return b.length - a.length; // 5,4,3,3,2
    return a.id - b.id; // stable order (3a/3b)
  });

  let seen3 = 0;
  const html = sorted.map(s=>{
    const hits = (s.hits?.length||0);
    const sunk = hits === s.length;

    let label;
    if (s.length === 5) label = 'Carrier (5)';
    else if (s.length === 4) label = 'Battleship (4)';
    else if (s.length === 3){ seen3 += 1; label = seen3 === 1 ? 'Cruiser (3a)' : 'Submarine (3b)'; }
    else if (s.length === 2) label = 'Destroyer (2)';
    else label = `Ship (${s.length})`;

    const cls = sunk ? 'chip sunk' : 'chip neutral';
    const title = sunk ? 'Sunk' : 'Alive';
    return `<div class="${cls}" title="${title}"><span class="len">🛳</span> ${label} ${sunk?'<strong>· Sunk</strong>':''}</div>`;
  }).join('');

  fleetEl.innerHTML = html;
}

// Toast
function showToast(text){
  if (!toastEl) return;
  const div = document.createElement('div');
  div.className = 'toast-item';
  div.textContent = text;
  toastEl.appendChild(div);
  requestAnimationFrame(()=> div.classList.add('show'));
  setTimeout(()=>{ div.classList.remove('show'); setTimeout(()=>div.remove(),250); }, 2200);
}

// --- manual placement interactions ---
function onMyCellEnter(r,c){ if(!placing.enabled) return; showPreview(r,c); }
function onMyCellLeave(){ if(!placing.enabled) return; clearPreview(); }
function onMyCellClick(r,c){
  if(!placing.enabled||placing.nextIndex>=placing.queue.length) return;
  const len=placing.queue[placing.nextIndex], horiz=placing.dir==="H";
  if(canPlace(state.me.board,r,c,len,horiz)){
    const id=state.me.ships.length+1, cells=[];
    for(let i=0;i<len;i++){ const rr=r+(horiz?0:i), cc=c+(horiz?i:0); state.me.board[rr][cc]=id; cells.push([rr,cc]); }
    state.me.ships.push({id,length:len,cells});
    placing.nextIndex++; clearPreview(); paint(); updateShipInfo();
    if(placing.nextIndex>=placing.queue.length){ placing.enabled=false; setStatus("All ships placed. Click 'I’m ready'."); }
  }else{ showPreview(r,c,true); setStatus("Invalid spot."); }
}
function showPreview(r,c,forceInvalid=false){
  clearPreview();
  const len = placing.queue[placing.nextIndex] ?? 0;  // <- declare ONCE
  const horiz = placing.dir==="H";
  const valid = !forceInvalid && canPlace(state.me.board,r,c,len,horiz);
  for(let i=0;i<len;i++){
    const rr=r+(horiz?0:i), cc=c+(horiz?i:0);
    if(rr<0||rr>=SIZE||cc<0||cc>=SIZE) continue;
    const cell=myBoardEl.children[rr*SIZE+cc];
    if(!cell) continue;
    cell.classList.add(valid?"ghost-valid":"ghost-invalid");
    // colorized preview by length
    if (valid){
      if (len===5) cell.classList.add('len5');
      else if (len===4) cell.classList.add('len4');
      else if (len===3) cell.classList.add('len3a');
      else if (len===2) cell.classList.add('len2');
    }
    placing.previewCells.push(cell);
  }
}
function clearPreview(){
  placing.previewCells.forEach(el => {
    el.classList.remove('ghost-valid','ghost-invalid','len5','len4','len3a','len3b','len2');
  });
  placing.previewCells.length = 0;
}
function updateShipInfo(){ const left=placing.queue.slice(placing.nextIndex).join(","); shipInfo.textContent=`Ships: ${left||"none"} · Dir: ${placing.dir}`; }

// ---------------------------------------------------------------------------
// 8. GAMEPLAY INTERACTIONS
// ---------------------------------------------------------------------------
function onEnemyCellClick(r,c){
  if(state.phase!=="battle") return;
  if(state.turn!==state.me.id) return setStatus("Not your turn.");
  if(state.me.marks && (state.me.marks[r][c]===2 || state.me.marks[r][c]===3)) return;
  send({ type:"FIRE", r, c });
}

// ---------------------------------------------------------------------------
// 9. APPLY SERVER STATE (sounds + tracker, no spoilers)
// ---------------------------------------------------------------------------
function applyRoomState(s){
  // Capture previous sunk enemy ids BEFORE updating
  const prevOppShips = state.opp?.ships || [];
  const prevSunkNow = new Set(prevOppShips.filter(x => (x.hits?.length||0) === x.length).map(x => x.id));

  // Detect NEW hit/miss by diffing marks from server payload (me + opp)
  const meIncoming  = s.players.me  || {};
  const oppIncoming = s.players.opp || {};
  const meNewMarks  = meIncoming.marks  || state.me.marks  || prev.marks;
  const oppNewMarks = oppIncoming.marks || state.opp?.marks || prev.oppMarks;

  let newHit = false, newMiss = false;

  // MY marks (shots I fired)
  for (let r=0;r<SIZE;r++){
    for (let c=0;c<SIZE;c++){
      const before = prev.marks?.[r]?.[c] ?? 0;
      const after  = meNewMarks?.[r]?.[c] ?? 0;
      if (before===0 && after===2) newHit = true;
      else if (before===0 && after===3) newMiss = true;
    }
  }
  // OPP marks (shots opponent fired at me)
  for (let r=0;r<SIZE;r++){
    for (let c=0;c<SIZE;c++){
      const before = prev.oppMarks?.[r]?.[c] ?? 0;
      const after  = oppNewMarks?.[r]?.[c] ?? 0;
      if (before===0 && after===2) newHit = true;
      else if (before===0 && after===3) newMiss = true;
    }
  }

  if (newHit) playSound('hit');
  else if (newMiss) playSound('miss');

  // --- commit state from server ---
  state.phase  = s.phase;
  state.turn   = s.turn;
  state.winner = s.winner;
  state.code   = s.code || state.code;

  const me  = s.players.me;
  const opp = s.players.opp;
  if (me)  state.me  = { ...state.me, ...me };
  state.opp = opp;

  // Detect NEWLY sunk enemy ships AFTER updating state.opp
  const newOppShips = state.opp?.ships || [];
  const nowSunk = newOppShips.filter(x => (x.hits?.length||0) === x.length).map(x => x.id);
  for (const id of nowSunk){
    if (!prevSunkNow.has(id) && !prevSunkOpp.has(id)){
      const ship = newOppShips.find(s => s.id === id);
      const len = ship?.length || '?';
      const name = len===5 ? 'Carrier' : len===4 ? 'Battleship' : len===3 ? 'Cruiser/Submarine' : len===2 ? 'Destroyer' : `Ship (${len})`;
      showToast(`You sank their ${name}!`);
      prevSunkOpp.add(id);
    }
  }

  // Update previous snapshots for next diff
  prev.turn     = state.turn;
  prev.phase    = state.phase;
  prev.marks    = (state.me.marks  || emptyBoard()).map(row => row.slice());
  prev.oppMarks = (state.opp?.marks || emptyBoard()).map(row => row.slice());

  // Update tracker + repaint
  renderFleetTracker();
  paint();
}

// ---------------------------------------------------------------------------
// 10. UI RENDERING
// ---------------------------------------------------------------------------
function paint(){
  const phaseTxt = state.phase==="placing"?"Placing":state.phase==="battle"?"Battle":"Game Over";
  pillEl.textContent = state.code ? `${phaseTxt} · Room ${state.code}` : phaseTxt;

  if(state.phase==="placing"){
    setStatus(`${readyCount()} ready. Place fleet → I’m ready.`);
  } else if(state.phase==="battle"){
    setStatus(state.turn===state.me.id?"Your turn — click enemy grid.":"Opponent’s turn.");
  } else if(state.phase==="gameover"){
    setStatus(state.winner === state.me.id ? '🏆 You win!' : '💥 You lost.');
    if (!soundPlayed){
      soundPlayed = true;
      playSound(state.winner === state.me.id ? 'win' : 'lose');
    }
  } else {
    soundPlayed = false;
  }

  // My board
  [...myBoardEl.children].forEach(cell=>{
    const [r,c]=cell.dataset.rc.split(",").map(Number);
    const id=state.me.board?.[r]?.[c]??0;
    const takenHit=state.opp?.marks?.[r]?.[c]===2;
    const missOnMe=state.opp?.marks?.[r]?.[c]===3;

    cell.className="cell";
    cell.classList.remove('fire');

    if (id !== EMPTY) {
      cell.classList.add("ship");
      const ship = state.me.ships?.find(s => s.id === id);
      if (ship) {
        const len = ship.length;
        if (len === 5) cell.classList.add("len5");
        else if (len === 4) cell.classList.add("len4");
        else if (len === 3) {
          const all3 = state.me.ships.filter(s => s.length === 3);
          const index = all3.findIndex(s => s.id === ship.id);
          cell.classList.add(index === 0 ? "len3a" : "len3b");
        } else if (len === 2) cell.classList.add("len2");
      }
    }
    if (takenHit){ cell.classList.add('hit','fire'); }
if (missOnMe) cell.classList.add("miss");

if (id !== EMPTY){
  const ship = state.me.ships?.find(s => s.id === id);
  if (ship && (ship.hits?.length || 0) === ship.length){
    cell.classList.add("sunk","skull");
    cell.classList.remove("fire");        // 🔥 stop fire on sunk cells
  }
}
  });

  // Enemy board
  [...enemyBoardEl.children].forEach(cell=>{
    const [r,c]=cell.dataset.rc.split(",").map(Number);
    const mark=state.me.marks?.[r]?.[c]||0;

    cell.className="cell";
    if(mark===2){ cell.classList.add("hit"); }
    if(mark===3) cell.classList.add("miss");

    if(mark===2){
      const id=state.opp?.board?.[r]?.[c]||0;
      const ship=state.opp?.ships?.find(s=>s.id===id);
      if(ship && (ship.hits?.length||0)===ship.length) cell.classList.add("sunk");
    }
    // Reveal ALL cells of any sunk enemy ship; stop fire on them
if (state.opp?.ships) {
  state.opp.ships.forEach(s => {
    const sunk = (s.hits?.length || 0) === s.length;
    if (!sunk) return;
    (s.cells || []).forEach(([rr, cc]) => {
      const idx = rr * SIZE + cc;
      const el = enemyBoardEl.children[idx];
      if (!el) return;
      el.classList.add('sunk','skull');
      el.classList.remove('fire');
    });
  });
}
  });

  enemyBoardEl.classList.toggle("disabled", state.phase!=="battle" || state.turn!==state.me.id);
}

function readyCount(){
  const meReady=state.me?.ready?1:0, oppReady=state.opp?.ready?1:0;
  return `${meReady+oppReady}/2`;
}
function setStatus(msg){ statusEl.textContent=msg; }

// ---------------------------------------------------------------------------
// 11. VISUAL / AUDIO HOOKS
// ---------------------------------------------------------------------------
function flashCell(cell,type){ /* optional future animation */ }
function playSound(type){
  const audio = new Audio(`sounds/${type}.mp3`);
  audio.volume = 0.4;
  audio.play().catch(()=>{});
}

// Splash: show for 3s, then fade out
window.addEventListener('load', () => {
  const intro = document.getElementById('introScreen');
  if (!intro) return;
  setTimeout(() => intro.classList.add('hidden'), 3000);
});
