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

// 單一 UUID 轉日本網址的解析邏輯（支援個人商品 + Shops 商店商品）
async function getJpUrlFromTwUuid(uuid) {
  let resultUrl = null;

  // 1. 直連 Mercari 跨境 API 解析 (支援 Shops 與 一般商品)
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
      
      // 判斷是否為 Shops 商店商品
      if (cbData?.item?.shop_id || cbData?.item?.is_shops || cbData?.item?.id?.length > 15) {
        const productId = cbData?.item?.raw_item_id || cbData?.item?.id || cbData?.item?.product_id;
        if (productId) {
          resultUrl = `https://jp.mercari.com/shops/product/${productId}`;
        }
      } 
      // 一般個人賣家商品
      else if (cbData?.item?.id) {
        resultUrl = `https://jp.mercari.com/item/${cbData.item.id}`;
      } else if (cbData?.raw_item_id) {
        resultUrl = `https://jp.mercari.com/item/${cbData.raw_item_id}`;
      }
    }
  } catch (e) {
    console.log(`[${uuid}] Cross border API error, trying fallback...`);
  }

  // 2. 備用方案：解析 HTML 頁面（加入 Shops URL 匹配）
  if (!resultUrl) {
    try {
      const fallbackUrl = `https://tw.mercari.com/zh-hant/items/${uuid}`;
      const htmlResp = await fetch(fallbackUrl, {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html'
        }
      });
      const html = await htmlResp.text();

      // 先匹配 Shops 商店 ID (例如 /shops/product/j3gYo6MwpP57Xt562uu4SW)
      const shopMatch = html.match(/shops\/product\/([a-zA-Z0-9]+)/);
      if (shopMatch) {
        resultUrl = `https://jp.mercari.com/shops/product/${shopMatch[1]}`;
      } else {
        // 匹配一般個人商品 m-ID (例如 m12345678901)
        const itemMatch = html.match(/m\d{10,11}/);
        if (itemMatch) {
          resultUrl = `https://jp.mercari.com/item/${itemMatch[0]}`;
        }
      }
    } catch (e) {
      console.log(`[${uuid}] Fallback error`);
    }
  }

  return resultUrl;
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();

  // 抓出訊息中「所有」台灣 Mercari 網址
  const twUrlMatches = text.match(/https?:\/\/tw\.mercari\.com\/[^\s]+/g);

  if (!twUrlMatches || twUrlMatches.length === 0) {
    return Promise.resolve(null);
  }

  try {
    // 提取所有 UUID 並去重
    const uuidMap = new Map();
    for (const url of twUrlMatches) {
      const match = url.match(/items\/([a-zA-Z0-9-]+)/);
      if (match && !uuidMap.has(match[1])) {
        uuidMap.set(match[1], url);
      }
    }

    if (uuidMap.size === 0) {
      return Promise.resolve(null);
    }

    // 並列處理多網址解析
    const uuids = Array.from(uuidMap.keys());
    const results = await Promise.all(
      uuids.map(async (uuid) => {
        const jpUrl = await getJpUrlFromTwUuid(uuid);
        return { uuid, jpUrl };
      })
    );

    const successJpUrls = results.filter(r => r.jpUrl !== null).map(r => r.jpUrl);

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
