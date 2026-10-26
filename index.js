const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');

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

  // 沒找到台灣煤爐網址，保持沉默
  if (!twUrlMatch) {
    return Promise.resolve(null);
  }

  const twUrl = twUrlMatch[0];

  try {
    const uuidMatch = twUrl.match(/items\/([a-zA-Z0-9-]+)/);
    // 提取 UUID 失敗，保持沉默
    if (!uuidMatch) {
      return Promise.resolve(null);
    }

    const uuid = uuidMatch[1];
    let mId = null;

    // 1. 直連 Mercari 跨境後端 API 取得真實原廠 ID
    const cbApiUrl = `https://api.mercari.jp/cross_border/v1/items/${uuid}`;
    
    try {
      const cbResp = await fetch(cbApiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });

      if (cbResp.ok) {
        const cbData = await cbResp.json();
        if (cbData?.item?.id) {
          mId = cbData.item.id;
        } else if (cbData?.raw_item_id) {
          mId = cbData.raw_item_id;
        }
      }
    } catch (e) {
      console.log('Cross border API error, trying fallback...');
    }

    // 2. 備用解析方案
    if (!mId) {
      const fallbackUrl = `https://tw.mercari.com/zh-hant/items/${uuid}`;
      const htmlResp = await fetch(fallbackUrl, {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html'
        }
      });
      
      const html = await htmlResp.text();
      const match = html.match(/m\d{10,11}/);
      if (match) mId = match[0];
    }

    // 3. 只有成功拿到 m-ID 才發送回覆訊息
    if (mId) {
      const jpUrl = `https://jp.mercari.com/item/${mId}`;
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `🤖 此為ROBOT自動通知🤖 因偵測到非日本MERCARI頁面,已成功為您導入日本頁面 請確認是否與原提供頁面是否為相同商品 如確認為相同商品 請務必回覆【相同】：\n\n🇯🇵 日本 Mercari 網址：\n${jpUrl}`
      });
    }

    // 讀取不到 m-ID，保持沉默
    return Promise.resolve(null);

  } catch (error) {
    console.error('解析錯誤:', error.message);
    // 發生系統異常，保持沉默
    return Promise.resolve(null);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LINE Bot 服務已啟動，Port: ${PORT}`);
});
