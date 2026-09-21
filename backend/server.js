import express from 'express';
import http from 'http';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { WebSocketServer } from 'ws';

const { Pool } = pg;
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
const app = express();
app.use(express.json({ limit:'64kb' }));
app.use(express.static('public'));

const sessions = new Map(); // token -> { userId, expires }
const linkCodes = new Map(); // code -> { userId, expires }
const latest = new Map(); // owner userId -> snapshot
const sockets = new Set();

const token = () => crypto.randomBytes(32).toString('hex');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const auth = async (req) => {
  const raw=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const s=sessions.get(raw);
  if (!s || s.expires<Date.now()) return null;
  const { rows }=await pool.query('select id,username from users where id=$1',[s.userId]);
  return rows[0]||null;
};

async function init(){
 await pool.query(`create table if not exists users(id uuid primary key, username text unique not null, password_hash text not null, created_at timestamptz default now());
 create table if not exists devices(id uuid primary key, user_id uuid references users(id) on delete cascade, token_hash text unique not null, minecraft_name text, created_at timestamptz default now(), last_seen timestamptz);
 create table if not exists shares(owner_id uuid references users(id) on delete cascade, viewer_id uuid references users(id) on delete cascade, primary key(owner_id,viewer_id));`);
}

app.post('/api/register', async (req,res)=>{try{const {username,password}=req.body;if(!/^.{3,24}$/.test(username||'')||!/^.{8,128}$/.test(password||''))return res.status(400).json({error:'Username must be 3-24 chars and password at least 8 chars.'});const id=crypto.randomUUID();const ph=await bcrypt.hash(password,12);await pool.query('insert into users(id,username,password_hash) values($1,$2,$3)',[id,username,ph]);res.json({ok:true});}catch(e){res.status(400).json({error:e.code==='23505'?'Username already exists.':'Registration failed.'});}});

app.post('/api/login', async (req,res)=>{try{const {username,password}=req.body;const {rows}=await pool.query('select * from users where username=$1',[username]);if(!rows[0]||!(await bcrypt.compare(password||'',rows[0].password_hash)))return res.status(401).json({error:'Invalid username or password.'});const t=token();sessions.set(t,{userId:rows[0].id,expires:Date.now()+7*86400000});res.json({token:t,username:rows[0].username});}catch(e){res.status(500).json({error:'Login failed.'});}});

app.post('/api/link-code', async (req,res)=>{const u=await auth(req);if(!u)return res.status(401).json({error:'Not logged in.'});const code=String(Math.floor(100000+Math.random()*900000));linkCodes.set(code,{userId:u.id,expires:Date.now()+5*60*1000});res.json({code,expiresIn:300});});

app.post('/api/claim-code', async (req,res)=>{const {code,minecraftName}=req.body;const c=linkCodes.get(String(code));if(!c||c.expires<Date.now()){linkCodes.delete(String(code));return res.status(400).json({error:'Invalid or expired code.'});}linkCodes.delete(String(code));const raw=token();await pool.query('insert into devices(id,user_id,token_hash,minecraft_name,last_seen) values($1,$2,$3,$4,now())',[crypto.randomUUID(),c.userId,hash(raw),minecraftName||'Minecraft']);res.json({deviceToken:raw});});

app.post('/api/radar', async (req,res)=>{try{const raw=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const {rows}=await pool.query('select user_id from devices where token_hash=$1',[hash(raw)]);if(!rows[0])return res.status(401).json({error:'Invalid device token.'});const userId=rows[0].user_id;await pool.query('update devices set last_seen=now() where token_hash=$1',[hash(raw)]);
    const incoming=req.body||{};
    const self=incoming.self||{};
    const snapshot={...incoming,players:Array.isArray(incoming.players)?incoming.players.map(p=>({
      ...p,
      worldX:Number(self.x||0)+Number(p.x||0),
      worldY:Number(self.y||0)+Number(p.y||0),
      worldZ:Number(self.z||0)+Number(p.z||0)
    })):[],receivedAt:Date.now()};
    latest.set(userId,snapshot);broadcast(userId,snapshot);res.json({ok:true});}catch(e){res.status(400).json({error:'Bad radar payload.'});}});

app.post('/api/share', async (req,res)=>{const u=await auth(req);if(!u)return res.status(401).json({error:'Not logged in.'});const {username}=req.body;const {rows}=await pool.query('select id from users where username=$1',[username]);if(!rows[0])return res.status(404).json({error:'User not found.'});await pool.query('insert into shares(owner_id,viewer_id) values($1,$2) on conflict do nothing',[u.id,rows[0].id]);res.json({ok:true});});
app.delete('/api/share', async (req,res)=>{const u=await auth(req);if(!u)return res.status(401).json({error:'Not logged in.'});const {username}=req.body;await pool.query('delete from shares where owner_id=$1 and viewer_id=(select id from users where username=$2)',[u.id,username]);res.json({ok:true});});
app.get('/api/targets', async (req,res)=>{const u=await auth(req);if(!u)return res.status(401).json({error:'Not logged in.'});const {rows}=await pool.query(`select u.username, u.id, case when u.id=$1 then true else false end as mine from users u where u.id=$1 or u.id in (select owner_id from shares where viewer_id=$1) order by mine desc,u.username`,[u.id]);res.json(rows.map(x=>({id:x.id,username:x.username,mine:x.mine,snapshot:latest.get(x.id)||null})));});

function broadcast(ownerId,snapshot){for(const ws of sockets){if(ws.readyState!==1)continue; if(ws.targets?.has(ownerId))ws.send(JSON.stringify({type:'radar',ownerId,snapshot}));}}

const server=http.createServer(app);const wss=new WebSocketServer({server,path:'/ws'});
wss.on('connection',(ws,req)=>{sockets.add(ws);const u=new URL(req.url,'http://localhost');const t=u.searchParams.get('token');const s=sessions.get(t);if(!s){ws.close(1008,'Unauthorized');return;}ws.targets=new Set([s.userId]);pool.query('select owner_id from shares where viewer_id=$1',[s.userId]).then(r=>r.rows.forEach(x=>ws.targets.add(x.owner_id)));ws.on('close',()=>sockets.delete(ws));});
setInterval(()=>{for(const ws of sockets)if(ws.readyState===1)ws.ping();},25000);

init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log(`Player Radar Cloud listening on ${PORT}`))).catch(e=>{console.error(e);process.exit(1);});
