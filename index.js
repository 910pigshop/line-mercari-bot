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
    // 提取 UUID (例如 1c93d92a-8a5a-4e1d-849f-caad4385e5da)
    const uuidMatch = twUrl.match(/items\/([a-zA-Z0-9-]+)/);
    
    // 方法一：偽裝成 Googlebot 存取（Cloudflare 通常放行搜尋引擎爬蟲）
    const response = await fetch(twUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-TW,zh;q=0.9'
      }
    });

    const html = await response.text();

    // 正則匹配日本 m-ID
    let mIdMatch = html.match(/m\d{10,11}/);

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
    console.error('解析錯誤:', error.message);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⚠️ 抓取失敗，建議改用 1 秒轉日本網頁工具喔！'
    });
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LINE Bot 服務已啟動，Port: ${PORT}`);
});
