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

// 解析單一台灣 Mercari 網址（精準支援一般商品 + Shops 商店）
async function getJpUrlFromTwUrl(fullUrl) {
  // 1. 清理網址，取出精確的 UUID
  const cleanUrl = fullUrl.split('?')[0];
  const uuidMatch = cleanUrl.match(/items\/([a-zA-Z0-9-]+)/);
  if (!uuidMatch) return null;

  const uuid = uuidMatch[1];
  let resultUrl = null;

  // 2. 策略一：直接打 Mercari 官方 API 查詢 (涵蓋跨境 API 與微服務)
  try {
    const cbApiUrl = `https://api.mercari.jp/cross_border/v1/items/${uuid}`;
    const cbResp = await fetch(cbApiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    if (cbResp.ok) {
      const cbData = await cbResp.json();
      const item = cbData?.item || {};

      // 情況 A：如果是 Shops 商店商品
      if (item.shop_id || item.is_shops || item.product_id || (item.id && !item.id.startsWith('m'))) {
        const productId = item.raw_item_id || item.product_id || item.id;
        if (productId) {
          resultUrl = `https://jp.mercari.com/shops/product/${productId}`;
        }
      } 
      // 情況 B：一般個人賣家商品
      else if (item.id && item.id.startsWith('m')) {
        resultUrl = `https://jp.mercari.com/item/${item.id}`;
      } else if (item.raw_item_id && item.raw_item_id.startsWith('m')) {
        resultUrl = `https://jp.mercari.com/item/${item.raw_item_id}`;
      }
    }
  } catch (e) {
    console.log(`[${uuid}] API strategy 1 failed:`, e.message);
  }

  // 3. 策略二：深度爬取台灣頁面原始碼，挖掘隱藏的 Shops ID 或 m-ID
  if (!resultUrl) {
    try {
      const htmlResp = await fetch(cleanUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'Accept': 'text/html,application/xhtml+xml'
        }
      });

      const html = await htmlResp.text();

      // A. 比對 Shops 商品 ID 格式（常見如 j3gYo6MwpP57Xt562uu4SW，由英數字混雜長度約22位）
      const shopProdMatch = html.match(/"product_id"\s*:\s*"([a-zA-Z0-9]{20,25})"/);
      const shopMetaMatch = html.match(/shops\/product\/([a-zA-Z0-9]{20,25})/);
      const variantMatch = html.match(/"productId"\s*:\s*"([a-zA-Z0-9]{20,25})"/);

      if (shopProdMatch) {
        resultUrl = `https://jp.mercari.com/shops/product/${shopProdMatch[1]}`;
      } else if (shopMetaMatch) {
        resultUrl = `https://jp.mercari.com/shops/product/${shopMetaMatch[1]}`;
      } else if (variantMatch) {
        resultUrl = `https://jp.mercari.com/shops/product/${variantMatch[1]}`;
      }

      // B. 比對一般個人賣家商品的 m-ID
      if (!resultUrl) {
        const itemMatch = html.match(/m\d{10,11}/);
        if (itemMatch) {
          resultUrl = `https://jp.mercari.com/item/${itemMatch[0]}`;
        }
      }
    } catch (e) {
      console.log(`[${uuid}] Strategy 2 failed:`, e.message);
    }
  }

  // 4. 策略三：終極備用（若前面皆找不到，針對 Shops 商家 Hash 的補抓）
  if (!resultUrl) {
    try {
      const shopHashMatch = fullUrl.match(/variant=([a-zA-Z0-9-]+)/);
      if (shopHashMatch) {
        // 如果是商店專屬的引數，嘗試用正則擷取網頁中未格式化的 JSON 物件
        const htmlResp = await fetch(fullUrl, {
          headers: { 'User-Agent': 'facebookexternalhit/1.1' }
        });
        const html = await htmlResp.text();
        const genericHash = html.match(/("id"|"productId"|"rawItemId")\s*:\s*"([a-zA-Z0-9]{22})"/);
        if (genericHash && genericHash[2]) {
          resultUrl = `https://jp.mercari.com/shops/product/${genericHash[2]}`;
        }
      }
    } catch (e) {
      console.log(`[${uuid}] Strategy 3 failed:`, e.message);
    }
  }

  return resultUrl;
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();

  // 抓出訊息中所有台灣 Mercari 網址
  const twUrlMatches = text.match(/https?:\/\/tw\.mercari\.com\/[^\s]+/g);

  if (!twUrlMatches || twUrlMatches.length === 0) {
    return Promise.resolve(null);
  }

  try {
    // 去重複
    const uniqueUrls = Array.from(new Set(twUrlMatches));

    // 並列處理解析
    const results = await Promise.all(
      uniqueUrls.map(async (url) => {
        const jpUrl = await getJpUrlFromTwUrl(url);
        return { url, jpUrl };
      })
    );

    const successJpUrls = results.filter(r => r.jpUrl !== null).map(r => r.jpUrl);

    // 完全找不到時保持沉默
    if (successJpUrls.length === 0) {
      return Promise.resolve(null);
    }

    // 組合回覆
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
