require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEB_ID = process.env.GOOGLE_WEB_CLIENT_ID;
const WEB_SECRET = process.env.GOOGLE_WEB_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;

if (!WEB_ID || !WEB_SECRET || !JWT_SECRET) {
  throw new Error('Missing env, set GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET, JWT_SECRET');
}
if (!WEB_ID.endsWith('.apps.googleusercontent.com')) {
  throw new Error('GOOGLE_WEB_CLIENT_ID is not a Web client ID');
}

const tokenStore = Object.create(null);

function mobileClient() {
  return new OAuth2Client(WEB_ID, WEB_SECRET, 'postmessage');
}

/*
  App JWT helpers
*/
function signAppJwt({ uid, email }) {
  return jwt.sign({ uid, email }, JWT_SECRET, { expiresIn: '7d' });
}
function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid session' });
  }
}

/*
  Exchange auth code from Flutter, verify ID token, store Google tokens,
  return your own app session
*/
app.post('/auth/google', async (req, res) => {
  try {
    const code = req.body?.code;
    if (!code) return res.status(400).json({ error: 'Missing code' });

    console.log('WEB_ID:', WEB_ID);
    console.log('Using redirect:', 'postmessage'); // you hardcode it in OAuth2Client
    console.log('incoming code len:', (req.body?.code || '').length);

    const oauth = mobileClient();
    const { tokens } = await oauth.getToken({ code }); // id_token, access_token, refresh_token?, expiry_date, scope

    // Verify identity
    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: WEB_ID });
    const payload = ticket.getPayload(); // sub, email, name, picture
    const uid = payload.sub;

    // Persist tokens
    const prev = tokenStore[uid] || {};
    tokenStore[uid] = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || prev.refresh_token, // keep old if new is missing
      expiry_date: tokens.expiry_date,
      scope: tokens.scope,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    };

    // Issue your app session
    const appJwt = signAppJwt({ uid, email: payload.email });

    res.json({
      token: appJwt,
      profile: { uid, email: payload.email, name: payload.name, picture: payload.picture },
      granted_scopes: tokens.scope?.split(' ') || [],
      has_refresh_token: Boolean(tokens.refresh_token || prev.refresh_token),
    });
  } catch (e) {
    const err = e.response?.data || { message: e.message };
    console.error('OAuth exchange failed:', err);
    res.status(400).json({ error: 'OAuth exchange failed', detail: err });
  }
});

/*
  Helper, get an authenticated Google client for a user, auto refresh access token
*/
async function getGoogleClientFor(uid) {
  const rec = tokenStore[uid];
  if (!rec) throw new Error('No Google tokens for user');

  const client = mobileClient();
  client.setCredentials({
    access_token: rec.access_token,
    refresh_token: rec.refresh_token,
    expiry_date: rec.expiry_date,
  });

  const now = Date.now();
  // Refresh if missing or expired
  if (!rec.expiry_date || rec.expiry_date <= now - 5000) {
    const at = await client.getAccessToken(); // triggers refresh when refresh_token is set
    if (!at || !at.token) {
      throw new Error('Failed to refresh access token, user may need to re link');
    }
    const creds = client.credentials;
    tokenStore[uid] = {
      ...rec,
      access_token: creds.access_token,
      expiry_date: creds.expiry_date,
    };
  }

  return client;
}

/*
  Example protected endpoint that uses only your app session
*/
app.get('/me', authMiddleware, (req, res) => {
  const rec = tokenStore[req.user.uid];
  res.json({
    uid: req.user.uid,
    email: rec?.email,
    name: rec?.name,
    picture: rec?.picture,
    granted_scopes: rec?.scope?.split(' ') || [],
  });
});

/*
  Example Google API call, Drive file list
  Requires that user granted drive.readonly or stronger
*/
app.get('/google/drive/files', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const client = await getGoogleClientFor(uid);
    const drive = google.drive({ version: 'v3', auth: client });
    const r = await drive.files.list({
      pageSize: 10,
      fields: 'files(id,name,mimeType,modifiedTime)',
    });
    res.json(r.data);
  } catch (e) {
    const err = e.response?.data || { message: e.message };
    res.status(400).json({ error: 'Drive call failed', detail: err });
  }
});

/*
  Example Google API call, Calendar next events
  Requires calendar.readonly or stronger
*/
app.get('/google/calendar/events', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const client = await getGoogleClientFor(uid);
    const calendar = google.calendar({ version: 'v3', auth: client });
    const r = await calendar.events.list({
      calendarId: 'primary',
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime',
      timeMin: new Date().toISOString(),
    });
    res.json(r.data);
  } catch (e) {
    const err = e.response?.data || { message: e.message };
    res.status(400).json({ error: 'Calendar call failed', detail: err });
  }
});

/*
  Unlink, forget tokens server side
*/
app.post('/auth/google/unlink', authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  delete tokenStore[uid];
  res.json({ ok: true });
});

/*
  Health and debug
*/
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/debug/store', (req, res) => res.json(tokenStore)); // remove in production

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
  console.log('WEB_ID:', WEB_ID);
});
