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
  // 1. 檢測是否為 Shops 商店商品
  const variantMatch = fullUrl.match(/variant=([a-zA-Z0-9-]+)/);
  if (variantMatch) {
    const variantId = variantMatch[1];
    try {
      const gqResp = await fetch('https://tw.mercari.com/api/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({
          query: `query GetShopVariant($id: String!) { shopProductVariant(id: $id) { productId rawProductId } }`,
          variables: { id: variantId }
        })
      });

      if (gqResp.ok) {
        const gqData = await gqResp.json();
        const shopProdId = gqData?.data?.shopProductVariant?.rawProductId || gqData?.data?.shopProductVariant?.productId;
        if (shopProdId) {
          return `https://jp.mercari.com/shops/product/${shopProdId}`;
        }
      }
    } catch (e) {
      console.log(`[Shops Variant Error]:`, e.message);
    }
  }

  // 2. 一般個人賣家商品解析
  const uuidMatch = fullUrl.match(/items\/([a-zA-Z0-9-]+)/);
  const uuid = uuidMatch ? uuidMatch[1] : null;

  if (uuid) {
    try {
      const cbResp = await fetch(`https://api.mercari.jp/cross_border/v1/items/${uuid}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });

      if (cbResp.ok) {
        const cbData = await cbResp.json();
        const item = cbData?.item || cbData || {};
        
        if (item.product_id || item.raw_product_id) {
          const pId = item.raw_product_id || item.product_id;
          return `https://jp.mercari.com/shops/product/${pId}`;
        }

        const mId = item.id || item.raw_item_id;
        if (mId && typeof mId === 'string' && mId.startsWith('m')) {
          return `https://jp.mercari.com/item/${mId}`;
        }
      }
    } catch (e) {
      console.log(`[Item API Error]:`, e.message);
    }
  }

  // 3. 終極備用方案 (直接抓取網頁 HTML)
  try {
    const htmlResp = await fetch(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      }
    });
    const html = await htmlResp.text();

    // 尋找一般商品 m-ID
    const mIdMatch = html.match(/m\d{10,11}/);
    if (mIdMatch) return `https://jp.mercari.com/item/${mIdMatch[0]}`;

    // 尋找商店商品 ID (改用傳統 match 避免版本不相容問題)
    const rawIdMatch = html.match(/"rawProductId":"([a-zA-Z0-9]{15,30})"/);
    if (rawIdMatch && !rawIdMatch[1].includes('-')) return `https://jp.mercari.com/shops/product/${rawIdMatch[1]}`;

    const prodIdMatch = html.match(/"productId":"([a-zA-Z0-9]{15,30})"/);
    if (prodIdMatch && !prodIdMatch[1].includes('-')) return `https://jp.mercari.com/shops/product/${prodIdMatch[1]}`;

    const shopUrlMatch = html.match(/shops\/product\/([a-zA-Z0-9]{15,30})/);
    if (shopUrlMatch && !shopUrlMatch[1].includes('-')) return `https://jp.mercari.com/shops/product/${shopUrlMatch[1]}`;

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

  // 抓出所有網址
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

    // 如果全部失敗，給予錯誤提示，不再靜音裝死
    if (successJpUrls.length === 0) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 轉換失敗：無法從提供的網址中擷取到日本 Mercari 頁面。可能是目標頁面已下架或格式變更。'
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
