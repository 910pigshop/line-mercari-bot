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
    // 啟動瀏覽器並進行高級真人特徵偽裝
    browser = await chromium.launch({ 
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false,
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei',
      extraHTTPHeaders: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'sec-ch-ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1'
      }
    });

    const page = await context.newPage();

    // 隱藏 webdriver 標記，避開 Cloudflare 機器人檢測
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // 只等待 DOM 加載完成即停止，避免媒體資源拉長連線時間
    await page.goto(twUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    
    // 取得網頁原始碼內容
    const content = await page.content();

    // 優先搜尋日本原廠 m-ID (例如 m12345678901)
    const mIdMatch = content.match(/m\d{10,11}/);

    if (mIdMatch) {
      const mId = mIdMatch[0];
      const jpUrl = `https://jp.mercari.com/item/${mId}`;

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `✅ 已成功為您解析日本原廠頁面：\n\n🇯🇵 日本 Mercari 網址：\n${jpUrl}`
      });
    } else {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 無法從該台灣網頁中讀取到日本 m-ID，請確認商品是否已下架或網址是否正確。'
      });
    }
  } catch (error) {
    console.error('爬蟲錯誤詳細:', error.message);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⚠️ 網頁受 Cloudflare 防火牆阻擋或連線逾時。若持續發生，建議直接使用 1 秒轉日本網頁工具喔！'
    });
  } finally {
    if (browser) await browser.close();
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LINE Bot 服務已啟動，Port: ${PORT}`);
});
