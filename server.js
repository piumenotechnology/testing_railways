// npm i express google-auth-library googleapis jsonwebtoken
const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(express.json());

const GOOGLE_WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID;       // same as Flutter serverClientId
const GOOGLE_WEB_CLIENT_SECRET = process.env.GOOGLE_WEB_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;

// redirect must be "postmessage" for mobile code exchange
const oauth2 = new OAuth2Client(GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET, 'postmessage');
// const oauth2 = new OAuth2Client(GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET, 'https://developers.google.com/oauthplayground');

// fake DB, replace with your DB
const tokenStore = new Map(); // key: userId, value: { access_token, refresh_token, expiry_date, scope, id, email }

app.get('/', (req, res) => res.send('Hello World'));

app.post('/auth/google/playground', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).send('Missing code');

  const client = new OAuth2Client(GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
  const { tokens } = await client.getToken({ code }); // works with Playground codes
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: WEB_ID });
  const payload = ticket.getPayload();
  res.json({ email: payload.email, scope: tokens.scope, hasRefresh: !!tokens.refresh_token });
});


app.post('/auth/google', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).send('Missing code');

    // Exchange serverAuthCode for tokens
    const { tokens } = await oauth2.getToken({ code }); // redirect_uri is already set to 'postmessage'
    // tokens will include id_token, access_token, refresh_token (maybe), scope, expiry_date

    // Verify the ID token to get user identity, also confirms audience
    const ticket = await oauth2.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_WEB_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const userId = payload.sub;
    const email = payload.email;

    // Persist tokens server side
    const existing = tokenStore.get(userId) || {};
    tokenStore.set(userId, {
      ...existing,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || existing.refresh_token, // keep old one if new is missing
      expiry_date: tokens.expiry_date, // ms since epoch
      scope: tokens.scope,
      email,
    });

    // Issue your own app session
    const appJwt = jwt.sign({ uid: userId, email }, JWT_SECRET, { expiresIn: '7d' });

    console.log(tokenStore);

    res.json({ token: appJwt });
  } catch (err) {
    console.error(err);
    res.status(401).send('Google auth failed');
  }
});

// helper, returns an authenticated google client for a user, auto refreshes if needed
async function getGoogleClientFor(userId) {
  const rec = tokenStore.get(userId);
  if (!rec) throw new Error('No Google tokens stored for user');

  const client = new OAuth2Client(GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET, 'postmessage');
  client.setCredentials({
    access_token: rec.access_token,
    refresh_token: rec.refresh_token, // may be undefined if user never granted offline access
    expiry_date: rec.expiry_date,
  });

  // Check expiry, refresh if needed
  const now = Date.now();
  if (!rec.expiry_date || rec.expiry_date <= now) {
    // getAccessToken triggers refresh if refresh_token is set
    const at = await client.getAccessToken();
    if (!at || !at.token) throw new Error('Failed to refresh Google access token');
    // google-auth-library updates client.credentials, copy back to store
    const creds = client.credentials;
    tokenStore.set(userId, {
      ...rec,
      access_token: creds.access_token,
      expiry_date: creds.expiry_date,
      // refresh_token may only appear on the first exchange, keep existing one
    });
  }
  return client;
}

app.get('/google/drive/files', async (req, res) => {
  try {
    // replace with your auth, for demo assume uid query param
    const userId = req.query.uid;
    const client = await getGoogleClientFor(userId);

    const drive = google.drive({ version: 'v3', auth: client });
    const resp = await drive.files.list({
      pageSize: 10,
      fields: 'files(id, name, mimeType, modifiedTime)',
    });
    res.json(resp.data);
  } catch (e) {
    console.error(e);
    res.status(401).send('Drive access failed');
  }
});

app.get('/google/calendar/events', async (req, res) => {
  try {
    const userId = req.query.uid;
    const client = await getGoogleClientFor(userId);

    const calendar = google.calendar({ version: 'v3', auth: client });
    const resp = await calendar.events.list({
      calendarId: 'primary',
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime',
      timeMin: new Date().toISOString(),
    });
    res.json(resp.data);
  } catch (e) {
    console.error(e);
    res.status(401).send('Calendar access failed');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
