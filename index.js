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

// 解析單一網址：獨立處理 Shops 與 一般個人商品
async function getJpUrlFromTwUrl(fullUrl) {
  let resultUrl = null;

  // 1. 判斷是否為 Mercari Shops 商店商品 (網址帶有 variant 參數)
  const variantMatch = fullUrl.match(/variant=([a-zA-Z0-9-]+)/);

  if (variantMatch) {
    const variantId = variantMatch[1];
    const uuidMatch = fullUrl.match(/items\/([a-zA-Z0-9-]+)/);
    const uuid = uuidMatch ? uuidMatch[1] : '';

    // 招式 A：透過 GraphQL API 查詢
    try {
      const response = await fetch('https://tw.mercari.com/api/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Referer': `https://tw.mercari.com/zh-hant/items/${uuid}`
        },
        body: JSON.stringify({
          query: `query getItem($id: String!) { item(id: $id) { id rawItemId productId rawProductId shopId } }`,
          variables: { id: uuid }
        })
      });

      if (response.ok) {
        const json = await response.json();
        const itemData = json?.data?.item;
        const shopProdId = itemData?.rawProductId || itemData?.productId;
        if (shopProdId) {
          return `https://jp.mercari.com/shops/product/${shopProdId}`;
        }
      }
    } catch (e) {
      console.log(`[Shops GraphQL Error] ${uuid}:`, e.message);
    }

    // 招式 B：直接抓取網頁爬取原始碼中的 OG 標籤 / Shops Product Hash (備援)
    try {
      const htmlResp = await fetch(`https://tw.mercari.com/zh-hant/items/${uuid}?variant=${variantId}`, {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html'
        }
      });
      const html = await htmlResp.text();

      // 比對 Shops Product ID (22 位英數字 Hash)
      const shopHashMatch = html.match(/\/shops\/product\/([a-zA-Z0-9]{20,26})/);
      const rawProdMatch = html.match(/"rawProductId"\s*:\s*"([a-zA-Z0-9]{20,26})"/);
      const prodIdMatch = html.match(/"productId"\s*:\s*"([a-zA-Z0-9]{20,26})"/);

      if (shopHashMatch) {
        return `https://jp.mercari.com/shops/product/${shopHashMatch[1]}`;
      } else if (rawProdMatch) {
        return `https://jp.mercari.com/shops/product/${rawProdMatch[1]}`;
      } else if (prodIdMatch) {
        return `https://jp.mercari.com/shops/product/${prodIdMatch[1]}`;
      }
    } catch (e) {
      console.log(`[Shops HTML Error] ${uuid}:`, e.message);
    }
  }

  // 2. 原封不動保留：原本最穩定的「一般個人商品」解析邏輯
  const cleanUrl = fullUrl.split('?')[0];
  const uuidMatch = cleanUrl.match(/items\/([a-zA-Z0-9-]+)/);
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
      const mId = cbData?.item?.id || cbData?.raw_item_id;
      if (mId) {
        resultUrl = `https://jp.mercari.com/item/${mId}`;
      }
    }
  } catch (e) {
    console.log(`[Item Error] ${uuid}:`, e.message);
  }

  // 3. 一般商品的 HTML 備用方案
  if (!resultUrl) {
    try {
      const htmlResp = await fetch(cleanUrl, {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html'
        }
      });
      const html = await htmlResp.text();
      const match = html.match(/m\d{10,11}/);
      if (match) {
        resultUrl = `https://jp.mercari.com/item/${match[0]}`;
      }
    } catch (e) {
      console.log(`[Fallback Error] ${uuid}:`, e.message);
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
  const twUrlMatches = text.match(/https?:\/\/tw\.mercari\.com\/[^\s\n]+/g);

  if (!twUrlMatches || twUrlMatches.length === 0) {
    return Promise.resolve(null);
  }

  try {
    // 網址去重複
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
