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

// 解析單一台灣 Mercari 網址
async function getJpUrlFromTwUrl(fullUrl) {
  // 萃取網址中的 ID
  const variantMatch = fullUrl.match(/variant=([a-zA-Z0-9-]+)/);
  const uuidMatch = fullUrl.match(/items\/([a-zA-Z0-9-]+)/);
  const variantId = variantMatch ? variantMatch[1] : null;
  const itemId = uuidMatch ? uuidMatch[1] : null;

  // 1. 嘗試直接從 API 取得 (同時測試 Item ID 與 Variant ID)
  const idsToTest = [variantId, itemId].filter(Boolean);
  
  for (const id of idsToTest) {
    try {
      const cbResp = await fetch(`https://api.mercari.jp/cross_border/v1/items/${id}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });

      if (cbResp.ok) {
        const cbData = await cbResp.json();
        const item = cbData?.item || cbData || {};
        
        // 判斷是否為 Shops 商店商品
        if (item.product_id || item.raw_product_id) {
          const pId = item.raw_product_id || item.product_id;
          if (pId && !pId.includes('-')) return `https://jp.mercari.com/shops/product/${pId}`;
        }

        // 判斷是否為一般個人商品
        const mId = item.id || item.raw_item_id;
        if (mId && typeof mId === 'string' && mId.startsWith('m')) {
          return `https://jp.mercari.com/item/${mId}`;
        }
      }
    } catch (e) {
      console.log(`[API Error for ${id}]:`, e.message);
    }
  }

  // 2. 終極備用方案 (直接抓取網頁 HTML，暴力撈取資料)
  try {
    const htmlResp = await fetch(fullUrl, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept': 'text/html'
      }
    });
    const html = await htmlResp.text();

    // (A) 找尋一般商品 m-ID
    const mIdMatch = html.match(/m\d{10,11}/);
    if (mIdMatch) return `https://jp.mercari.com/item/${mIdMatch[0]}`;

    // (B) 暴力尋找 Shops 商店 ID (特徵：長度超過 10 且無連字號的英數字)
    const shopRegexes = [
      /"rawProductId":"([a-zA-Z0-9]+)"/g,
      /"productId":"([a-zA-Z0-9]+)"/g,
      /shops\/product\/([a-zA-Z0-9]+)/g,
      /mercari:\/\/shop\/product\/([a-zA-Z0-9]+)/g
    ];

    for (const regex of shopRegexes) {
      // 確保相容性，改用全域 match 取代 matchAll
      let m;
      while ((m = regex.exec(html)) !== null) {
        const id = m[1];
        if (!id.includes('-') && id.length > 10) {
          return `https://jp.mercari.com/shops/product/${id}`;
        }
      }
    }
  } catch (e) {
    console.log(`[Fallback Error]:`, e.message);
  }

  return null;
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
    const uniqueUrls = Array.from(new Set(twUrlMatches));
    
    const results = await Promise.all(
      uniqueUrls.map(async (url) => {
        const jpUrl = await getJpUrlFromTwUrl(url);
        return { url, jpUrl };
      })
    );

    const successJpUrls = results.filter(r => r.jpUrl !== null).map(r => r.jpUrl);

    if (successJpUrls.length === 0) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 轉換失敗：無法從提供的網址中擷取到日本 Mercari 頁面。'
      });
    }

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
