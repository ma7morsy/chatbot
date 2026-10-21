require('dotenv').config();
const express = require('express'), helmet = require('helmet'), cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const multer = require('multer'), crypto = require('crypto'), path = require('path');
const { db, encrypt } = require('./db');
const { indexDoc, removeDoc, removeBotChunks, answer } = require('./agent');

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 24) { console.error('Set JWT_SECRET (24+ random chars) in .env'); process.exit(1); }
const PROD = process.env.NODE_ENV === 'production';

const app = express();
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.use(helmet({
  frameguard: false,
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameAncestors: ["'self'"] } }
}));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

/* ---------- helpers ---------- */
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const publicBot = b => ({ id: b.id, slug: b.slug, name: b.name, welcome: b.welcome, instructions: b.instructions,
  provider: b.provider, base_url: b.base_url, model: b.model, has_key: !!b.api_key_enc, active: !!b.active });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function auth(req, res, next) {
  try { req.user = jwt.verify(req.cookies.token, SECRET); next(); }
  catch { res.status(401).json({ error: 'Please sign in.' }); }
}
function ownBot(req, res, next) {
  const b = db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(req.params.id, req.user.uid);
  if (!b) return res.status(404).json({ error: 'Agent not found.' });
  req.bot = b; next();
}
function setSession(res, user) {
  const t = jwt.sign({ uid: user.id, email: user.email }, SECRET, { expiresIn: '7d' });
  res.cookie('token', t, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 7 * 864e5 });
}

/* ---------- auth ---------- */
const authLimit = rateLimit({ windowMs: 15 * 60e3, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' } });
const canRegister = () => db.prepare('SELECT COUNT(*) n FROM users').get().n === 0 || process.env.ALLOW_REGISTRATION === 'true';

app.get('/api/auth/status', (req, res) => res.json({ registration: canRegister() }));
app.post('/api/auth/register', authLimit, wrap(async (req, res) => {
  if (!canRegister()) return res.status(403).json({ error: 'Registration is closed.' });
  const email = str(req.body.email, 200).toLowerCase(), pw = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'Email already registered.' });
  const id = db.prepare('INSERT INTO users(email,password_hash) VALUES(?,?)').run(email, await bcrypt.hash(pw, 12)).lastInsertRowid;
  setSession(res, { id, email }); res.json({ email });
}));
app.post('/api/auth/login', authLimit, wrap(async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash)))
    return res.status(401).json({ error: 'Wrong email or password.' });
  setSession(res, u); res.json({ email: u.email });
}));
app.post('/api/auth/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
app.get('/api/auth/me', auth, (req, res) => res.json({ email: req.user.email }));

/* ---------- agents (admin) ---------- */
app.get('/api/bots', auth, (req, res) =>
  res.json(db.prepare('SELECT * FROM bots WHERE user_id=? ORDER BY id DESC').all(req.user.uid).map(publicBot)));
app.post('/api/bots', auth, (req, res) => {
  const name = str(req.body.name, 80) || 'New agent';
  const id = db.prepare('INSERT INTO bots(user_id,slug,name) VALUES(?,?,?)').run(req.user.uid, crypto.randomBytes(6).toString('hex'), name).lastInsertRowid;
  res.json(publicBot(db.prepare('SELECT * FROM bots WHERE id=?').get(id)));
});
app.put('/api/bots/:id', auth, ownBot, (req, res) => {
  const b = req.body, cur = req.bot;
  const provider = ['openai', 'anthropic', 'gemini'].includes(b.provider) ? b.provider : cur.provider;
  const base = str(b.base_url, 300) || cur.base_url;
  if (provider === 'openai' && !/^https?:\/\//.test(base)) return res.status(400).json({ error: 'Base URL must start with http:// or https://' });
  const key = str(b.api_key, 500);
  db.prepare(`UPDATE bots SET name=?,welcome=?,instructions=?,provider=?,base_url=?,model=?,api_key_enc=?,active=? WHERE id=?`)
    .run(str(b.name, 80) || cur.name, b.welcome === undefined ? cur.welcome : str(b.welcome, 300), b.instructions === undefined ? cur.instructions : str(b.instructions, 3000), provider, base,
      str(b.model, 100) || cur.model, key ? encrypt(key) : cur.api_key_enc, b.active === undefined ? cur.active : (b.active === false ? 0 : 1), cur.id);
  res.json(publicBot(db.prepare('SELECT * FROM bots WHERE id=?').get(cur.id)));
});
app.delete('/api/bots/:id', auth, ownBot, (req, res) => {
  removeBotChunks(req.bot.id); db.prepare('DELETE FROM bots WHERE id=?').run(req.bot.id); res.json({ ok: true });
});

/* ---------- documents ---------- */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 10 } });
async function extract(buf, name) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'pdf') return (await require('pdf-parse/lib/pdf-parse.js')(buf)).text;
  if (ext === 'docx') return (await require('mammoth').extractRawText({ buffer: buf })).value;
  if (['txt', 'md', 'csv', 'json'].includes(ext)) return buf.toString('utf8');
  if (['html', 'htm'].includes(ext)) return buf.toString('utf8').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  throw new Error('Unsupported file type');
}
app.get('/api/bots/:id/documents', auth, ownBot, (req, res) =>
  res.json(db.prepare('SELECT id,name,chars,created_at FROM documents WHERE bot_id=? ORDER BY id DESC').all(req.bot.id)));
app.post('/api/bots/:id/documents', auth, ownBot, upload.array('files', 10), wrap(async (req, res) => {
  const out = [];
  for (const f of req.files || []) {
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
    try {
      const text = (await extract(f.buffer, name)).replace(/[ \t]+/g, ' ').trim();
      if (!text) { out.push({ name, error: 'No readable text (scanned PDFs need OCR).' }); continue; }
      indexDoc(req.bot.id, name, text); out.push({ name, ok: true });
    } catch (e) { out.push({ name, error: e.message === 'Unsupported file type' ? e.message : 'Could not read this file.' }); }
  }
  res.json(out);
}));
app.delete('/api/documents/:id', auth, (req, res) => {
  const d = db.prepare('SELECT d.id FROM documents d JOIN bots b ON b.id=d.bot_id WHERE d.id=? AND b.user_id=?').get(req.params.id, req.user.uid);
  if (!d) return res.status(404).json({ error: 'Document not found.' });
  removeDoc(d.id); res.json({ ok: true });
});

/* ---------- conversations (admin) ---------- */
app.get('/api/bots/:id/conversations', auth, ownBot, (req, res) => res.json(db.prepare(`
  SELECT c.id, c.created_at, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) n,
         (SELECT content FROM messages m WHERE m.conversation_id=c.id AND m.role='user' ORDER BY m.id LIMIT 1) first
  FROM conversations c WHERE c.bot_id=? ORDER BY c.id DESC LIMIT 100`).all(req.bot.id)));
app.get('/api/conversations/:id/messages', auth, (req, res) => {
  const ok = db.prepare('SELECT 1 FROM conversations c JOIN bots b ON b.id=c.bot_id WHERE c.id=? AND b.user_id=?').get(req.params.id, req.user.uid);
  if (!ok) return res.status(404).json({ error: 'Not found.' });
  res.json(db.prepare('SELECT role,content,sources,created_at FROM messages WHERE conversation_id=? ORDER BY id').all(req.params.id));
});

/* ---------- public customer API ---------- */
const chatLimit = rateLimit({ windowMs: 60e3, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'You are sending messages too fast. Please wait a moment.' } });
const liveBot = slug => db.prepare('SELECT * FROM bots WHERE slug=? AND active=1').get(slug);
app.get('/api/public/:slug', (req, res) => {
  const b = liveBot(req.params.slug);
  if (!b) return res.status(404).json({ error: 'This assistant is not available.' });
  res.json({ name: b.name, welcome: b.welcome });
});
app.post('/api/public/:slug/chat', chatLimit, wrap(async (req, res) => {
  const bot = liveBot(req.params.slug);
  if (!bot) return res.status(404).json({ error: 'This assistant is not available.' });
  const message = str(req.body.message, 2000), session = str(req.body.session, 64);
  if (!message || !/^[\w-]{8,64}$/.test(session)) return res.status(400).json({ error: 'Invalid request.' });
  let conv = db.prepare('SELECT id FROM conversations WHERE bot_id=? AND session=?').get(bot.id, session);
  if (!conv) conv = { id: db.prepare('INSERT INTO conversations(bot_id,session) VALUES(?,?)').run(bot.id, session).lastInsertRowid };
  const history = db.prepare('SELECT role,content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 8').all(conv.id).reverse();
  try {
    const { text, sources } = await answer(bot, history, message);
    const ins = db.prepare('INSERT INTO messages(conversation_id,role,content,sources) VALUES(?,?,?,?)');
    ins.run(conv.id, 'user', message, null); ins.run(conv.id, 'assistant', text, sources.join(', ') || null);
    res.json({ reply: text });
  } catch (e) {
    console.error(`[bot ${bot.id}] model error:`, e.message);
    res.status(502).json({ error: 'The assistant is unavailable right now. Please try again shortly.' });
  }
}));

/* ---------- pages ---------- */
const PUB = path.join(__dirname, 'public');
app.get('/c/:slug', (req, res) => { 
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors *");
  res.sendFile(path.join(PUB, 'chat.html')); });
app.get('/admin', (req, res) => { res.set('X-Frame-Options', 'DENY'); res.sendFile(path.join(PUB, 'admin.html')); });
app.get('/', (req, res) => res.redirect('/admin'));
app.use(express.static(PUB, { index: false }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  console.error(err); res.status(500).json({ error: 'Something went wrong.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Doc Chatbot running on http://localhost:${port}`));
