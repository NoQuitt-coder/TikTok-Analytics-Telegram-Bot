require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_ADMIN_ID = process.env.BOT_ADMIN_ID;

if (!BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN is missing in .env');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const SUBS_FILE = './subscriptions.json';

// =======================
// Helper: escape HTML
// =======================

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatNumber(n) {
  if (n === null || n === undefined) return '—';
  const num = Number(n);
  if (isNaN(num)) return String(n);
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return num.toLocaleString('it-IT');
}

// =======================
// Storage management
// =======================

function loadSubscriptions() {
  try {
    if (!fs.existsSync(SUBS_FILE)) {
      fs.writeFileSync(SUBS_FILE, JSON.stringify({}, null, 2));
      return {};
    }
    const data = fs.readFileSync(SUBS_FILE, 'utf8');
    return JSON.parse(data || '{}');
  } catch (err) {
    console.error('Error loadSubscriptions:', err);
    return {};
  }
}

function saveSubscriptions(subs) {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
  } catch (err) {
    console.error('Error saveSubscriptions:', err);
  }
}

let subscriptions = loadSubscriptions(); // { [chatId]: { username, lastSentAt } }

// =======================
// Admin check
// =======================

function isAdmin(msg) {
  if (!BOT_ADMIN_ID) return true;
  return String(msg.from.id) === String(BOT_ADMIN_ID);
}

// =======================
// Username extraction
// =======================

function extractTikTokUsername(inputRaw) {
  const input = String(inputRaw || '').trim();
  if (/^@[\w.]+$/.test(input)) return input.slice(1);
  if (/^[\w.]+$/.test(input)) return input;
  const m = input.match(/@([\w.]+)/);
  if (m && m[1]) return m[1];
  return null;
}

// =======================
// Countik API fetch
// =======================

async function fetchTikTokAnalyticsFromCountik(username) {
  const url = `https://countik.com/api/exist/${encodeURIComponent(username)}`;

  const res = await axios.get(url, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      'Referer': `https://countik.com/tiktok-analytics/user/${username}`,
      'Origin': 'https://countik.com',
    },
    timeout: 15000,
    maxRedirects: 5,
  });

  const data = res.data;

  if (data.status !== 'success') {
    const err = new Error(data.message || 'Countik API returned non-success');
    err._debug = { url, status: res.status, response: data };
    throw err;
  }

  return {
    username: data.uniqueId || username,
    nickname: data.nickname || username,
    avatarThumb: data.avatarThumb || null,
    followers: data.followerCount ?? null,
    likes: data.heartCount ?? null,
    videos: data.videoCount ?? null,
    following: data.followingCount ?? null,
    verified: data.verified || false,
    language: data.language || null,
    id: data.id || null,
  };
}

// =======================
// Message formatting (HTML)
// =======================

function formatReportMessage(data) {
  const username = data.username ? `@${data.username}` : '@unknown';
  const usernameEsc = escapeHtml(username);
  const nicknameEsc = escapeHtml(data.nickname || username);

  const followersEsc = escapeHtml(formatNumber(data.followers));
  const likesEsc = escapeHtml(formatNumber(data.likes));
  const videosEsc = escapeHtml(formatNumber(data.videos));
  const followingEsc = escapeHtml(formatNumber(data.following));
  const verifiedBadge = data.verified ? ' ✅' : '';

  let msg = `📊 <b>TikTok Report</b>
`;
  msg += `👤 Profile: <b>${nicknameEsc}${verifiedBadge}</b> (${usernameEsc})

`;
  msg += `👥 Total Followers: <b>${followersEsc}</b>
`;
  msg += `❤️ Total Likes: <b>${likesEsc}</b>
`;
  msg += `🎬 Total Videos: <b>${videosEsc}</b>
`;
  msg += `➕ Following: <b>${followingEsc}</b>
`;

  if (data.language) {
    msg += `🌐 Language: <b>${escapeHtml(data.language.toUpperCase())}</b>
`;
  }

  return msg;
}

// =======================
// Send report to chat
// =======================

async function sendReportToChat(chatId, username) {
  try {
    const data = await fetchTikTokAnalyticsFromCountik(username);
    const message = formatReportMessage(data);

    await bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    subscriptions[chatId].lastSentAt = new Date().toISOString();
    saveSubscriptions(subscriptions);
  } catch (err) {
    console.error(`Error sending report to chat ${chatId}:`, err?.response?.data || err.message, err?._debug || '');
    await bot
      .sendMessage(chatId, '⚠️ Error fetching TikTok data from Countik. I will try again on the next cycle.')
      .catch(() => {});
  }
}

// =======================
// Scheduler every 24 hours
// =======================

const EVERY_24_HOURS_MS = 24 * 60 * 60 * 1000;

async function runSchedulerCycle() {
  console.log('Scheduler cycle running', new Date().toISOString());
  const entries = Object.entries(subscriptions);

  for (const [chatId, info] of entries) {
    if (!info.username) continue;
    console.log(`Sending report to chat ${chatId} (@${info.username})`);
    await sendReportToChat(chatId, info.username);
    await new Promise(res => setTimeout(res, 1500));
  }
}

runSchedulerCycle();
setInterval(runSchedulerCycle, EVERY_24_HOURS_MS);

// =======================
// Telegram Commands
// =======================

bot.onText(/^\/start/, (msg) => {
  const text =
    'Hello! I am the TikTok report bot.\n' +
    'Available commands (admin only):\n' +
    '/add &lt;@username|username|tiktok_url&gt; &lt;chat_id&gt;\n' +
    '/rem &lt;chat_id&gt;\n' +
    '/list';

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

// /add input chatId
bot.onText(/^\/add(?:@[\w_]+)?\s+(\S+)(?:\s+(-?\d+))?/, (msg, match) => {
  if (!isAdmin(msg)) return;

  const input = match[1];
  const chatIdToUse = match[2] ? match[2] : String(msg.chat.id);

  const username = extractTikTokUsername(input);
  if (!username) {
    return bot.sendMessage(msg.chat.id, '❌ Invalid input. Use @username, username or a TikTok/Countik URL.', {
      parse_mode: 'HTML',
    });
  }

  subscriptions[chatIdToUse] = {
    username,
    lastSentAt: null,
  };
  saveSubscriptions(subscriptions);

  const chatIdEsc = escapeHtml(chatIdToUse);
  const usernameEsc = escapeHtml(`@${username}`);

  bot.sendMessage(
    msg.chat.id,
    `✅ Added report for chat <b>${chatIdEsc}</b> on profile: <b>${usernameEsc}</b>`,
    { parse_mode: 'HTML' }
  );
});

// /rem chatId
bot.onText(/^\/rem(?:@[\w_]+)?\s+(-?\d+)/, (msg, match) => {
  if (!isAdmin(msg)) return;

  const chatIdToRemove = match[1];
  if (subscriptions[chatIdToRemove]) {
    delete subscriptions[chatIdToRemove];
    saveSubscriptions(subscriptions);
    bot.sendMessage(
      msg.chat.id,
      `🗑️ Removed chat <b>${escapeHtml(chatIdToRemove)}</b> from reports.`,
      { parse_mode: 'HTML' }
    );
  } else {
    bot.sendMessage(
      msg.chat.id,
      `❓ Chat <b>${escapeHtml(chatIdToRemove)}</b> not found.`,
      { parse_mode: 'HTML' }
    );
  }
});

// /list
bot.onText(/^\/list/, (msg) => {
  if (!isAdmin(msg)) return;

  const entries = Object.entries(subscriptions);
  if (entries.length === 0) {
    return bot.sendMessage(msg.chat.id, '📭 No chat configured.', {
      parse_mode: 'HTML',
    });
  }

  let text = '📋 <b>Configured chats</b>\n\n';
  for (const [chatId, info] of entries) {
    const chatIdEsc = escapeHtml(chatId);
    const userEsc = escapeHtml(info.username ? `@${info.username}` : '—');
    const lastSentEsc = info.lastSentAt ? escapeHtml(info.lastSentAt) : 'never';

    text += `• Chat ID: <b>${chatIdEsc}</b>\n`;
    text += `  TikTok: <b>${userEsc}</b>\n`;
    text += `  Last sent: ${lastSentEsc}\n\n`;
  }

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

console.log('Bot started...');
