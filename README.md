# TikTok Analytics Telegram Bot

A Telegram bot that automatically sends scheduled TikTok analytics reports to configured chats.  
It uses **Countik Free Tools** to fetch TikTok insights and supports multiple chat subscriptions with persistent storage.

---

## 🚀 Features

- Fetches TikTok profile analytics automatically
- Sends detailed report messages in Telegram (HTML formatted)
- Supports multiple chats
- Persistent subscriptions via JSON file
- Admin-only management commands
- Automatic scheduler every **24 hours**
- Safe HTML escaping
- Error handling and retry next cycle

---

## 📦 Requirements

- Node.js 16+
- A Telegram Bot Token
- (Optional) Admin Telegram ID

---

## ⚙️ Installation

```bash
git clone https://github.com/NoQuitt-coder/TikTok-Analytics-Telegram-Bot.git
cd TikTok-Analytics-Telegram-Bot
npm install
