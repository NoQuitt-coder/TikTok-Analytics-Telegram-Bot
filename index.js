require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const cheerio = require('cheerio');

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

function buildCountikUrl(username) {
  return `https://countik.com/tiktok-analytics/user/@${encodeURIComponent(username)}`;
}

// =======================
// Countik scrape + parse
// =======================

function normalizeNumberString(s) {
  if (s == null) return null;
  let t = String(s).trim();
  t = t.replace(/\s+/g, '').replace(/,/g, '').replace(/\./g, '');
  if (/^\d+$/.test(t)) return t;
  return String(s).trim(); 
}

function normalizePercentString(s) {
  if (s == null) return null;
  let t = String(s).trim();
  t = t.replace(/\s+/g, '');
  if (!t.endsWith('%') && /^\d+(\.\d+)?$/.test(t)) t += '%';
  return t;
}

function parseCountikHtml(html) {
  const $ = cheerio.load(html);

  const stats = {
    followers: null,
    likes: null,
    videos: null,
    following: null,
    overallEngagement: null
  };

  $('.item.four.user-stats .block').each((_, el) => {
    const label = $(el).find('h3').first().text().trim().toLowerCase();
    const value = $(el).find('p').first().text().trim();

    if (label.includes('total followers')) stats.followers = normalizeNumberString(value);
    else if (label.includes('total likes')) stats.likes = normalizeNumberString(value);
    else if (label.includes('total videos')) stats.videos = normalizeNumberString(value);
    else if (label === 'following' || label.includes('following')) stats.following = normalizeNumberString(value);
  });

  $('.item.four.total-engagement-rates .block').each((_, el) => {
    const h3 = $(el).find('h3').first().text().trim().toLowerCase();
    if (h3 === 'overall engagement') {
      const pText = $(el).find('p').first().text().trim();
      const percentMatch = pText.match(/(\d+(?:\.\d+)?)\s*%/);
      stats.overallEngagement = normalizePercentString(percentMatch ? `${percentMatch[1]}%` : pText);
    }
  });

  const title = $('title').text().trim();
  stats.pageTitle = title || null;

  return stats;
}

async function fetchTikTokAnalyticsFromCountik(username) {
  const url = buildCountikUrl(username);

  const res = await axios.get(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://countik.com/'
    },
    timeout: 20000,
    maxRedirects: 5
  });

  const html = res.data;
  const parsed = parseCountikHtml(html);

  const hasAny =
    parsed.followers !== null ||
    parsed.likes !== null ||
    parsed.videos !== null ||
    parsed.following !== null ||
    parsed.overallEngagement !== null;

  if (!hasAny) {
    const hint = `Parse returned empty stats (maybe blocked or DOM changed).`;
    const err = new Error(hint);
    err._debug = { url, status: res.status };
    throw err;
  }

  return { username, url, ...parsed };
}

// =======================
// Message formatting (HTML)
// =======================

function formatReportMessageCountik(data) {
  const username = data.username ? `@${data.username}` : '@unknown';
  const usernameEsc = escapeHtml(username);
  const urlEsc = escapeHtml(data.url || '');

  const followersEsc = escapeHtml(data.followers ?? '—');
  const likesEsc = escapeHtml(data.likes ?? '—');
  const videosEsc = escapeHtml(data.videos ?? '—');
  const followingEsc = escapeHtml(data.following ?? '—');
  const overallEngEsc = escapeHtml(data.overallEngagement ?? '—');

  let msg = `📊 <b>TikTok Report</b>\n`;
  msg += `👤 Profile: <b>${usernameEsc}</b>\n\n`;
  msg += `👥 Total Followers: <b>${followersEsc}</b>\n`;
  msg += `❤️ Total Likes: <b>${likesEsc}</b>\n`;
  msg += `🎬 Total Videos: <b>${videosEsc}</b>\n`;
  msg += `➕ Following: <b>${followingEsc}</b>\n\n`;
  msg += `🔥 Overall Engagement: <b>${overallEngEsc}</b>\n`;

  return msg;
}

// =======================
// Send report to chat
// =======================

async function sendReportToChat(chatId, username) {
  try {
    const data = await fetchTikTokAnalyticsFromCountik(username);
    const message = formatReportMessageCountik(data);

    await bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
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
      parse_mode: 'HTML'
    });
  }

  subscriptions[chatIdToUse] = {
    username,
    lastSentAt: null
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
      parse_mode: 'HTML'
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
