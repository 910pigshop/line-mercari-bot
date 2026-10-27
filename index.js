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

// 解析單一台灣 Mercari 網址（精準比對個人商品 m-ID 與 Shops product_id）
async function getJpUrlFromTwUrl(fullUrl) {
  // 1. 精準提取 UUID (不管是一般商品還是 Shops 商店，都有這串 UUID)
  const uuidMatch = fullUrl.match(/items\/([a-zA-Z0-9-]+)/);
  if (!uuidMatch) return null;

  const uuid = uuidMatch[1];

  try {
    // 2. 打 Mercari 跨境後端 API 取得商品元數據
    const apiUrl = `https://api.mercari.jp/cross_border/v1/items/${uuid}`;
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      const item = data?.item || data || {};

      // 【A 情況】Mercari Shops 商家商品：獲取 product_id / shop_product_id
      const shopProductId = item.product_id || item.shop_product_id || item.raw_product_id;
      if (shopProductId) {
        return `https://jp.mercari.com/shops/product/${shopProductId}`;
      }

      // 【B 情況】一般個人賣家商品：獲取 m-ID
      const mId = item.id || item.raw_item_id;
      if (mId && typeof mId === 'string' && mId.startsWith('m')) {
        return `https://jp.mercari.com/item/${mId}`;
      }

      // 【C 情況】若是 Shops 商品但 id 不是 m 開頭且長度較長 (即為 Shops Hash)
      if (mId && typeof mId === 'string' && !mId.startsWith('m')) {
        return `https://jp.mercari.com/shops/product/${mId}`;
      }
    }
  } catch (e) {
    console.error(`[API Error] UUID: ${uuid}`, e.message);
  }

  // 3. 備用機制：若 API 剛好未回應，透過開放爬蟲標頭直接對台灣頁面提取隱藏欄位
  try {
    const htmlResp = await fetch(`https://tw.mercari.com/zh-hant/items/${uuid}`, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept': 'text/html'
      }
    });
    const html = await htmlResp.text();

    // 先找 Shops Hash
    const shopHashMatch = html.match(/"product_id"\s*:\s*"([a-zA-Z0-9]{20,26})"/);
    if (shopHashMatch) {
      return `https://jp.mercari.com/shops/product/${shopHashMatch[1]}`;
    }

    // 再找一般 m-ID
    const itemMatch = html.match(/m\d{10,11}/);
    if (itemMatch) {
      return `https://jp.mercari.com/item/${itemMatch[0]}`;
    }
  } catch (e) {
    console.error(`[Fallback Error] UUID: ${uuid}`, e.message);
  }

  return null;
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();

  // 抓出訊息中所有台灣 Mercari 網址 (完整網址包含參數)
  const twUrlMatches = text.match(/https?:\/\/tw\.mercari\.com\/[^\s\n]+/g);

  if (!twUrlMatches || twUrlMatches.length === 0) {
    return Promise.resolve(null);
  }

  try {
    // 去重複
    const uniqueUrls = Array.from(new Set(twUrlMatches));

    // 並列處理解析所有網址
    const results = await Promise.all(
      uniqueUrls.map(async (url) => {
        const jpUrl = await getJpUrlFromTwUrl(url);
        return { url, jpUrl };
      })
    );

    const successJpUrls = results.filter(r => r.jpUrl !== null).map(r => r.jpUrl);

    // 解析失敗維持靜音
    if (successJpUrls.length === 0) {
      return Promise.resolve(null);
    }

    // 組合回覆內容
    let replyText = `🤖 此為ROBOT自動通知 🤖 因偵測到非日本MERCARI頁面,已成功為您導入日本頁面 請確認是否與原提供頁面是否為相同商品 如確認為相同商品 請務必回覆【相同】：\n\n`;

    if (successJpUrls.length === 1) {
      replyText += `🇯🇵 日本 Mercari 網址：\n${successJpUrls[0]}`;
    } else {
      replyText += `🇯🇵 日本 Mercari 網址（共 ${successJpUrls.length} 個）：\n` + 
        successJpUrls.map((url, idx) => `${idx + 1}. ${url}`).join('\n\n');
    }

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: replyText
    });

  } catch (error) {
    console.error('處理訊息發生例外錯誤:', error.message);
    return Promise.resolve(null);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LINE Bot 服務已啟動，Port: ${PORT}`);
});
