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

// 解析單一台灣 Mercari 網址（支援一般個人賣家 + Shops 商家）
async function getJpUrlFromTwUrl(fullUrl) {
  let resultUrl = null;

  // 1. 從網址提取乾淨的 item UUID (例如 ab7fd1d7-f571-4e46-bab5-de17283eeb30)
  const uuidMatch = fullUrl.match(/items\/([a-zA-Z0-9-]+)/);
  if (!uuidMatch) return null;
  const uuid = uuidMatch[1];

  // 2. 從網址提取 variant ID (例如 5a14a5a2-899f-4caf-8455-8fba4afe667d)
  const variantMatch = fullUrl.match(/variant=([a-zA-Z0-9-]+)/);

  // 策略 A：如果有 variant ID (商家 Shops 頁面特徵)
  if (variantMatch) {
    const variantId = variantMatch[1];
    try {
      // 直連台灣後端 GraphQL API 查出的原始 Shops Product ID
      const graphqlQuery = {
        query: `query { shopProductVariant(id: "${variantId}") { productId rawProductId } }`
      };

      const gqResp = await fetch('https://tw.mercari.com/api/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Referer': `https://tw.mercari.com/zh-hant/items/${uuid}`
        },
        body: JSON.stringify(graphqlQuery)
      });

      if (gqResp.ok) {
        const gqData = await gqResp.json();
        const variantData = gqData?.data?.shopProductVariant;
        const prodId = variantData?.rawProductId || variantData?.productId;
        if (prodId) {
          resultUrl = `https://jp.mercari.com/shops/product/${prodId}`;
        }
      }
    } catch (e) {
      console.log(`[Shops Variant] Failed for ${uuid}`);
    }
  }

  // 策略 B：打跨國 API 查詢 (一般商品 / 部分 Shops)
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
        } else if (item.raw_item_id && item.raw_item_id.startsWith('m')) {
          resultUrl = `https://jp.mercari.com/item/${item.raw_item_id}`;
        }
      }
    } catch (e) {
      console.log(`[API Cross Border] Failed for ${uuid}`);
    }
  }

  // 策略 C：抓取 HTML 頁面進行全文深度掃描
  if (!resultUrl) {
    try {
      const cleanUrl = `https://tw.mercari.com/zh-hant/items/${uuid}`;
      const htmlResp = await fetch(cleanUrl, {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html'
        }
      });
      const html = await htmlResp.text();

      // 比對各種 Shops Product ID 正則 pattern
      const shopMatch = html.match(/\/shops\/product\/([a-zA-Z0-9]+)/);
      const prodIdMatch = html.match(/"rawProductId"\s*:\s*"([a-zA-Z0-9]+)"/);
      const prodIdMatch2 = html.match(/"productId"\s*:\s*"([a-zA-Z0-9]+)"/);

      if (shopMatch) {
        resultUrl = `https://jp.mercari.com/shops/product/${shopMatch[1]}`;
      } else if (prodIdMatch && !prodIdMatch[1].startsWith('m')) {
        resultUrl = `https://jp.mercari.com/shops/product/${prodIdMatch[1]}`;
      } else if (prodIdMatch2 && !prodIdMatch2[1].startsWith('m')) {
        resultUrl = `https://jp.mercari.com/shops/product/${prodIdMatch2[1]}`;
      } else {
        // 比對一般個人賣家 m-ID
        const itemMatch = html.match(/m\d{10,11}/);
        if (itemMatch) {
          resultUrl = `https://jp.mercari.com/item/${itemMatch[0]}`;
        }
      }
    } catch (e) {
      console.log(`[HTML Fallback] Failed for ${uuid}`);
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
