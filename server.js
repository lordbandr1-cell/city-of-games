const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/xo', (req, res) => res.sendFile(path.join(__dirname, 'game_xo.html')));
app.get('/stop', (req, res) => res.sendFile(path.join(__dirname, 'game_stop.html')));
app.get('/hockey', (req, res) => res.sendFile(path.join(__dirname, 'game_hockey.html')));
app.get('/quiz', (req, res) => res.sendFile(path.join(__dirname, 'game_quiz.html')));

let quizDB = {};
try {
    const qPath = path.join(process.cwd(), 'quiz.json');
    if (fs.existsSync(qPath)) quizDB = JSON.parse(fs.readFileSync(qPath, 'utf8'));
} catch (e) { console.error("Quiz DB Error"); }

function normalize(t) { return t ? t.trim().replace(/[أإآ]/g,'ا').replace(/ة$/,'ه').replace(/ى$/,'ي') : ""; }
function checkAns(u, c) { let ux=normalize(u), cx=normalize(c); return ux===cx || (cx.includes(ux) && ux.length>3); }

// Hockey Physics
function updateHockey(r) {
    let p=r.puck; p.x+=p.dx; p.y+=p.dy; p.dx*=0.995; p.dy*=0.995;
    if(p.x<=12||p.x>=388) p.dx*=-1;
    if(p.y<=0){ if(p.x>120&&p.x<280){r.scores.p1++; resetPuck(r); return 'goal';} else {p.y=0; p.dy*=-1;} }
    if(p.y>=600){ if(p.x>120&&p.x<280){r.scores.p2++; resetPuck(r); return 'goal';} else {p.y=600; p.dy*=-1;} }
    checkPad(r,'p1'); checkPad(r,'p2'); return null;
}
function resetPuck(r){ r.puck={x:200,y:300,dx:0,dy:0}; setTimeout(()=>{ let a=(Math.random()*Math.PI/2)+(Math.PI/4), s=8, d=Math.random()>0.5?1:-1; r.puck.dx=Math.cos(a)*s*d; r.puck.dy=Math.sin(a)*s*d; },1000); }
function checkPad(r,id){ let pd=r.paddles[id], p=r.puck, dx=p.x-pd.x, dy=p.y-pd.y, d=Math.sqrt(dx*dx+dy*dy); if(d<34){ let a=Math.atan2(dy,dx),s=Math.min(Math.max(Math.sqrt(p.dx**2+p.dy**2),12),25); p.dx=Math.cos(a)*s*1.05; p.dy=Math.sin(a)*s*1.05; p.x+=Math.cos(a)*(34-d); p.y+=Math.sin(a)*(34-d); } }

// Stop Scoring
function calcStop(ans, char) {
    let score=0, details={}; const t=normalize(char);
    for(const [k,v] of Object.entries(ans)){
        let val=normalize(v); if(val.startsWith("ال")&&val[2]===t) val=val.substring(2);
        if(val && val[0]===t) { score+=10; details[k]=10; } else details[k]=0;
    }
    return {total:score, details};
}

const rooms = {};

io.on('connection', (socket) => {
    socket.on('get_cats', () => { if(Object.keys(quizDB).length) socket.emit('cats_data', Object.keys(quizDB).map(k=>({name:k, image:quizDB[k].image}))); });

    socket.on('join_game_lobby', ({ roomId, playerName, gameType, cats, teamNames, timeLimit }) => {
        roomId = roomId ? roomId.toUpperCase() : "TEST";
        if (!rooms[roomId]) {
            let r = { 
                id: roomId, type: gameType, players: [], state: 'lobby',
                teamNames: teamNames || ["الفريق 1", "الفريق 2"],
                // Stop Vars
                round: 0, answers: {}, stopTime: timeLimit || 60, stopTimer: null,
                // Others
                qState: 'idle', activePlayerIdx: 0, stealingPlayerIdx: -1, qTimer: null, isDouble: false,
                hockeyInterval: null, puck:{x:200,y:300,dx:0,dy:0}, scores:{p1:0,p2:0}, paddles:{p1:{x:200,y:550},p2:{x:200,y:50}},
                board: Array(9).fill(null), turn: 0
            };
            if(gameType==='quiz'){
                let sel = cats||[]; if(sel.length<6) sel=Object.keys(quizDB).sort(()=>0.5-Math.random()).slice(0,6);
                r.catData = sel.map(c=>({name:c, image:quizDB[c]?.image||'', questions: (quizDB[c]?.questions||[]).sort(()=>0.5-Math.random()).slice(0,6)}));
                r.qBoard = Array(6).fill().map(()=>Array(6).fill(0));
            }
            rooms[roomId] = r;
        }
        const r = rooms[roomId];
        if(r.type!==gameType || r.players.length>=2) { socket.emit('error_msg', 'ممتلئة'); return; }
        
        let finalName = playerName;
        if(gameType==='quiz') finalName = r.teamNames[r.players.length];
        else if(!finalName) finalName = r.players.length===0 ? "Host" : "Guest";

        r.players.push({ id:socket.id, name:finalName, ready:false, score:0, idx:r.players.length });
        socket.join(roomId);

        if(gameType==='hockey'){
            io.to(roomId).emit('hockey_lobby_update', {players:r.players, roomId});
            if(r.players.length===2) { let c=3; let iv=setInterval(()=>{ io.to(roomId).emit('hockey_countdown',c); c--; if(c<0){ clearInterval(iv); startHockey(roomId); } },1000); }
        } else io.to(roomId).emit('lobby_update', {players:r.players, roomId});
    });

    socket.on('player_ready_signal', ({roomId}) => {
        const r=rooms[roomId]; if(!r) return;
        const p=r.players.find(x=>x.id===socket.id); if(p){ p.ready=!p.ready; io.to(roomId).emit('lobby_update', {players:r.players, roomId}); }
        if(r.players.length===2 && r.players.every(x=>x.ready)){
            r.state='playing'; io.to(roomId).emit('game_start_now', {roomState:r});
            if(r.type==='xo') io.to(roomId).emit('xo_start', {board:r.board, turnId:r.players[r.turn].id});
            if(r.type==='stop') startStopRound(roomId);
        }
    });

    // Quiz Logic
    socket.on('quiz_pick', ({roomId, cI, qI, dbl}) => {
        const r=rooms[roomId]; if(r.players[r.activePlayerIdx].id!==socket.id) return;
        r.qBoard[cI][qI]=1; r.qState='answering'; r.isDouble=dbl && !r.players[r.activePlayerIdx].dblUsed;
        if(r.isDouble) r.players[r.activePlayerIdx].dblUsed=true;
        r.currQ = {...r.catData[cI].questions[qI], cI, qI, p:[200,200,400,400,600,600][qI], catImg: r.catData[cI].image};
        io.to(roomId).emit('quiz_ui_update', r);
        io.to(roomId).emit('open_q', {q:r.currQ, activeIdx:r.activePlayerIdx, state:'answering', dbl:r.isDouble});
        startQuizTimer(r,roomId,60,'answering');
    });
    socket.on('quiz_ans', ({roomId, ans}) => {
        const r=rooms[roomId]; clearInterval(r.qTimer);
        const ok=checkAns(ans, r.currQ.a); let pts=r.currQ.p*(r.isDouble?2:1);
        if(r.qState==='answering'){
            if(ok){ r.players[r.activePlayerIdx].score+=pts; io.to(roomId).emit('q_res', {ok:true, ans:r.currQ.a, pts, msg:"✅"}); nextQuizTurn(r,roomId); }
            else { r.qState='stealing'; r.stealingPlayerIdx=(r.activePlayerIdx+1)%2; io.to(roomId).emit('q_res_temp', {msg:"🚨 سرقة!"}); setTimeout(()=>{ io.to(roomId).emit('open_q', {q:r.currQ, activeIdx:r.stealingPlayerIdx, state:'stealing'}); startQuizTimer(r,roomId,15,'stealing'); },1500); }
        } else {
            if(ok){ r.players[r.stealingPlayerIdx].score+=pts; io.to(roomId).emit('q_res', {ok:true, ans:r.currQ.a, pts, msg:"🥷"}); }
            else io.to(roomId).emit('q_res', {ok:false, ans:r.currQ.a, pts:0, msg:"❌"});
            nextQuizTurn(r,roomId);
        }
    });
    function startQuizTimer(r, rid, s, state) {
        let t=s; clearInterval(r.qTimer);
        r.qTimer=setInterval(()=>{ t--; io.to(rid).emit('timer', t); if(t<=0){ clearInterval(r.qTimer); if(state==='answering'){ r.qState='stealing'; r.stealingPlayerIdx=(r.activePlayerIdx+1)%2; io.to(rid).emit('q_res_temp', {msg:"🚨 الوقت!"}); setTimeout(()=>{ io.to(rid).emit('open_q', {q:r.currQ, activeIdx:r.stealingPlayerIdx, state:'stealing'}); startQuizTimer(r,rid,15,'stealing'); },1500); } else { io.to(rid).emit('q_res', {ok:false, ans:r.currQ.a, pts:0, msg:"انتهى"}); nextQuizTurn(r,rid); } } },1000);
    }
    function nextQuizTurn(r, rid){ r.activePlayerIdx=(r.activePlayerIdx+1)%2; r.qState='idle'; r.isDouble=false; r.currQ=null; setTimeout(()=>io.to(rid).emit('quiz_ui_update',r),3000); }

    // Hockey
    function startHockey(rid){ const r=rooms[rid]; io.to(rid).emit('hockey_start', {players:r.players}); if(r.hockeyInterval) clearInterval(r.hockeyInterval); r.hockeyInterval=setInterval(()=>{ const ev=updateHockey(r); io.to(rid).emit('hockey_tick', {puck:r.puck, paddles:r.paddles, scores:r.scores, ev}); if(r.scores.p1>=7||r.scores.p2>=7){ clearInterval(r.hockeyInterval); io.to(rid).emit('game_over', {winner:r.scores.p1>=7?r.players[0].id:r.players[1].id}); } },1000/60); }
    socket.on('hockey_move', ({roomId, x, y})=>{ const r=rooms[roomId]; if(!r) return; const pid=r.players[0].id===socket.id?'p1':'p2'; if(pid==='p1'){r.paddles.p1.x=x; r.paddles.p1.y=Math.max(322, Math.min(578,y));} else {r.paddles.p2.x=x; r.paddles.p2.y=Math.min(278, Math.max(22,y));} });

    // XO
    socket.on('xo_move', ({roomId, idx})=>{ const r=rooms[roomId]; if(!r||r.state!=='playing'||r.board[idx]) return; if(r.players[r.turn].id!==socket.id) return; r.board[idx]=r.turn===0?'X':'O'; let w=null; [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]].forEach(a=>{ if(r.board[a[0]]&&r.board[a[0]]===r.board[a[1]]&&r.board[a[0]]===r.board[a[2]]) w=r.players[r.turn].id; }); if(w) io.to(roomId).emit('xo_update', {board:r.board, winner:w}); else if(!r.board.includes(null)) io.to(roomId).emit('xo_update', {board:r.board, draw:true}); else { r.turn=(r.turn+1)%2; io.to(roomId).emit('xo_update', {board:r.board, turnId:r.players[r.turn].id}); } });
    socket.on('xo_rematch', ({roomId})=>{ const r=rooms[roomId]; if(!r) return; r.board=Array(9).fill(null); r.turn=(r.turn+1)%2; io.to(roomId).emit('xo_start', {board:r.board, turnId:r.players[r.turn].id}); });

    // Stop (Updated Logic)
    function startStopRound(rid){ 
        const r=rooms[rid]; r.round++; r.answers={}; const c="ابتثجحخدذرزسشصضطظعغفقكلمنهوي"; r.char=c[Math.floor(Math.random()*c.length)]; 
        io.to(rid).emit('stop_round_start', {char:r.char, round:r.round, time:r.stopTime});
        // Server Timer
        let t=r.stopTime; if(r.stopTimer) clearInterval(r.stopTimer);
        r.stopTimer = setInterval(()=>{
            t--; io.to(rid).emit('stop_timer', t);
            if(t<=0) { clearInterval(r.stopTimer); io.to(rid).emit('force_stop_submit'); }
        },1000);
    }
    socket.on('stop_submit', ({roomId, answers})=>{ 
        const r=rooms[roomId]; if(!r||r.answers[socket.id]) return;
        const res=calcStop(answers, r.char); 
        r.answers[socket.id]={ans:answers, score:res.total, details:res.details}; 
        r.players.find(x=>x.id===socket.id).score+=res.total;
        
        if(Object.keys(r.answers).length===r.players.length){ // Both submitted
            clearInterval(r.stopTimer);
            io.to(roomId).emit('stop_round_end', {
                results: r.answers, 
                players: r.players
            }); 
            setTimeout(()=>{ if(r.round<3) startStopRound(roomId); else io.to(roomId).emit('stop_game_over', {players:r.players}); }, 8000);
        }
    });
});

server.listen(process.env.PORT || 3000, () => console.log('Run'));