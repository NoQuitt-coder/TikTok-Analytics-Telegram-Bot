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

let subscriptions = loadSubscriptions(); // { [chatId]: { tiktokHandle, lastSentAt } }

// =======================
// Admin check
// =======================

function isAdmin(msg) {
  if (!BOT_ADMIN_ID) return true;
  return String(msg.from.id) === String(BOT_ADMIN_ID);
}

// =======================
// TikTok API Call
// =======================

async function fetchTikTokAnalytics(handleOrUrl) {
  const url = 'https://free-tools.socialinsider.io/api';

  const payload = {
    id: 1,
    method: 'tk_tools.free_tools',
    params: {
      handle: handleOrUrl,
      timezone: 'Europe/Rome',
      tool: 'free_video_analytics',
      auth: {
        dashboardVersion: 1
      }
    }
  };

  const res = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });

  return res.data;
}

// =======================
// Message formatting (HTML)
// =======================

function formatReportMessage(data) {
  const profileName = data.profile_name || data.profile_id || 'Profile';
  const handle = data.profile_id ? `@${data.profile_id}` : '';

  const followers = data.profile_followers?.value ?? 0;
  const er = data.engagement_rate?.float_2f ?? 0;
  const totalViews = data.video_views?.abbr_string_1f ?? data.video_views?.value ?? 0;
  const avgViews = data.average_video_views_per_post?.float_1f ?? 0;
  const avgLikes = data.likes?.float_1f ?? 0;
  const posts = data.posts ?? 0;

  const profileNameEsc = escapeHtml(profileName);
  const handleEsc = escapeHtml(handle);
  const totalViewsEsc = escapeHtml(totalViews);
  const followersEsc = escapeHtml(followers);
  const erEsc = escapeHtml(er);
  const postsEsc = escapeHtml(posts);
  const avgViewsEsc = escapeHtml(avgViews.toFixed ? avgViews.toFixed(1) : avgViews);
  const avgLikesEsc = escapeHtml(avgLikes.toFixed ? avgLikes.toFixed(1) : avgLikes);

  let msg = `📊 <b>TikTok Report</b>\n`;
  msg += `👤 Profile: <b>${profileNameEsc}</b> ${handleEsc}\n\n`;
  msg += `👥 Followers: <b>${followersEsc}</b>\n`;
  msg += `🔥 Engagement rate: <b>${erEsc}%</b>\n`;
  msg += `🎬 Posts analyzed: <b>${postsEsc}</b>\n\n`;
  msg += `👁️‍🗨️ Total views: <b>${totalViewsEsc}</b>\n`;
  msg += `📈 Avg views/video: <b>${avgViewsEsc}</b>\n`;
  msg += `❤️ Avg likes/video: <b>${avgLikesEsc}</b>\n`;

  if (Array.isArray(data.top_posts) && data.top_posts.length > 0) {
    const top = data.top_posts.slice(0, 3);
    msg += `\n🏆 <b>Top Videos</b>\n`;
    top.forEach((p, idx) => {
      const likes = p.like_count ?? p.diggCount ?? 0;
      const likesEsc = escapeHtml(likes);
      const link = p.si_permalink || p.permalink || p.si_picture || '';
      const linkEsc = escapeHtml(link);

      msg += `${idx + 1}) ❤️ ${likesEsc} likes\n`;
      if (link) msg += `${linkEsc}\n`;
    });
  }

  return msg;
}

// =======================
// Send report to chat
// =======================

async function sendReportToChat(chatId, tiktokHandle) {
  try {
    const data = await fetchTikTokAnalytics(tiktokHandle);
    const message = formatReportMessage(data);
    await bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
    subscriptions[chatId].lastSentAt = new Date().toISOString();
    saveSubscriptions(subscriptions);
  } catch (err) {
    console.error(`Error sending report to chat ${chatId}:`, err?.response?.data || err.message);
    await bot.sendMessage(
      chatId,
      '⚠️ Error fetching TikTok data. I will try again on the next cycle.'
    ).catch(() => {});
  }
}

// =======================
// Scheduler every 12 hours
// =======================

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

async function runSchedulerCycle() {
  console.log('Scheduler cycle running', new Date().toISOString());
  const entries = Object.entries(subscriptions);

  for (const [chatId, info] of entries) {
    if (!info.tiktokHandle) continue;
    console.log(`Sending report to chat ${chatId} (${info.tiktokHandle})`);
    await sendReportToChat(chatId, info.tiktokHandle);
    await new Promise(res => setTimeout(res, 1500));
  }
}

runSchedulerCycle();
setInterval(runSchedulerCycle, TWELVE_HOURS_MS);

// =======================
// Telegram Commands
// =======================

bot.onText(/^\/start/, (msg) => {
  const text =
    'Hello! I am the TikTok report bot.\n' +
    'Available commands (admin only):\n' +
    '/add &lt;tiktok_link&gt; &lt;chat_id&gt;\n' +
    '/rem &lt;chat_id&gt;\n' +
    '/list';

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

// /add link chatId
bot.onText(/^\/add(?:@[\w_]+)?\s+(\S+)(?:\s+(-?\d+))?/, (msg, match) => {
  if (!isAdmin(msg)) return;

  const tiktokLink = match[1];
  const chatIdToUse = match[2] ? match[2] : String(msg.chat.id);

  subscriptions[chatIdToUse] = {
    tiktokHandle: tiktokLink,
    lastSentAt: null
  };
  saveSubscriptions(subscriptions);

  const chatIdEsc = escapeHtml(chatIdToUse);
  const linkEsc = escapeHtml(tiktokLink);

  bot.sendMessage(
    msg.chat.id,
    `✅ Added report for chat <b>${chatIdEsc}</b> on profile:\n${linkEsc}`,
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
    const linkEsc = escapeHtml(info.tiktokHandle);
    const lastSentEsc = info.lastSentAt ? escapeHtml(info.lastSentAt) : 'never';

    text += `• Chat ID: <b>${chatIdEsc}</b>\n`;
    text += `  TikTok: ${linkEsc}\n`;
    text += `  Last sent: ${lastSentEsc}\n\n`;
  }

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

console.log('Bot started...');
