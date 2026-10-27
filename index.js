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

// 解析單一台灣 Mercari 網址（精準支援一般個人賣家 + Shops 商家）
async function getJpUrlFromTwUrl(fullUrl) {
  // 1. 分離 URL 參數，提取乾淨 UUID
  const cleanUrl = fullUrl.split('?')[0];
  const uuidMatch = cleanUrl.match(/items\/([a-zA-Z0-9-]+)/);
  if (!uuidMatch) return null;

  const uuid = uuidMatch[1];
  let resultUrl = null;

  // 2. 策略一：打 Mercari 跨國一般 API
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

      if (item.is_shops || item.shop_id || (item.id && !item.id.startsWith('m'))) {
        const productId = item.raw_item_id || item.product_id || item.id;
        if (productId) {
          resultUrl = `https://jp.mercari.com/shops/product/${productId}`;
        }
      } else if (item.id && item.id.startsWith('m')) {
        resultUrl = `https://jp.mercari.com/item/${item.id}`;
      } else if (item.raw_item_id && item.raw_item_id.startsWith('m')) {
        resultUrl = `https://jp.mercari.com/item/${item.raw_item_id}`;
      }
    }
  } catch (e) {
    console.log(`[${uuid}] API 1 failed`);
  }

  // 3. 策略二：打 Mercari 跨國 Shops 專用 API (解決 Shops 商品 API 阻擋問題)
  if (!resultUrl) {
    try {
      const shopApiUrl = `https://api.mercari.jp/cross_border/v1/shops/products/${uuid}`;
      const shopResp = await fetch(shopApiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });

      if (shopResp.ok) {
        const shopData = await shopResp.json();
        const prodId = shopData?.product?.id || shopData?.id || shopData?.raw_product_id;
        if (prodId) {
          resultUrl = `https://jp.mercari.com/shops/product/${prodId}`;
        }
      }
    } catch (e) {
      console.log(`[${uuid}] API 2 failed`);
    }
  }

  // 4. 策略三：深度挖掘台灣頁面 HTML JSON 資料（對應各種預載入標籤）
  if (!resultUrl) {
    try {
      const htmlResp = await fetch(fullUrl, {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html'
        }
      });
      const html = await htmlResp.text();

      // 比對 Shops 商店 ID (長度約 22 位的英數字字串，例如 j3gYo6MwpP57Xt562uu4SW)
      const shopMatch = html.match(/\/shops\/product\/([a-zA-Z0-9]{20,25})/);
      const prodIdMatch = html.match(/"product_id"\s*:\s*"([a-zA-Z0-9]{20,25})"/);
      const prodIdMatch2 = html.match(/"productId"\s*:\s*"([a-zA-Z0-9]{20,25})"/);

      if (shopMatch) {
        resultUrl = `https://jp.mercari.com/shops/product/${shopMatch[1]}`;
      } else if (prodIdMatch) {
        resultUrl = `https://jp.mercari.com/shops/product/${prodIdMatch[1]}`;
      } else if (prodIdMatch2) {
        resultUrl = `https://jp.mercari.com/shops/product/${prodIdMatch2[1]}`;
      } else {
        // 比對一般個人商品 m-ID
        const itemMatch = html.match(/m\d{10,11}/);
        if (itemMatch) {
          resultUrl = `https://jp.mercari.com/item/${itemMatch[0]}`;
        }
      }
    } catch (e) {
      console.log(`[${uuid}] Fallback failed:`, e.message);
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
    const uniqueUrls = Array.from(new Set(twUrlMatches));

    const results = await Promise.all(
      uniqueUrls.map(async (url) => {
        const jpUrl = await getJpUrlFromTwUrl(url);
        return { url, jpUrl };
      })
    );

    const successJpUrls = results.filter(r => r.jpUrl !== null).map(r => r.jpUrl);

    if (successJpUrls.length === 0) {
      return Promise.resolve(null);
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
