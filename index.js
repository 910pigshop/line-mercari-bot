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

// 解析單一台灣 Mercari 網址（支援一般賣家 + Shops 商家）
async function getJpUrlFromTwUrl(fullUrl) {
  let resultUrl = null;

  // 1. 從網址提取乾淨的 UUID
  const uuidMatch = fullUrl.match(/items\/([a-zA-Z0-9-]+)/);
  if (!uuidMatch) return null;
  const uuid = uuidMatch[1];

  // 2. 策略一：請求台灣頁面，抓取 __NEXT_DATA__ JSON (最精準)
  try {
    const htmlResp = await fetch(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,ja;q=0.8,en;q=0.7'
      }
    });

    const html = await htmlResp.text();

    // 提取 __NEXT_DATA__ 腳本內容
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
    if (nextDataMatch) {
      const jsonStr = nextDataMatch[1];
      
      // A. 尋找 Shops 專屬的 Hash ID (例如 "j3gYo6MwpP57Xt562uu4SW")
      // 在 JSON 中尋找 rawProductId, productId, 或 shops/product 標籤
      const shopProdMatch = jsonStr.match(/"(?:rawProductId|productId|shopProductId)"\s*:\s*"([a-zA-Z0-9]{20,26})"/);
      const shopUrlMatch = jsonStr.match(/\/shops\/product\/([a-zA-Z0-9]{20,26})/);

      if (shopProdMatch && !shopProdMatch[1].startsWith('m')) {
        resultUrl = `https://jp.mercari.com/shops/product/${shopProdMatch[1]}`;
      } else if (shopUrlMatch) {
        resultUrl = `https://jp.mercari.com/shops/product/${shopUrlMatch[1]}`;
      }

      // B. 尋找一般個人商品的 m-ID (例如 "m12345678901")
      if (!resultUrl) {
        const itemMatch = jsonStr.match(/"(?:rawItemId|itemId|id)"\s*:\s*"(m\d{10,11})"/);
        if (itemMatch) {
          resultUrl = `https://jp.mercari.com/item/${itemMatch[1]}`;
        }
      }
    }

    // 備用：若 JSON 解析沒撈到，直接在大字串中正則掃描
    if (!resultUrl) {
      // 搜尋 Shops 格式
      const directShopMatch = html.match(/shops\/product\/([a-zA-Z0-9]{20,26})/);
      if (directShopMatch) {
        resultUrl = `https://jp.mercari.com/shops/product/${directShopMatch[1]}`;
      } else {
        // 搜尋 m-ID 格式
        const directItemMatch = html.match(/m\d{10,11}/);
        if (directItemMatch) {
          resultUrl = `https://jp.mercari.com/item/${directItemMatch[0]}`;
        }
      }
    }
  } catch (e) {
    console.log(`[HTML SSR Fetch] Failed for ${uuid}:`, e.message);
  }

  // 3. 策略二：如果前面都沒找到，最後退回 API 查詢
  if (!resultUrl) {
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
        }
      }
    } catch (e) {
      console.log(`[API Cross Border] Failed for ${uuid}`);
    }
  }

  return resultUrl;
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();

  // 抓出訊息中所有台灣 Mercari 網址 (匹配包含 parameters 的完整 URL)
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
