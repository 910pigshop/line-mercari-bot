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
  // 1. 先檢測是否為 Shops 商店商品 (網址是否帶有 variant ID)
  const variantMatch = fullUrl.match(/variant=([a-zA-Z0-9-]+)/);

  if (variantMatch) {
    const variantId = variantMatch[1];
    try {
      // 直連台灣 Mercari GraphQL，以 variant ID 取得 Shops 原始 Product ID
      const gqResp = await fetch('https://tw.mercari.com/api/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Referer': 'https://tw.mercari.com/'
        },
        body: JSON.stringify({
          query: `query GetShopVariant($id: String!) { shopProductVariant(id: $id) { productId rawProductId } }`,
          variables: { id: variantId }
        })
      });

      if (gqResp.ok) {
        const gqData = await gqResp.json();
        const vData = gqData?.data?.shopProductVariant;
        const shopProdId = vData?.rawProductId || vData?.productId;
        if (shopProdId) {
          return `https://jp.mercari.com/shops/product/${shopProdId}`;
        }
      }
    } catch (e) {
      console.log(`[Shops Variant Error] ${variantId}:`, e.message);
    }
  }

  // 2. 一般個人賣家商品解析 (原本完全正常的邏輯，保持不動)
  const uuidMatch = fullUrl.match(/items\/([a-zA-Z0-9-]+)/);
  if (!uuidMatch) return null;

  const uuid = uuidMatch[1];

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
      const item = cbData?.item || cbData || {};
      
      // 如果一般 API 也帶有 Shops product_id
      if (item.product_id || item.raw_product_id) {
        const pId = item.raw_product_id || item.product_id;
        return `https://jp.mercari.com/shops/product/${pId}`;
      }

      // 一般個人 m-ID
      const mId = item.id || item.raw_item_id;
      if (mId && typeof mId === 'string' && mId.startsWith('m')) {
        return `https://jp.mercari.com/item/${mId}`;
      }
    }
  } catch (e) {
    console.log(`[Item Error] ${uuid}:`, e.message);
  }

  // 3. 備用方案
  try {
    const htmlResp = await fetch(`https://tw.mercari.com/zh-hant/items/${uuid}`, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept': 'text/html'
      }
    });
    const html = await htmlResp.text();
    const match = html.match(/m\d{10,11}/);
    if (match) {
      return `https://jp.mercari.com/item/${match[0]}`;
    }
  } catch (e) {
    console.log(`[Fallback Error] ${uuid}:`, e.message);
  }

  return null;
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();

  // 抓出訊息中所有台灣 Mercari 網址 (改用更穩定的正則，避免被特殊引數截斷)
  const twUrlMatches = text.match(/https?:\/\/tw\.mercari\.com\/[^\s]+/g);

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
