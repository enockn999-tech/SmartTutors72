/** SmartTutors72: dependency-free Node 24 server. See README before deployment. */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, chmod, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const deriveKey = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
const stamp = () => new Date().toISOString();
const token = () => randomBytes(32).toString('hex');
const DAY = 86400000;
const MAX_FILE = 10 * 1024 * 1024;
const EMAIL = 'smarttutors72@gmail.com';
const STATES = ['awaiting_quote', 'awaiting_payment', 'received', 'in_progress', 'ready_for_review', 'revision_requested', 'completed', 'cancelled'];
const DEFAULTS = {
  wordsPerPage: null,
  revisionPolicy: '',
  policiesPublished: false,
  policies: {privacy:'', terms:'', refunds:'', revisions:''},
  services: [
    {id:'editing', name:'Proofreading & editing', unit:'page', rate:1000, description:'Give your writing a clear, confident finish.'},
    {id:'academic', name:'Academic writing support', unit:'page', rate:1000, description:'Editing, research guidance, and citation support for your own work.'},
    {id:'content', name:'Content & copywriting', unit:'page', rate:1000, description:'Articles, website copy, and brand stories with a purpose.'},
    {id:'business', name:'Business writing', unit:'project', rate:null, description:'Presentations, proposals, and documents built around your goals.'},
    {id:'career', name:'CVs & cover letters', unit:'project', rate:null, description:'Put your experience into words that feel like you.'},
    {id:'coaching', name:'Tutoring & writing coaching', unit:'session', rate:null, description:'Personalized guidance to help you grow as a writer.'}
  ]
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function assert(condition, message, status=400) { if (!condition) throw new HttpError(status, message); }
function clean(value, max=500, required=true) {
  assert(typeof value === 'string', 'Please provide valid text.');
  const result = value.trim();
  assert(result.length <= max && (!required || result.length > 0), `Please enter ${required?'1–':''}${max} characters.`);
  return result;
}
function email(value) {
  const result = clean(value,254).toLowerCase();
  assert(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(result), 'Enter a valid email address.');
  return result;
}
function safeEqual(a,b) {
  const left=Buffer.from(String(a||'')), right=Buffer.from(String(b||''));
  return left.length === right.length && timingSafeEqual(left,right);
}
async function passwordHash(password) {
  const salt = token();
  return `${salt}:${Buffer.from(await deriveKey(password,salt,64)).toString('hex')}`;
}
async function verifyPassword(password, saved) {
  const [salt,key] = saved.split(':');
  return safeEqual(Buffer.from(await deriveKey(password,salt,64)).toString('hex'),key);
}
function validPassword(value) {
  assert(typeof value === 'string' && value.length >= 12 && value.length <= 128, 'Use a password of 12–128 characters.');
  return value;
}
async function body(req, max=256000) {
  assert(!req.headers['content-length'] || Number(req.headers['content-length']) <= max, 'This file or request is too large.',413);
  let size=0; const chunks=[];
  for await (const chunk of req) { size+=chunk.length; assert(size<=max,'This file or request is too large.',413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function jsonBody(req) {
  assert((req.headers['content-type']||'').startsWith('application/json'),'Send this request as JSON.',415);
  try { const value = JSON.parse((await body(req)).toString()); assert(value && typeof value==='object' && !Array.isArray(value),'Invalid request.'); return value; }
  catch(error) { if(error instanceof HttpError) throw error; throw new HttpError(400,'Invalid JSON.'); }
}
function send(res, code, payload) {
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(payload));
}
function publicUser(user) { return user ? {id:user.id,name:user.name,email:user.email,role:user.role}:null; }

export async function createApplication(options={}) {
  const env = options.env || process.env;
  const remoteFetch = options.fetch || fetch;
  const dataDir = path.resolve(options.dataDir || env.DATA_DIR || path.join(ROOT,'data'));
  const origin = (env.APP_ORIGIN || 'http://localhost:3000').replace(/\/$/,'');
  const originURL = new URL(origin);
  const production = env.NODE_ENV === 'production';
  assert(!production || originURL.protocol==='https:','Production APP_ORIGIN must use HTTPS.');
  await mkdir(path.join(dataDir,'uploads'), {recursive:true,mode:0o700});
  const db = new DatabaseSync(path.join(dataDir,'smarttutors72.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'customer',created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),service TEXT NOT NULL,title TEXT NOT NULL,quantity INTEGER NOT NULL,details TEXT NOT NULL,estimate_cents INTEGER,quoted_cents INTEGER,quote_version INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'awaiting_quote',payment_status TEXT NOT NULL DEFAULT 'unpaid',stripe_session TEXT,stripe_url TEXT,stripe_expires INTEGER,created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),user_id TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,size INTEGER NOT NULL,kind TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT NOT NULL REFERENCES orders(id),label TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_events(id TEXT PRIMARY KEY,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reset_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS inquiries(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,subject TEXT NOT NULL,message TEXT NOT NULL,created TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS files_order ON files(order_id);
    CREATE INDEX IF NOT EXISTS messages_order ON messages(order_id);`);
  db.prepare('INSERT OR IGNORE INTO settings(id,value) VALUES (1,?)').run(JSON.stringify(DEFAULTS));
  await chmod(path.join(dataDir,'smarttutors72.sqlite'),0o600);
  const settings = () => JSON.parse(db.prepare('SELECT value FROM settings WHERE id=1').get().value);
  const paymentConfigured = () => Boolean(env.PAYMENTS_ENABLED==='true' && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
  const mailConfigured = () => Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
  const limitBuckets = new Map();
  function rateLimit(key, limit=20, window=15*60000) {
    const now=Date.now();
    if(limitBuckets.size>20000) for(const [k,v] of limitBuckets) if(v.until<now) limitBuckets.delete(k);
    let item=limitBuckets.get(key);
    if(!item || item.until<now) {item={count:0,until:now+window};limitBuckets.set(key,item);}
    assert(++item.count<=limit,'Too many requests. Please try again later.',429);
  }
  const ip = req => env.TRUST_PROXY==='true' ? String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',')[0].trim() : req.socket.remoteAddress;
  function cookie(res,value) {
    res.setHeader('Set-Cookie', `st72=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value?7*86400:0}${production?'; Secure':''}`);
  }
  function getSession(req) {
    const match=(req.headers.cookie||'').match(/(?:^|;\s*)st72=([a-f0-9]{64})(?:;|$)/);
    if(!match) return null;
    const row=db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(hash(match[1]),Date.now());
    if(!row) return null;
    return {...row,user:row.user_id?db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id):null};
  }
  function newSession(res,userId=null) {
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    const raw=token(), csrf=token();
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hash(raw),userId,csrf,Date.now()+7*DAY);
    cookie(res,raw);
    return {id:hash(raw),user_id:userId,csrf,user:userId?db.prepare('SELECT * FROM users WHERE id=?').get(userId):null};
  }
  function requireUser(session, admin=false) {
    assert(session?.user,'Please log in to continue.',401);
    assert(!admin || session.user.role==='admin','Administrator access required.',403);
    return session.user;
  }
  function orderAccess(id,user) {
    const order=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    assert(order && (order.user_id===user.id || user.role==='admin'),'Order not found.',404);
    return order;
  }
  function event(id,label) { db.prepare('INSERT INTO events(order_id,label,created) VALUES (?,?,?)').run(id,label,stamp()); }
  function orderPublic(order) {
    const {stripe_session,stripe_url,stripe_expires,...publicFields}=order;
    return {...publicFields,details:JSON.parse(order.details)};
  }
  async function mail(to,subject,text) {
    if(!mailConfigured()) return false;
    const response=await remoteFetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.EMAIL_FROM,to:[to],reply_to:EMAIL,subject,text}),signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new HttpError(502,'The email service is unavailable. Please try again later.');
    return true;
  }
  function notify(to,subject,text) { mail(to,subject,text).catch(()=>console.error('A notification email could not be delivered. The record remains available in the dashboard.')); }
  async function stripe(parameters,idempotencyKey) {
    const response=await remoteFetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':idempotencyKey},body:new URLSearchParams(parameters),signal:AbortSignal.timeout(20000)});
    const result=await response.json();
    assert(response.ok && result.url && result.id,'Checkout is temporarily unavailable. Please try again.',502);
    return result;
  }
  async function webhook(req,res) {
    assert(env.STRIPE_WEBHOOK_SECRET,'Webhook not configured.',503);
    const raw=await body(req,1000000);
    const entries=(req.headers['stripe-signature']||'').split(',').map(v=>v.split('='));
    const t=entries.find(([key])=>key==='t')?.[1];
    assert(/^\d+$/.test(t||'') && Math.abs(Date.now()/1000-Number(t))<=300,'Invalid webhook timestamp.',400);
    const expected=createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(`${t}.`).update(raw).digest('hex');
    assert(entries.some(([key,value])=>key==='v1' && safeEqual(value,expected)),'Invalid webhook signature.',400);
    let payload; try{payload=JSON.parse(raw.toString());}catch{throw new HttpError(400,'Invalid webhook payload.');}
    if(db.prepare('SELECT id FROM payment_events WHERE id=?').get(String(payload.id))) return send(res,200,{received:true});
    const checkout=payload.data?.object;
    if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(payload.type) && checkout?.payment_status==='paid') {
      const order=db.prepare('SELECT * FROM orders WHERE id=?').get(String(checkout.metadata?.order_id||''));
      assert(order && order.stripe_session===checkout.id && checkout.currency==='usd' && checkout.amount_total===order.quoted_cents && String(order.quote_version)===checkout.metadata?.quote_version,'Payment does not match this order.',400);
      db.exec('BEGIN IMMEDIATE');
      try {
        if(order.payment_status!=='paid') {
          db.prepare("UPDATE orders SET payment_status='paid',status='received',updated=? WHERE id=?").run(stamp(),order.id);
          event(order.id,'Payment received. Your project is ready to begin.');
        }
        db.prepare('INSERT INTO payment_events VALUES (?,?)').run(String(payload.id),stamp());db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
    }
    send(res,200,{received:true});
  }

  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if(production) res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const url=new URL(req.url,'http://internal');
      const route=url.pathname;
      const method=req.method;
      if(route==='/api/stripe/webhook' && method==='POST') return await webhook(req,res);
      if(route.startsWith('/api/')) {
        rateLimit(`api:${ip(req)}`,400,60000);
        let session=getSession(req);
        if(!['GET','HEAD'].includes(method)) {
          assert(req.headers.origin===origin,'Request origin is not allowed.',403);
          assert(session && safeEqual(req.headers['x-csrf-token'],session.csrf),'Session expired. Refresh the page and try again.',403);
        }
        if(route==='/api/session' && method==='GET') {
          session ||= newSession(res);
          return send(res,200,{user:publicUser(session.user),csrf:session.csrf});
        }
        if(route==='/api/config' && method==='GET') {
          const s=settings();
          return send(res,200,{...s,paymentsAvailable:paymentConfigured(),passwordResetAvailable:mailConfigured(),email:EMAIL,currency:'USD'});
        }
        if(route==='/api/auth/register' && method==='POST') {
          rateLimit(`register:${ip(req)}`,8);
          const data=await jsonBody(req), name=clean(data.name,100), address=email(data.email), password=validPassword(data.password);
          assert(!db.prepare('SELECT id FROM users WHERE email=?').get(address),'An account already uses that email. Please log in or reset your password.',409);
          const id=randomUUID(), saved=await passwordHash(password);
          db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id,name,address,saved,'customer',stamp());
          db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
          session=newSession(res,id);
          return send(res,201,{user:publicUser(session.user),csrf:session.csrf});
        }
        if(route==='/api/auth/login' && method==='POST') {
          const data=await jsonBody(req), address=email(data.email);
          rateLimit(`login-ip:${ip(req)}`,30);rateLimit(`login-email:${address}`,12);
          assert(typeof data.password==='string' && data.password.length<=128,'Invalid email or password.',401);
          const user=db.prepare('SELECT * FROM users WHERE email=?').get(address);
          // An equivalent derivation also runs for unknown accounts.
          const stored=user?.password || `00000000000000000000000000000000:${'0'.repeat(128)}`;
          const correct=await verifyPassword(data.password,stored);
          assert(user && correct,'Invalid email or password.',401);
          db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
          session=newSession(res,user.id);
          return send(res,200,{user:publicUser(user),csrf:session.csrf});
        }
        if(route==='/api/auth/logout' && method==='POST') {
          db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);cookie(res,'');return send(res,200,{ok:true});
        }
        if(route==='/api/auth/forgot' && method==='POST') {
          rateLimit(`reset:${ip(req)}`,5);
          assert(mailConfigured(),`Password-reset email is not enabled yet. Contact ${EMAIL} for help.`,503);
          const address=email((await jsonBody(req)).email), user=db.prepare('SELECT * FROM users WHERE email=?').get(address);
          if(user) {
            const raw=token();
            db.prepare('DELETE FROM reset_tokens WHERE user_id=? OR expires<?').run(user.id,Date.now());
            db.prepare('INSERT INTO reset_tokens VALUES (?,?,?)').run(hash(raw),user.id,Date.now()+30*60000);
            await mail(address,'Reset your SmartTutors72 password',`Use this link within 30 minutes: ${origin}/reset-password#${raw}\nIf you did not request this, ignore this email.`);
          }
          return send(res,200,{message:'If an account exists, a password-reset link has been sent.'});
        }
        if(route==='/api/auth/reset' && method==='POST') {
          rateLimit(`reset-complete:${ip(req)}`,10);
          const data=await jsonBody(req), raw=clean(data.token,64), password=validPassword(data.password);
          const record=db.prepare('SELECT * FROM reset_tokens WHERE id=? AND expires>?').get(hash(raw),Date.now());
          assert(record,'This reset link is invalid or expired.');
          const saved=await passwordHash(password);
          db.exec('BEGIN IMMEDIATE');
          try {
            const consumed=db.prepare('DELETE FROM reset_tokens WHERE id=? AND expires>?').run(hash(raw),Date.now());
            assert(consumed.changes===1,'This reset link has already been used.');
            db.prepare('UPDATE users SET password=? WHERE id=?').run(saved,record.user_id);
            db.prepare('DELETE FROM sessions WHERE user_id=?').run(record.user_id);db.exec('COMMIT');
          }catch(error){db.exec('ROLLBACK');throw error;}
          return send(res,200,{message:'Password updated. You can now log in.'});
        }
        if(route==='/api/contact' && method==='POST') {
          rateLimit(`contact:${ip(req)}`,5);
          const data=await jsonBody(req);
          assert(!data.website,'Unable to submit this message.');
          const name=clean(data.name,100),address=email(data.email),subject=clean(data.subject,200),message=clean(data.message,5000),id=randomUUID();
          db.prepare('INSERT INTO inquiries VALUES (?,?,?,?,?,?)').run(id,name,address,subject,message,stamp());
          notify(EMAIL,`New SmartTutors72 inquiry: ${subject}`,`${name} <${address}>\n\n${message}`);
          return send(res,201,{message:'Your message has been received. We will reply to the email you provided.'});
        }
        if(route==='/api/estimate' && method==='POST') {
          const data=await jsonBody(req),s=settings(),service=s.services.find(x=>x.id===data.service),quantity=Number(data.quantity);
          assert(service && Number.isInteger(quantity) && quantity>=1 && quantity<=500,'Choose a service and a quantity from 1 to 500.');
          return send(res,200,{estimate_cents:service.rate===null?null:service.rate*quantity,currency:'USD',unit:service.unit,wordsPerPage:s.wordsPerPage});
        }
        if(route==='/api/orders' && method==='GET') {
          const user=requireUser(session);
          return send(res,200,{orders:db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created DESC').all(user.id).map(orderPublic)});
        }
        if(route==='/api/orders' && method==='POST') {
          const user=requireUser(session);rateLimit(`orders:${user.id}`,20,3600000);
          const data=await jsonBody(req),s=settings(),service=s.services.find(x=>x.id===data.service),quantity=Number(data.quantity);
          assert(service && Number.isInteger(quantity) && quantity>=1 && quantity<=500,'Choose a valid service and quantity.');
          const title=clean(data.title,200),instructions=clean(data.instructions,10000);
          assert(!data.deadline || (Number.isFinite(Date.parse(data.deadline)) && Date.parse(data.deadline)>Date.now()),'Choose a future deadline.');
          const timezone=clean(data.timezone||'UTC',100);
          try{new Intl.DateTimeFormat('en',{timeZone:timezone});}catch{throw new HttpError(400,'Choose a valid time zone.');}
          const details={instructions,deadline:data.deadline||null,timezone,subject:clean(data.subject||'',200,false),level:clean(data.level||'',100,false),citation:clean(data.citation||'',80,false),language:data.language==='UK English'?'UK English':'US English',unit:service.unit,rate:service.rate,wordsPerPage:s.wordsPerPage};
          const id=`ST72-${randomBytes(5).toString('hex').toUpperCase()}`,now=stamp();
          db.prepare('INSERT INTO orders(id,user_id,service,title,quantity,details,estimate_cents,created,updated) VALUES (?,?,?,?,?,?,?,?,?)').run(id,user.id,service.id,title,quantity,JSON.stringify(details),service.rate===null?null:service.rate*quantity,now,now);
          event(id,'Project brief received. Awaiting a confirmed quote.');
          notify(EMAIL,`New project ${id}`,`${user.name} submitted a ${service.name} request. Review it in your administrator dashboard: ${origin}/admin`);
          return send(res,201,{order:orderPublic(db.prepare('SELECT * FROM orders WHERE id=?').get(id))});
        }
        const orderMatch=route.match(/^\/api\/orders\/([A-Z0-9-]+)(?:\/(messages|files|revision|complete|checkout|receipt))?$/);
        if(orderMatch) {
          const user=requireUser(session), order=orderAccess(orderMatch[1],user), action=orderMatch[2];
          if(!action && method==='GET') return send(res,200,{order:orderPublic(order),messages:db.prepare('SELECT messages.*,users.name,users.role FROM messages JOIN users ON users.id=messages.user_id WHERE order_id=? ORDER BY created').all(order.id),files:db.prepare('SELECT id,name,size,kind,created FROM files WHERE order_id=? ORDER BY created').all(order.id),events:db.prepare('SELECT label,created FROM events WHERE order_id=? ORDER BY id').all(order.id)});
          if(action==='messages' && method==='POST') {
            rateLimit(`message:${user.id}`,60,3600000);
            const message=clean((await jsonBody(req)).message,5000);
            db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(randomUUID(),order.id,user.id,message,stamp());
            return send(res,201,{ok:true});
          }
          if(action==='files' && method==='POST') {
            const original=decodeURIComponent(String(req.headers['x-file-name']||''));
            const name=path.basename(original).replace(/[\r\n\x00-\x1f]/g,'').slice(0,180);
            const ext=path.extname(name).toLowerCase();
            assert(['.pdf','.docx','.txt','.md','.pptx','.xlsx','.png','.jpg','.jpeg','.webp'].includes(ext),'Supported files: PDF, DOCX, TXT, MD, PPTX, XLSX, PNG, JPG, and WEBP.');
            const kind=req.headers['x-file-kind']==='deliverable'?'deliverable':'brief';
            assert(kind==='brief'||user.role==='admin','Only your project team can upload deliverables.',403);
            const totals=db.prepare('SELECT count(*) AS count, coalesce(sum(size),0) AS total FROM files WHERE order_id=?').get(order.id);
            const bytes=await body(req,MAX_FILE);
            assert(bytes.length>0 && totals.count<20 && totals.total+bytes.length<=50*1024*1024,'An order can hold 20 files totaling up to 50 MB.');
            if(ext==='.pdf') assert(bytes.subarray(0,5).toString()==='%PDF-','The file does not appear to be a PDF.');
            if(['.docx','.xlsx','.pptx'].includes(ext)) assert(bytes[0]===80 && bytes[1]===75,'The file does not appear to be an Office document.');
            if(['.txt','.md'].includes(ext)) assert(!bytes.includes(0),'Please upload a text document.');
            if(ext==='.png') assert(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Invalid PNG file.');
            if(['.jpg','.jpeg'].includes(ext)) assert(bytes[0]===255 && bytes[1]===216 && bytes[2]===255,'Invalid JPEG file.');
            if(ext==='.webp') assert(bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP','Invalid WebP file.');
            const id=randomUUID(),filePath=path.join(dataDir,'uploads',id);
            await writeFile(filePath,bytes,{mode:0o600,flag:'wx'});
            try{db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?)').run(id,order.id,user.id,name,bytes.length,kind,stamp());}
            catch(error){await unlink(filePath);throw error;}
            return send(res,201,{id,name});
          }
          if(action==='revision' && method==='POST') {
            assert(['ready_for_review','completed'].includes(order.status),'A revision can be requested after delivery.');
            const message=clean((await jsonBody(req)).message,5000);
            db.exec('BEGIN IMMEDIATE');
            try {
              db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(randomUUID(),order.id,user.id,`Revision request: ${message}`,stamp());
              db.prepare("UPDATE orders SET status='revision_requested',updated=? WHERE id=?").run(stamp(),order.id);
              event(order.id,'A revision has been requested for review by the project team.');db.exec('COMMIT');
            }catch(error){db.exec('ROLLBACK');throw error;}
            return send(res,200,{ok:true});
          }
          if(action==='complete' && method==='POST') {
            assert(order.status==='ready_for_review','This project is not ready for acceptance.');
            db.prepare("UPDATE orders SET status='completed',updated=? WHERE id=?").run(stamp(),order.id);event(order.id,'Deliverables accepted. Project completed.');return send(res,200,{ok:true});
          }
          if(action==='checkout' && method==='POST') {
            const s=settings();
            const accepted = await jsonBody(req);
            assert(accepted.acceptTerms===true,'Please accept the project terms before paying.');
            assert(paymentConfigured(),'Online payment is not enabled yet. Please contact us about your quote.',503);
            assert(s.policiesPublished,'Payment will open when the business terms are available.',409);
            assert(order.status==='awaiting_payment' && order.payment_status!=='paid' && order.quoted_cents>0,'This order needs a confirmed unpaid quote.',409);
            const details=JSON.parse(order.details);
            assert(details.unit!=='page'||details.wordsPerPage>0,'The page-length definition must be confirmed before payment.',409);
            if(order.stripe_session && order.stripe_url && order.stripe_expires>Date.now()/1000) return send(res,200,{url:order.stripe_url});
            const expiry=order.stripe_expires>Date.now()/1000+60?order.stripe_expires:Math.floor(Date.now()/1000)+1860;
            details.acceptedTerms={acceptedAt:stamp(),policies:s.policies};
            db.prepare('UPDATE orders SET stripe_expires=?,details=? WHERE id=?').run(expiry,JSON.stringify(details),order.id);
            const owner=db.prepare('SELECT email FROM users WHERE id=?').get(order.user_id);
            const checkout=await stripe({mode:'payment','payment_method_types[0]':'card',customer_email:owner.email,client_reference_id:order.id,'metadata[order_id]':order.id,'metadata[quote_version]':String(order.quote_version),'line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(order.quoted_cents),'line_items[0][price_data][product_data][name]':`${order.id}: ${order.title}`,'line_items[0][quantity]':'1',success_url:`${origin}/dashboard/${order.id}?payment=processing`,cancel_url:`${origin}/dashboard/${order.id}?payment=cancelled`,expires_at:String(expiry)},`${order.id}-${order.quote_version}-${expiry}`);
            db.prepare('UPDATE orders SET stripe_session=?,stripe_url=?,stripe_expires=? WHERE id=?').run(checkout.id,checkout.url,checkout.expires_at,order.id);
            return send(res,200,{url:checkout.url});
          }
          if(action==='receipt' && method==='GET') {
            assert(order.payment_status==='paid','A receipt is available after verified payment.',409);
            const text=`SMARTTUTORS72 — PAYMENT RECEIPT\n\nOrder: ${order.id}\nProject: ${order.title}\nAmount paid: USD ${(order.quoted_cents/100).toFixed(2)}\nStatus: Paid\nPayment reference: ${order.stripe_session}\nContact: ${EMAIL}\n\nThis is a payment receipt, not a tax invoice.\n`;
            res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="${order.id}-receipt.txt"`,'Cache-Control':'no-store'});return res.end(text);
          }
        }
        const fileMatch=route.match(/^\/api\/files\/([a-f0-9-]+)$/);
        if(fileMatch && method==='GET') {
          const user=requireUser(session),file=db.prepare('SELECT * FROM files WHERE id=?').get(fileMatch[1]);
          assert(file,'File not found.',404);orderAccess(file.order_id,user);
          const bytes=await readFile(path.join(dataDir,'uploads',file.id));
          res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="document${path.extname(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Cache-Control':'private, no-store'});return res.end(bytes);
        }
        if(route==='/api/admin' && method==='GET') {
          requireUser(session,true);
          return send(res,200,{orders:db.prepare('SELECT orders.*,users.name AS customer_name,users.email AS customer_email FROM orders JOIN users ON users.id=orders.user_id ORDER BY orders.created DESC').all().map(orderPublic),customers:db.prepare('SELECT id,name,email,role,created FROM users ORDER BY created DESC').all(),inquiries:db.prepare('SELECT * FROM inquiries ORDER BY created DESC').all(),settings:settings(),integrations:{payments:paymentConfigured(),email:mailConfigured()}});
        }
        if(route==='/api/admin/settings' && method==='PUT') {
          requireUser(session,true);const data=await jsonBody(req),previous=settings();
          const wpp=data.wordsPerPage===null||data.wordsPerPage===''?null:Number(data.wordsPerPage);
          assert(wpp===null || (Number.isInteger(wpp)&&wpp>=100&&wpp<=1000),'Set words per page between 100 and 1,000.');
          assert(Array.isArray(data.services)&&data.services.length===previous.services.length,'Invalid services.');
          const services=previous.services.map(service=>{
            const submitted=data.services.find(x=>x.id===service.id);assert(submitted,'A service is missing.');
            const rate=submitted.rate===null?null:Number(submitted.rate);assert(rate===null||(Number.isInteger(rate)&&rate>=100&&rate<=1000000),'Rates must be valid amounts in cents.');
            return {...service,rate,description:clean(submitted.description??service.description,500),name:clean(submitted.name??service.name,100)};
          });
          const policies={};for(const key of ['privacy','terms','refunds','revisions']) policies[key]=clean(data.policies?.[key]||'',20000,false);
          const published=data.policiesPublished===true;
          assert(!published || Object.values(policies).every(x=>x.length>=40),'Complete all four policies before publishing them.');
          db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify({...previous,wordsPerPage:wpp,services,policies,policiesPublished:published,revisionPolicy:policies.revisions}));
          return send(res,200,{ok:true});
        }
        const adminOrder=route.match(/^\/api\/admin\/orders\/([A-Z0-9-]+)$/);
        if(adminOrder && method==='PATCH') {
          const user=requireUser(session,true),order=orderAccess(adminOrder[1],user),data=await jsonBody(req),s=settings();
          const details=JSON.parse(order.details);
          if(data.quoted_cents!==undefined) {
            const amount=Number(data.quoted_cents);
            assert(Number.isInteger(amount)&&amount>=100&&amount<=100000000,'Enter a valid quote of at least $1.');
            assert(order.payment_status!=='paid','A paid quote cannot be changed.',409);
            assert(!order.stripe_session&&!order.stripe_expires,'Checkout has already started for this quote. This starter locks its amount to prevent stale payments. Contact the customer before creating a replacement order.',409);
            assert(details.unit!=='page'||s.wordsPerPage>0,'Set the words-per-page definition in Settings first.');
            details.wordsPerPage=s.wordsPerPage;
            db.prepare("UPDATE orders SET quoted_cents=?,quote_version=quote_version+1,status='awaiting_payment',details=?,updated=? WHERE id=?").run(amount,JSON.stringify(details),stamp(),order.id);
            event(order.id,`Quote confirmed: USD ${(amount/100).toFixed(2)}${details.unit==='page'?` (${details.wordsPerPage} words per page)`:''}.`);
          } else if(data.status) {
            assert(STATES.includes(data.status),'Invalid order status.');
            assert(['received','in_progress','ready_for_review','completed','cancelled'].includes(data.status),'Use the quote or revision workflow for that status.');
            assert(data.status==='cancelled'||order.payment_status==='paid','Payment must be verified before work progresses.');
            assert(data.status!=='cancelled'||!order.stripe_session,'Resolve the payment session or refund in Stripe before cancellation.',409);
            if(['ready_for_review','completed'].includes(data.status)) assert(db.prepare("SELECT id FROM files WHERE order_id=? AND kind='deliverable'").get(order.id),'Upload a deliverable before marking the work ready.');
            db.prepare('UPDATE orders SET status=?,updated=? WHERE id=?').run(data.status,stamp(),order.id);event(order.id,`Project status: ${data.status.replaceAll('_',' ')}.`);
          }else throw new HttpError(400,'Provide a quote or status update.');
          return send(res,200,{ok:true});
        }
        throw new HttpError(404,'This endpoint was not found.');
      }
      assert(method==='GET'||method==='HEAD','Method not allowed.',405);
      if(route==='/sitemap.xml') {
        const pages=['/','/services','/pricing','/how-it-works','/about','/contact','/faq',...settings().services.map(s=>`/services/${s.id}`)];
        res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8'});
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(p=>`<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>`);
      }
      const assets={'/app.js':'application/javascript; charset=utf-8','/styles.css':'text/css; charset=utf-8','/favicon.svg':'image/svg+xml','/robots.txt':'text/plain; charset=utf-8'};
      const filename=assets[route]?path.join(ROOT,'public',route.slice(1)):path.join(ROOT,'public','index.html');
      assert(assets[route] || /^\/(?:|services(?:\/[a-z-]+)?|pricing|how-it-works|about|contact|faq|order|account|dashboard(?:\/[A-Z0-9-]+)?|admin|policy\/(?:privacy|terms|refunds|revisions)|reset-password)$/.test(route),'Page not found.',404);
      const bytes=await readFile(filename);
      res.writeHead(200,{'Content-Type':assets[route]||'text/html; charset=utf-8','Cache-Control':assets[route]?'public, max-age=300':'no-cache'});
      res.end(method==='HEAD'?undefined:bytes);
    } catch(error) {
      if(res.headersSent) {res.end();return;}
      const code=error instanceof HttpError?error.status:500;
      if(code===500) console.error('Request failed:',error.name);
      send(res,code,{error:code===500?'Something went wrong. Please try again.':error.message});
    }
  });
  server.requestTimeout=30000;server.headersTimeout=15000;
  server.on('clientError',(_error,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  return {server,db,dataDir,settings,async createAdmin(name,address,password){
    const saved=await passwordHash(validPassword(password));
    const normalized=email(address),existing=db.prepare('SELECT id FROM users WHERE email=?').get(normalized);
    if(existing){db.prepare("UPDATE users SET name=?,password=?,role='admin' WHERE id=?").run(clean(name,100),saved,existing.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(existing.id);}
    else db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(randomUUID(),clean(name,100),normalized,saved,'admin',stamp());
  }};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const envPath=path.join(ROOT,'.env');if(existsSync(envPath)) process.loadEnvFile(envPath);
  const app=await createApplication();
  if(process.argv[2]==='create-admin') {
    let muted=false;
    const output=new Writable({write(chunk,_encoding,callback){if(!muted) process.stdout.write(chunk);callback();}});
    const rl=createInterface({input:process.stdin,output,terminal:process.stdin.isTTY});
    const address=await rl.question(`Admin email [${EMAIL}]: `);
    process.stdout.write('Admin password (12+ characters; hidden): ');muted=true;
    const password=await rl.question('');muted=false;process.stdout.write('\n');rl.close();
    await app.createAdmin('SmartTutors72 Admin',address||EMAIL,password);console.log('Administrator account ready. Sign in through /account.');app.db.close();
  } else {
    const argValue=name=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined;};
    const port=Number(argValue('--port')||process.env.PORT||3000),host=argValue('--host')||process.env.HOST||'127.0.0.1';
    app.server.listen(port,host,()=>console.log(`SmartTutors72 listening on ${host}:${port}`));
    const close=()=>app.server.close(()=>{app.db.close();process.exit(0);});process.on('SIGINT',close);process.on('SIGTERM',close);
  }
}
