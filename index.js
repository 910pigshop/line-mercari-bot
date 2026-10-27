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

// 解析單一台灣 Mercari 網址（支援一般賣家 + Mercari Shops 商家）
async function getJpUrlFromTwUrl(fullUrl) {
  // 1. 淨化網址：去掉 ?variant=... 等 query 參數並精準提取 UUID
  const cleanUrl = fullUrl.split('?')[0];
  const uuidMatch = cleanUrl.match(/items\/([a-zA-Z0-9-]+)/);
  if (!uuidMatch) return null;

  const uuid = uuidMatch[1];
  let resultUrl = null;

  // 2. 方法一：直連 Mercari 跨境 API 深度解析
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

      // Shops 商店商品判斷
      if (item.shop_id || item.is_shops || item.product_id || item.raw_item_id?.length > 15 || item.id?.length > 15) {
        const productId = item.raw_item_id || item.product_id || item.id;
        if (productId && !productId.startsWith('m')) {
          resultUrl = `https://jp.mercari.com/shops/product/${productId}`;
        }
      }
      
      // 一般個人商品判斷
      if (!resultUrl) {
        if (item.id && item.id.startsWith('m')) {
          resultUrl = `https://jp.mercari.com/item/${item.id}`;
        } else if (item.raw_item_id && item.raw_item_id.startsWith('m')) {
          resultUrl = `https://jp.mercari.com/item/${item.raw_item_id}`;
        }
      }
    }
  } catch (e) {
    console.log(`[${uuid}] Cross border API failed, switching to HTML parsing...`);
  }

  // 3. 方法二：備用方案，直接爬取台灣 HTML 全面解讀隱藏 JSON
  if (!resultUrl) {
    try {
      const htmlResp = await fetch(cleanUrl, {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html'
        }
      });
      const html = await htmlResp.text();

      // A. 先比對是否為 Shops 商店網址標記 (例如 /shops/product/j3gYo6MwpP57Xt562uu4SW)
      const shopMatch = html.match(/shops\/product\/([a-zA-Z0-9]+)/);
      if (shopMatch) {
        resultUrl = `https://jp.mercari.com/shops/product/${shopMatch[1]}`;
      }

      // B. 比對 JSON 欄位中的 "productId":"j3gYo6MwpP57Xt562uu4SW"
      if (!resultUrl) {
        const prodIdMatch = html.match(/"productId"\s*:\s*"([a-zA-Z0-9]+)"/);
        if (prodIdMatch && !prodIdMatch[1].startsWith('m')) {
          resultUrl = `https://jp.mercari.com/shops/product/${prodIdMatch[1]}`;
        }
      }

      // C. 比對一般個人商品的 m-ID
      if (!resultUrl) {
        const itemMatch = html.match(/m\d{10,11}/);
        if (itemMatch) {
          resultUrl = `https://jp.mercari.com/item/${itemMatch[0]}`;
        }
      }
    } catch (e) {
      console.log(`[${uuid}] HTML Fallback error:`, e.message);
    }
  }

  return resultUrl;
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();

  // 抓出訊息中「所有」台灣 Mercari 網址 (包括帶有 ? 參數的網址)
  const twUrlMatches = text.match(/https?:\/\/tw\.mercari\.com\/[^\s]+/g);

  if (!twUrlMatches || twUrlMatches.length === 0) {
    return Promise.resolve(null);
  }

  try {
    // 網址去重
    const uniqueUrls = Array.from(new Set(twUrlMatches));

    // 並列解析所有網址
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
