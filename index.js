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
  let resultUrl = null;

  // 1. 從網址提取乾淨的 UUID
  const uuidMatch = fullUrl.match(/items\/([a-zA-Z0-9-]+)/);
  if (!uuidMatch) return null;
  const uuid = uuidMatch[1];

  // 2. 策略一：請求台灣頁面 HTML，直接掃描 Open Graph 與 JSON 數據 (最精準)
  try {
    const htmlResp = await fetch(fullUrl, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-TW,zh;q=0.9,ja;q=0.8'
      }
    });

    const html = await htmlResp.text();

    // A. 抓取 Shops 商店商品標籤 (例如 jp.mercari.com/shops/product/j3gYo6MwpP57Xt562uu4SW)
    const ogShopMatch = html.match(/shops\/product\/([a-zA-Z0-9]{20,26})/);
    const rawProdMatch = html.match(/"rawProductId"\s*:\s*"([a-zA-Z0-9]{20,26})"/);
    const prodIdMatch = html.match(/"productId"\s*:\s*"([a-zA-Z0-9]{20,26})"/);

    if (ogShopMatch) {
      resultUrl = `https://jp.mercari.com/shops/product/${ogShopMatch[1]}`;
    } else if (rawProdMatch && !rawProdMatch[1].startsWith('m')) {
      resultUrl = `https://jp.mercari.com/shops/product/${rawProdMatch[1]}`;
    } else if (prodIdMatch && !prodIdMatch[1].startsWith('m')) {
      resultUrl = `https://jp.mercari.com/shops/product/${prodIdMatch[1]}`;
    }

    // B. 若非 Shops，抓取一般個人賣家商品的 m-ID (例如 m12345678901)
    if (!resultUrl) {
      const ogItemMatch = html.match(/item\/(m\d{10,11})/);
      const rawItemMatch = html.match(/"rawItemId"\s*:\s*"(m\d{10,11})"/);
      const generalItemMatch = html.match(/m\d{10,11}/);

      if (ogItemMatch) {
        resultUrl = `https://jp.mercari.com/item/${ogItemMatch[1]}`;
      } else if (rawItemMatch) {
        resultUrl = `https://jp.mercari.com/item/${rawItemMatch[1]}`;
      } else if (generalItemMatch) {
        resultUrl = `https://jp.mercari.com/item/${generalItemMatch[0]}`;
      }
    }
  } catch (e) {
    console.log(`[HTML Fetch] Failed for ${uuid}:`, e.message);
  }

  // 3. 策略二：如果 HTML 沒抓到且有 variant 參數，打 GraphQL API 補抓
  if (!resultUrl && fullUrl.includes('variant=')) {
    const variantMatch = fullUrl.match(/variant=([a-zA-Z0-9-]+)/);
    if (variantMatch) {
      try {
        const variantId = variantMatch[1];
        const graphqlQuery = {
          query: `query { shopProductVariant(id: "${variantId}") { rawProductId productId } }`
        };

        const gqResp = await fetch('https://tw.mercari.com/api/graphql', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'Referer': fullUrl
          },
          body: JSON.stringify(graphqlQuery)
        });

        if (gqResp.ok) {
          const gqData = await gqResp.json();
          const pId = gqData?.data?.shopProductVariant?.rawProductId || gqData?.data?.shopProductVariant?.productId;
          if (pId) {
            resultUrl = `https://jp.mercari.com/shops/product/${pId}`;
          }
        }
      } catch (e) {
        console.log(`[GraphQL] Failed for variant`);
      }
    }
  }

  // 4. 策略三：預備備用，打跨國 API
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

  // 抓出訊息中所有台灣 Mercari 網址 (匹配整段完整 URL)
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
