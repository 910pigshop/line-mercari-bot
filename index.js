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

  if (!twUrlMatch) {
    return Promise.resolve(null);
  }

  const twUrl = twUrlMatch[0];

  try {
    // 1. 提取 UUID (例如 1c93d92a-8a5a-4e1d-849f-caad4385e5da)
    const uuidMatch = twUrl.match(/items\/([a-zA-Z0-9-]+)/);
    if (!uuidMatch) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 網址格式不正確，找不到商品 UUID。'
      });
    }

    const uuid = uuidMatch[1];
    let mId = null;

    // 2. 直連 Mercari 跨境後端 API 取得真實原廠 ID
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
      console.log('Cross border API retry...');
    }

    // 3. 備用方案：透過第三方 Open Graph 模擬存取
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
