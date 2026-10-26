const express = require('express');
const line = require('@line/bot-sdk');
const { chromium } = require('playwright');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();
  const twUrlMatch = text.match(/https?:\/\/tw\.mercari\.com\/[^\s]+/);

  if (!twUrlMatch) {
    return Promise.resolve(null);
  }

  const twUrl = twUrlMatch[0];

  let browser;
  try {
    // 針對 Render 雲端環境優化的輕量化無頭瀏覽器設定
    browser = await chromium.launch({ 
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    await page.goto(twUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const content = await page.content();

    const mIdMatch = content.match(/m\d{10,11}/);

    if (mIdMatch) {
      const mId = mIdMatch[0];
      const jpUrl = `https://jp.mercari.com/item/${mId}`;

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `✅ 已為您解析日本原廠頁面：\n\n🇯🇵 日本 Mercari 網址：\n${jpUrl}`
      });
    } else {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 無法從該台灣網頁中讀取到日本 m-ID，請確認網址是否正確。'
      });
    }
  } catch (error) {
    console.error('爬蟲錯誤:', error);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⚠️ 網頁抓取逾時或受到防爬蟲阻擋，請稍後再試。'
    });
  } finally {
    if (browser) await browser.close();
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LINE Bot 服務已啟動，Port: ${PORT}`);
});
