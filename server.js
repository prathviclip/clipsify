const express = require('express');
const axios = require('axios');
const cors = require('cors');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

app.use(express.json({ limit: '10kb' }));
app.use(cors({ origin: true, credentials: true }));

app.use(session({
  name: '__Host-clipsify-sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24
  }
}));

const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many submission attempts. Please try again in an hour.' }
});

const db = {
  campaigns: [
    {
      id: "camp_01",
      title: "Summer Gaming Highlights",
      payout: "$50 per 10k views",
      requiredHashtag: "#ClipsifyGaming",
      requiredTag: "@clipsify_app",
      status: "active"
    }
  ],
  users: {},
  submissions: [],
  submittedVideoIds: new Set()
};

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/auth/discord', (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
  res.redirect(url);
});

app.get('/api/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No auth code provided.');

  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });

    const discordUser = userRes.data;
    const avatarUrl = discordUser.avatar 
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';

    db.users[discordUser.id] = {
      discordId: discordUser.id,
      username: discordUser.username,
      avatar: avatarUrl
    };

    req.session.userId = discordUser.id;
    res.redirect('/');
  } catch (err) {
    res.status(500).send('Discord authentication failed.');
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId || !db.users[req.session.userId]) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, user: db.users[req.session.userId] });
});

app.get('/api/campaigns', (req, res) => {
  res.json({ success: true, campaigns: db.campaigns.filter(c => c.status === 'active') });
});

app.post('/api/generate-code', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Log in with Discord first.' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  db.users[req.session.userId].code = code;
  res.json({ success: true, code });
});

app.post('/api/submit-clip', submissionLimiter, async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized. Login with Discord first.' });
  
  const { campaignId, videoUrl } = req.body;
  const user = db.users[req.session.userId];

  const campaign = db.campaigns.find(c => c.id === campaignId && c.status === 'active');
  if (!campaign) return res.status(404).json({ error: 'Campaign not active or found.' });

  let uniqueId = null;
  if (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be')) {
    const match = videoUrl.match(/(?:shorts\/|v=)([\w-]+)/);
    if (match) uniqueId = `yt_${match[1]}`;
  } else if (videoUrl.includes('tiktok.com')) {
    const match = videoUrl.match(/video\/(\d+)/);
    if (match) uniqueId = `tt_${match[1]}`;
  }

  if (!uniqueId) return res.status(400).json({ error: 'Invalid URL. Must be TikTok or YouTube Short.' });

  if (db.submittedVideoIds.has(uniqueId)) {
    return res.status(409).json({ error: 'FRAUD ALERT: Clip already submitted!' });
  }

  try {
    const endpoint = videoUrl.includes('tiktok.com') 
      ? `https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`
      : `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;

    const metaRes = await axios.get(endpoint, { timeout: 5000 });
    const captionLower = (metaRes.data.title || '').toLowerCase();

    const hasHashtag = captionLower.includes(campaign.requiredHashtag.toLowerCase());
    const hasTag = captionLower.includes(campaign.requiredTag.toLowerCase());

    if (!hasHashtag || !hasTag) {
      return res.status(400).json({ error: `Missing ${campaign.requiredHashtag} or ${campaign.requiredTag} in official video caption.` });
    }

    db.submittedVideoIds.add(uniqueId);

    const submission = {
      id: 'sub_' + crypto.randomBytes(4).toString('hex'),
      discordUsername: user.username,
      campaignTitle: campaign.title,
      videoUrl,
      status: 'pending'
    };

    db.submissions.push(submission);
    res.json({ success: true, message: 'Verified via server metadata! Sent to queue.' });

  } catch (e) {
    res.status(400).json({ error: 'Unable to inspect video caption.' });
  }
});

app.get('/api/admin/submissions', (req, res) => {
  res.json({ submissions: db.submissions });
});

app.post('/api/admin/update-status', (req, res) => {
  const { submissionId, status } = req.body;
  const sub = db.submissions.find(s => s.id === submissionId);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  sub.status = status;
  res.json({ success: true, message: `Updated to ${status}` });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

