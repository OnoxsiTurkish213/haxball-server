const express=require('express');
const http=require('http');
const {Server}=require('socket.io');

const app=express();
const server=http.createServer(app);
const io=new Server(server,{
    cors:{origin:'*',methods:['GET','POST']},
    pingInterval:10000,
    pingTimeout:5000
});

app.get('/',(req,res)=>res.send('HaxBall Server Çalışıyor!'));

// Oda yönetimi
const rooms={};

// Harita tanımları (server'da da lazım - fizik için)
const MAPS={
    classic:{fw:1200,fh:600,gh:150,gd:55,bf:.987,pf:.91},
    big:{fw:1500,fh:750,gh:180,gd:60,bf:.988,pf:.92},
    small:{fw:900,fh:450,gh:120,gd:45,bf:.985,pf:.90},
    hockey:{fw:1100,fh:500,gh:130,gd:50,bf:.993,pf:.955},
    futsal:{fw:1000,fh:520,gh:135,gd:48,bf:.983,pf:.90}
};

// Fizik sabitleri
const PR=19,BR=11,KF=5.5,PKF=17,PSP=6.5;
const PA=.28,PMS=2.8,BMS=10,BD=.62,PBD=.24,BPF=.32,PSR=6;
const KICK_HOLD_MAX=60,PCD=2700,RCF=5;
const FDT=1000/60;
const MDR=180;

function dst(x1,y1,x2,y2){const dx=x2-x1,dy=y2-y1;return Math.sqrt(dx*dx+dy*dy)}
function clp(v,a,b){return v<a?a:v>b?b:v}
function nrm(x,y){const l=Math.sqrt(x*x+y*y);return l<1e-5?{x:0,y:0}:{x:x/l,y:y/l}}
function lerp(a,b,t){return a+(b-a)*t}

function slotCfg(ts){
    if(ts<=0)return{GK:0,DEF:0,MID:0,FWD:0};
    if(ts<=4)return{GK:1,DEF:1,MID:1,FWD:1};
    if(ts===5)return{GK:1,DEF:2,MID:1,FWD:1};
    if(ts===6)return{GK:1,DEF:2,MID:2,FWD:1};
    if(ts===7)return{GK:1,DEF:2,MID:2,FWD:2};
    if(ts===8)return{GK:1,DEF:3,MID:2,FWD:2};
    if(ts===9)return{GK:1,DEF:3,MID:3,FWD:2};
    if(ts===10)return{GK:1,DEF:3,MID:3,FWD:3};
    return{GK:1,DEF:4,MID:3,FWD:3};
}
function tmSz(players,team){
    let c=0;
    for(const p of Object.values(players)){if(p.online!==false&&p.team===team)c++}
    return c;
}
function cntPos(players,team,pos,ex){
    let c=0;
    for(const[id,p] of Object.entries(players)){if(id===ex||p.online===false)continue;if(p.team===team&&p.pos===pos)c++}
    return c;
}
function aPos(players,team,pid){
    let ts=tmSz(players,team);
    if(!(players[pid]&&players[pid].team===team&&players[pid].online!==false))ts++;
    const c=slotCfg(ts),o=['GK','DEF','MID','FWD'];
    for(const pos of o){if(cntPos(players,team,pos,pid)<(c[pos]||0))return pos}
    return'MID';
}
function spPos(team,pos,idx,tot,m){
    let bx=m.fw/2;
    if(team==='red'){if(pos==='GK')bx=50;else if(pos==='DEF')bx=m.fw*.18;else if(pos==='MID')bx=m.fw*.34;else bx=m.fw*.45}
    else{if(pos==='GK')bx=m.fw-50;else if(pos==='DEF')bx=m.fw*.82;else if(pos==='MID')bx=m.fw*.66;else bx=m.fw*.55}
    const sp=Math.min(68,(m.fh-80)/Math.max(tot,1));
    return{x:bx,y:m.fh/2-(tot-1)*sp/2+idx*sp};
}

function createRoom(code,hostId,mapKey,goalLimit,password){
    const m=MAPS[mapKey]||MAPS.classic;
    rooms[code]={
        code,hostId,mapKey,goalLimit,password,
        players:{},
        state:'lobby',
        ball:{x:m.fw/2,y:m.fw/2,vx:0,vy:0,fire:false,ft:0},
        match:{redScore:0,blueScore:0,time:0,running:false,paused:false},
        goalFreeze:false,goalTimer:0,
        gameLoop:null,
        fireParts:[]
    };
    return rooms[code];
}

function startGameLoop(code){
    const room=rooms[code];
    if(!room)return;
    if(room.gameLoop)clearInterval(room.gameLoop);
    room.gameLoop=setInterval(()=>{
        if(!rooms[code]){clearInterval(room.gameLoop);return}
        hostPhysics(code);
        // Tüm clientlara state gönder
        const state=buildState(code);
        if(state)io.to(code).emit('state',state);
    },FDT);
}

function stopGameLoop(code){
    const room=rooms[code];
    if(room&&room.gameLoop){clearInterval(room.gameLoop);room.gameLoop=null}
}

function buildState(code){
    const room=rooms[code];
    if(!room)return null;
    const pOut={};
    for(const[id,p] of Object.entries(room.players)){
        if(p.online===false)continue;
        pOut[id]={x:+p.x.toFixed(1),y:+p.y.toFixed(1),vx:+p.vx.toFixed(2),vy:+p.vy.toFixed(2),kick:p.kick||false,team:p.team,pos:p.pos||'',name:p.name,pCD:p.pCD||0};
    }
    return{
        players:pOut,
        ball:{x:+room.ball.x.toFixed(1),y:+room.ball.y.toFixed(1),vx:+room.ball.vx.toFixed(2),vy:+room.ball.vy.toFixed(2),fire:room.ball.fire},
        match:{...room.match},
        goalFreeze:room.goalFreeze
    };
}

function hostPhysics(code){
    const room=rooms[code];
    if(!room)return;
    const m=MAPS[room.mapKey]||MAPS.classic;
    const{fw:FW,fh:FH,gh:GH,gd:GD,bf,pf}=m;
    const gT=FH/2-GH/2,gB=FH/2+GH/2;
    const dtS=FDT/1000;
    const match=room.match;
    const B=room.ball;

    // Süre
    if(match.running&&!match.paused&&!room.goalFreeze){
        match.time+=dtS;
        if(match.time>=MDR){match.running=false;match.time=MDR;io.to(code).emit('matchEnd',{reason:'time',redScore:match.redScore,blueScore:match.blueScore})}
    }

    // Gol dondurma
    if(room.goalFreeze){
        room.goalTimer-=FDT;
        if(room.goalTimer<=0){
            room.goalFreeze=false;
            resetPositions(code);
            io.to(code).emit('resetPositions',buildState(code));
        }
        return;
    }
    if(match.paused||!match.running)return;

    const players=room.players;
    const acts=Object.entries(players).filter(([,p])=>p.online!==false&&p.team!=='spectator');

    // OYUNCU FİZİĞİ
    for(const[,pp] of acts){
        if(pp.rcT>0){pp.x+=pp.rcVx;pp.y+=pp.rcVy;pp.rcVx*=.88;pp.rcVy*=.88;pp.rcT--}
        const inL=Math.sqrt(pp.iDx*pp.iDx+pp.iDy*pp.iDy);
        if(inL>.05){const nm=nrm(pp.iDx,pp.iDy);pp.vx+=nm.x*PA*Math.min(inL,1);pp.vy+=nm.y*PA*Math.min(inL,1)}
        const spd=Math.sqrt(pp.vx*pp.vx+pp.vy*pp.vy);
        if(spd>PMS){pp.vx=(pp.vx/spd)*PMS;pp.vy=(pp.vy/spd)*PMS}
        pp.vx*=pf;pp.vy*=pf;
        if(Math.abs(pp.vx)<.003)pp.vx=0;if(Math.abs(pp.vy)<.003)pp.vy=0;
        pp.x+=pp.vx;pp.y+=pp.vy;
        if(pp.iK){if(pp.kickHeld<KICK_HOLD_MAX)pp.kickHeld++;pp.kick=true}
        else{pp.kickHeld=0;pp.kick=false}
        if(pp.pCD>0)pp.pCD--;
        pp.x=clp(pp.x,PR,FW-PR);pp.y=clp(pp.y,PR,FH-PR);
    }

    // OYUNCU-OYUNCU ÇARPIŞMA
    for(let i=0;i<acts.length;i++){
        for(let j=i+1;j<acts.length;j++){
            const[,pa]=acts[i],[,pb]=acts[j];
            const cd=dst(pa.x,pa.y,pb.x,pb.y),mD=PR*2;
            if(cd<mD&&cd>.001){
                const cnx=(pb.x-pa.x)/cd,cny=(pb.y-pa.y)/cd,ov=mD-cd;
                pa.x-=cnx*ov*.5;pa.y-=cny*ov*.5;pb.x+=cnx*ov*.5;pb.y+=cny*ov*.5;
                const dvx=pa.vx-pb.vx,dvy=pa.vy-pb.vy,dvn=dvx*cnx+dvy*cny;
                if(dvn>0){pa.vx-=dvn*cnx*PBD;pa.vy-=dvn*cny*PBD;pb.vx+=dvn*cnx*PBD;pb.vy+=dvn*cny*PBD}
            }
        }
    }

    // TOP FİZİĞİ
    if(B.ft>0){B.ft--;if(B.ft<=0)B.fire=false}
    B.vx*=bf;B.vy*=bf;
    if(Math.abs(B.vx)<.004)B.vx=0;if(Math.abs(B.vy)<.004)B.vy=0;
    B.x+=B.vx;B.y+=B.vy;
    const bsp=Math.sqrt(B.vx*B.vx+B.vy*B.vy);
    const maxB=B.fire?BMS*2:BMS;
    if(bsp>maxB){B.vx=(B.vx/bsp)*maxB;B.vy=(B.vy/bsp)*maxB}

    // OYUNCU-TOP ÇARPIŞMA
    for(const[pid,bp] of acts){
        const bd=dst(bp.x,bp.y,B.x,B.y);
        const activeRange=PR+BR+(bp.kick?2:0);
        if(bd<activeRange&&bd>.001){
            const bnx=(B.x-bp.x)/bd,bny=(B.y-bp.y)/bd;
            const minD=PR+BR;
            if(bd<minD){const bov=minD-bd;B.x+=bnx*bov;B.y+=bny*bov}
            const bdvx=B.vx-bp.vx,bdvy=B.vy-bp.vy,bdvn=bdvx*bnx+bdvy*bny;
            if(bp.kick){
                if(bp.iPw&&bp.pCD<=0){
                    const holdR=Math.min(bp.kickHeld/KICK_HOLD_MAX,1);
                    const pwF=PKF*(0.7+holdR*0.5);
                    B.vx=bnx*pwF;B.vy=bny*pwF;
                    B.fire=true;B.ft=120;bp.pCD=PCD;bp.iPw=false;
                    io.to(code).emit('powerShot',{pid});
                } else if(bp.iP){
                    const mate=findMate(code,pid);
                    if(mate){const dx=mate.x-B.x,dy=mate.y-B.y;const dn=nrm(dx,dy);B.vx=dn.x*PSP;B.vy=dn.y*PSP}
                    else{B.vx+=bnx*KF;B.vy+=bny*KF}
                } else {
                    if(bdvn<KF){const addF=KF-Math.max(bdvn,0);B.vx+=bnx*addF;B.vy+=bny*addF}
                }
            } else {
                if(bdvn<0){B.vx-=bdvn*bnx*BPF;B.vy-=bdvn*bny*BPF}
            }
            if(B.fire&&bdvn<0){
                const bspd2=Math.sqrt(B.vx*B.vx+B.vy*B.vy);
                if(bspd2>6){bp.rcVx=-bnx*RCF;bp.rcVy=-bny*RCF;bp.rcT=10}
            }
        }
    }

    // KALE DİREKLERİ
    const posts=[{x:0,y:gT},{x:0,y:gB},{x:FW,y:gT},{x:FW,y:gB}];
    for(const po of posts){
        const pd=dst(B.x,B.y,po.x,po.y);
        if(pd<BR+PSR&&pd>.001){
            const pnx=(B.x-po.x)/pd,pny=(B.y-po.y)/pd,pov=BR+PSR-pd;
            B.x+=pnx*pov;B.y+=pny*pov;
            const pdot=B.vx*pnx+B.vy*pny;
            if(pdot<0){B.vx-=2*pdot*pnx*BD;B.vy-=2*pdot*pny*BD}
        }
    }

    // SINIRLAR & GOL
    if(B.y-BR<0){B.y=BR;if(B.vy<0)B.vy=-B.vy*BD}
    if(B.y+BR>FH){B.y=FH-BR;if(B.vy>0)B.vy=-B.vy*BD}
    if(B.x-BR<0){
        if(B.y>gT&&B.y<gB){if(B.x-BR<-GD){handleGoal(code,'blue');return}}
        else{B.x=BR;if(B.vx<0)B.vx=-B.vx*BD}
    }
    if(B.x+BR>FW){
        if(B.y>gT&&B.y<gB){if(B.x+BR>FW+GD){handleGoal(code,'red');return}}
        else{B.x=FW-BR;if(B.vx>0)B.vx=-B.vx*BD}
    }
    if(B.x<-GD){B.x=-GD+BR;if(B.vx<0)B.vx=Math.abs(B.vx)*BD}
    if(B.x>FW+GD){B.x=FW+GD-BR;if(B.vx>0)B.vx=-Math.abs(B.vx)*BD}
}

function handleGoal(code,team){
    const room=rooms[code];
    if(!room)return;
    if(team==='red')room.match.redScore++;else room.match.blueScore++;
    room.goalFreeze=true;room.goalTimer=1800;
    room.ball.vx=0;room.ball.vy=0;room.ball.fire=false;room.ball.ft=0;
    for(const p of Object.values(room.players)){p.vx=0;p.vy=0;p.kickHeld=0}
    io.to(code).emit('goal',{team,redScore:room.match.redScore,blueScore:room.match.blueScore});
    const{goalLimit}=room;
    if(goalLimit>0&&(room.match.redScore>=goalLimit||room.match.blueScore>=goalLimit)){
        setTimeout(()=>{
            if(!rooms[code])return;
            room.match.running=false;
            io.to(code).emit('matchEnd',{reason:'goal',winner:team,redScore:room.match.redScore,blueScore:room.match.blueScore});
        },1800+200);
    }
}

function resetPositions(code){
    const room=rooms[code];
    if(!room)return;
    const m=MAPS[room.mapKey]||MAPS.classic;
    room.ball.x=m.fw/2;room.ball.y=m.fh/2;room.ball.vx=0;room.ball.vy=0;room.ball.fire=false;room.ball.ft=0;
    const rP=[],bP=[];
    for(const[id,p] of Object.entries(room.players)){
        if(p.online===false)continue;
        if(p.team==='red')rP.push(id);else if(p.team==='blue')bP.push(id);
    }
    spawnGroup(code,rP,'red');spawnGroup(code,bP,'blue');
}

function spawnGroup(code,pids,team){
    const room=rooms[code];const m=MAPS[room.mapKey]||MAPS.classic;
    const g={GK:[],DEF:[],MID:[],FWD:[]};
    for(const id of pids){const pos=room.players[id].pos||'MID';if(!g[pos])g[pos]=[];g[pos].push(id)}
    for(const[pos,arr] of Object.entries(g)){
        for(let j=0;j<arr.length;j++){
            const s=spPos(team,pos,j,arr.length,m);
            const p=room.players[arr[j]];
            p.x=s.x;p.y=s.y;p.vx=0;p.vy=0;p.kickHeld=0;
        }
    }
}

function findMate(code,pid){
    const room=rooms[code];if(!room)return null;
    const me=room.players[pid];if(!me)return null;
    let best=null,bd=1e9;
    for(const[id,p] of Object.entries(room.players)){
        if(id===pid||p.team!==me.team||p.team==='spectator'||p.online===false)continue;
        const d=dst(me.x,me.y,p.x,p.y);if(d<bd){bd=d;best=p}
    }
    return best;
}

// ================================================
// SOCKET.IO EVENTS
// ================================================
io.on('connection',(socket)=>{
    console.log('Bağlandı:',socket.id);

    // ODA KUR
    socket.on('createRoom',(data,cb)=>{
        const{code,playerName,mapKey,goalLimit,password}=data;
        if(rooms[code]){cb({error:'Kod zaten var'});return}
        const room=createRoom(code,socket.id,mapKey||'classic',goalLimit||0,password||'');
        const m=MAPS[room.mapKey]||MAPS.classic;
        room.players[socket.id]={
            id:socket.id,name:playerName||'Oyuncu',team:'spectator',pos:'',
            x:m.fw/2,y:m.fh/2,vx:0,vy:0,kick:false,kickHeld:0,
            iDx:0,iDy:0,iK:false,iP:false,iPw:false,pCD:0,
            rcVx:0,rcVy:0,rcT:0,online:true
        };
        socket.join(code);
        socket.roomCode=code;
        cb({ok:true,code});
        io.to(code).emit('lobbyUpdate',getLobbyData(code));
    });

    // ODAYA KATIL
    socket.on('joinRoom',(data,cb)=>{
        const{code,playerName,password}=data;
        const room=rooms[code];
        if(!room){cb({error:'Oda bulunamadı'});return}
        if(room.password&&room.password!==password){cb({error:'Yanlış şifre'});return}
        if(room.state==='playing'){cb({error:'Oyun başladı'});return}
        const m=MAPS[room.mapKey]||MAPS.classic;
        room.players[socket.id]={
            id:socket.id,name:playerName||'Oyuncu',team:'spectator',pos:'',
            x:m.fw/2,y:m.fh/2,vx:0,vy:0,kick:false,kickHeld:0,
            iDx:0,iDy:0,iK:false,iP:false,iPw:false,pCD:0,
            rcVx:0,rcVy:0,rcT:0,online:true
        };
        socket.join(code);
        socket.roomCode=code;
        cb({ok:true,code,mapKey:room.mapKey,goalLimit:room.goalLimit,hostId:room.hostId});
        io.to(code).emit('lobbyUpdate',getLobbyData(code));
    });

    // TAKIM DEĞİŞTİR
    socket.on('changeTeam',(data)=>{
        const room=rooms[socket.roomCode];if(!room)return;
        const p=room.players[socket.id];if(!p)return;
        const{team}=data;
        if(team==='spectator'){p.team='spectator';p.pos=''}
        else{
            if(tmSz(room.players,team)>=11)return;
            p.team=team;p.pos=aPos(room.players,team,socket.id);
        }
        io.to(socket.roomCode).emit('lobbyUpdate',getLobbyData(socket.roomCode));
    });

    // MEVKİ DEĞİŞTİR
    socket.on('changePos',(data)=>{
        const room=rooms[socket.roomCode];if(!room)return;
        const p=room.players[socket.id];if(!p||p.team==='spectator')return;
        if(cntPos(room.players,p.team,data.pos,socket.id)<(slotCfg(tmSz(room.players,p.team))[data.pos]||0)){
            p.pos=data.pos;
            io.to(socket.roomCode).emit('lobbyUpdate',getLobbyData(socket.roomCode));
        }
    });

    // ADMIN: TAKIM DEĞİŞTİR
    socket.on('adminChangeTeam',(data)=>{
        const room=rooms[socket.roomCode];if(!room||room.hostId!==socket.id)return;
        const p=room.players[data.pid];if(!p)return;
        if(data.team==='spectator'){p.team='spectator';p.pos=''}
        else{if(tmSz(room.players,data.team)>=11)return;p.team=data.team;p.pos=aPos(room.players,data.team,data.pid)}
        io.to(socket.roomCode).emit('lobbyUpdate',getLobbyData(socket.roomCode));
    });

    // OYUNU BAŞLAT
    socket.on('startGame',(cb)=>{
        const room=rooms[socket.roomCode];
        if(!room||room.hostId!==socket.id){if(cb)cb({error:'Yetkisiz'});return}
        const ps=room.players;
        let rc=0,bc=0;
        for(const p of Object.values(ps)){if(p.online===false)continue;if(p.team==='red')rc++;if(p.team==='blue')bc++}
        if(rc<1||bc<1){if(cb)cb({error:'Her takımda 1+'});return}
        // Pozisyon ata
        const rP=[],bP=[];
        for(const[id,p] of Object.entries(ps)){
            if(p.online===false)continue;
            if(p.team==='red')rP.push(id);else if(p.team==='blue')bP.push(id);
        }
        for(const id of rP){if(!ps[id].pos)ps[id].pos=aPos(ps,'red',id)}
        for(const id of bP){if(!ps[id].pos)ps[id].pos=aPos(ps,'blue',id)}
        room.state='playing';
        room.match={redScore:0,blueScore:0,time:0,running:true,paused:false};
        room.goalFreeze=false;room.goalTimer=0;
        const m=MAPS[room.mapKey]||MAPS.classic;
        room.ball={x:m.fw/2,y:m.fh/2,vx:0,vy:0,fire:false,ft:0};
        resetPositions(room.code);
        startGameLoop(room.code);
        io.to(socket.roomCode).emit('gameStart',{mapKey:room.mapKey,goalLimit:room.goalLimit,players:getLobbyData(socket.roomCode).players});
        if(cb)cb({ok:true});
    });

    // INPUT
    socket.on('input',(data)=>{
        const room=rooms[socket.roomCode];if(!room)return;
        const p=room.players[socket.id];if(!p)return;
        p.iDx=data.dx||0;p.iDy=data.dy||0;
        p.iK=data.ik||false;p.iP=data.ip||false;p.iPw=data.ipw||false;
    });

    // CHAT
    socket.on('chat',(data)=>{
        const room=rooms[socket.roomCode];if(!room)return;
        const p=room.players[socket.id];if(!p)return;
        io.to(socket.roomCode).emit('chat',{pid:socket.id,name:p.name,msg:data.msg});
    });

    // EMOJİ
    socket.on('emoji',(data)=>{
        const room=rooms[socket.roomCode];if(!room)return;
        io.to(socket.roomCode).emit('emoji',{pid:socket.id,emoji:data.emoji});
    });

    // ADMIN PANELİ
    socket.on('adminPause',()=>{
        const room=rooms[socket.roomCode];if(!room||room.hostId!==socket.id)return;
        room.match.paused=!room.match.paused;
        io.to(socket.roomCode).emit('paused',room.match.paused);
    });
    socket.on('adminReset',()=>{
        const room=rooms[socket.roomCode];if(!room||room.hostId!==socket.id)return;
        room.match.redScore=0;room.match.blueScore=0;room.match.time=0;
        resetPositions(socket.roomCode);
        io.to(socket.roomCode).emit('adminReset',buildState(socket.roomCode));
    });
    socket.on('adminLobby',()=>{
        const room=rooms[socket.roomCode];if(!room||room.hostId!==socket.id)return;
        room.state='lobby';room.match.running=false;room.match.paused=false;
        stopGameLoop(socket.roomCode);
        io.to(socket.roomCode).emit('backToLobby');
    });
    socket.on('adminChangeMap',(data)=>{
        const room=rooms[socket.roomCode];if(!room||room.hostId!==socket.id)return;
        if(!MAPS[data.mapKey])return;
        room.mapKey=data.mapKey;
        const m=MAPS[data.mapKey];
        room.ball={x:m.fw/2,y:m.fh/2,vx:0,vy:0,fire:false,ft:0};
        resetPositions(socket.roomCode);
        io.to(socket.roomCode).emit('mapChanged',{mapKey:data.mapKey,state:buildState(socket.roomCode)});
    });
    socket.on('adminSetPos',(data)=>{
        const room=rooms[socket.roomCode];if(!room||room.hostId!==socket.id)return;
        const p=room.players[data.pid];if(!p)return;
        p.pos=data.pos;
        if(data.pos){const m=MAPS[room.mapKey]||MAPS.classic;const s=spPos(p.team,data.pos,0,1,m);p.x=s.x;p.y=s.y;p.vx=0;p.vy=0}
    });
    socket.on('adminKick',(data)=>{
        const room=rooms[socket.roomCode];if(!room||room.hostId!==socket.id)return;
        const target=io.sockets.sockets.get(data.pid);
        if(target){target.emit('kicked');target.leave(socket.roomCode)}
        delete room.players[data.pid];
        io.to(socket.roomCode).emit('lobbyUpdate',getLobbyData(socket.roomCode));
    });

    // LOBİYE DÖN (win)
    socket.on('backToLobby',()=>{
        const room=rooms[socket.roomCode];if(!room||room.hostId!==socket.id)return;
        room.state='lobby';room.match.running=false;room.match.paused=false;
        stopGameLoop(socket.roomCode);
        io.to(socket.roomCode).emit('backToLobby');
    });

    // AYRIL
    socket.on('leaveRoom',()=>handleLeave(socket));
    socket.on('disconnect',()=>handleLeave(socket));
});

function handleLeave(socket){
    const code=socket.roomCode;
    if(!code||!rooms[code])return;
    const room=rooms[code];
    delete room.players[socket.id];
    socket.leave(code);
    // Odada kimse kalmadıysa sil
    const online=Object.values(room.players).filter(p=>p.online!==false);
    if(online.length===0){stopGameLoop(code);delete rooms[code];console.log('Oda silindi:',code);return}
    // Host ayrıldıysa yeni host ata
    if(room.hostId===socket.id){
        room.hostId=online[0].id;
        io.to(code).emit('newHost',{hostId:room.hostId});
    }
    io.to(code).emit('lobbyUpdate',getLobbyData(code));
}

function getLobbyData(code){
    const room=rooms[code];if(!room)return null;
    const pOut={};
    for(const[id,p] of Object.entries(room.players)){
        if(p.online===false)continue;
        pOut[id]={name:p.name,team:p.team,pos:p.pos||''};
    }
    return{players:pOut,hostId:room.hostId,mapKey:room.mapKey,goalLimit:room.goalLimit,state:room.state};
}

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('Server port:',PORT));