const express = require('express');
const line = require('@line/bot-sdk');

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

  try {
    // 1. 從網址提取商品的 UUID
    const uuidMatch = twUrl.match(/items\/([a-zA-Z0-9-]+)/);
    
    if (!uuidMatch) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 網址格式不正確，找不到台灣煤爐的商品 UUID。'
      });
    }

    const uuid = uuidMatch[1];

    // 2. 直接請求台灣煤爐的內部 Data API，繞過網頁渲染與 Cloudflare 阻擋
    const apiUrl = `https://tw.mercari.com/_next/data/latest/zh-hant/items/${uuid}.json`;

    let response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': twUrl
      }
    });

    // 如果 Next.js data API 無法取得，備用方案：請求 HTML 頁面並尋找 script JSON 區塊
    let mId = null;

    if (response.ok) {
      const data = await response.json();
      const jsonStr = JSON.stringify(data);
      const mIdMatch = jsonStr.match(/m\d{10,11}/);
      if (mIdMatch) mId = mIdMatch[0];
    }

    // 備用解析：若 JSON 接口未順利回應，直接 fetch HTML 解析 __NEXT_DATA__
    if (!mId) {
      const htmlResp = await fetch(twUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'Accept': 'text/html'
        }
      });
      const html = await htmlResp.text();
      
      // 在內嵌的 __NEXT_DATA__ 腳本中搜尋 m-ID
      const mIdMatch = html.match(/m\d{10,11}/);
      if (mIdMatch) mId = mIdMatch[0];
    }

    if (mId) {
      const jpUrl = `https://jp.mercari.com/item/${mId}`;

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `✅ 已成功為您解析日本原廠頁面：\n\n🇯🇵 日本 Mercari 網址：\n${jpUrl}`
      });
    } else {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 無法從該商品頁面中讀取到日本 m-ID，請確認商品是否已下架。'
      });
    }
  } catch (error) {
    console.error('解析錯誤:', error.message);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⚠️ 解析失敗，請確認網址是否正確或稍後再試！'
    });
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LINE Bot 服務已啟動，Port: ${PORT}`);
});
