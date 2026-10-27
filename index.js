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

  // 1. 提取 UUID 與 variant
  const uuidMatch = fullUrl.match(/items\/([a-zA-Z0-9-]+)/);
  if (!uuidMatch) return null;
  const uuid = uuidMatch[1];
  const variantMatch = fullUrl.match(/variant=([a-zA-Z0-9-]+)/);

  // 策略一：若網址有 variant 參數（典型的 Shops 商店標誌）
  if (variantMatch) {
    const variantId = variantMatch[1];
    try {
      // 1-A. 打台灣頁面抓取渲染後的 canonical URL 或 Shops 數據
      const shopPageResp = await fetch(`https://tw.mercari.com/zh-hant/items/${uuid}?variant=${variantId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept': 'text/html'
        }
      });
      const html = await shopPageResp.text();

      // 精準比對 Shops Product Hash (例如 j3gYo6MwpP57Xt562uu4SW，由英數字組成約 22 位)
      const shopHashMatch = html.match(/\/shops\/product\/([a-zA-Z0-9]{20,26})/);
      const rawProdMatch = html.match(/"rawProductId"\s*:\s*"([a-zA-Z0-9]{20,26})"/);
      const prodIdMatch = html.match(/"productId"\s*:\s*"([a-zA-Z0-9]{20,26})"/);

      if (shopHashMatch) {
        resultUrl = `https://jp.mercari.com/shops/product/${shopHashMatch[1]}`;
      } else if (rawProdMatch && !rawProdMatch[1].startsWith('m')) {
        resultUrl = `https://jp.mercari.com/shops/product/${rawProdMatch[1]}`;
      } else if (prodIdMatch && !prodIdMatch[1].startsWith('m')) {
        resultUrl = `https://jp.mercari.com/shops/product/${prodIdMatch[1]}`;
      }
    } catch (e) {
      console.log(`[Shops Variant Parsing Failed] ${uuid}`);
    }
  }

  // 策略二：打 Mercari 跨境 API (適用一般個人賣家)
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
      console.log(`[Cross Border API Failed] ${uuid}`);
    }
  }

  // 策略三：全域 HTML 備用爬取 (支援正則捕捉 m-ID 與 Shops Hash)
  if (!resultUrl) {
    try {
      const htmlResp = await fetch(fullUrl, {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html'
        }
      });
      const html = await htmlResp.text();

      const shopMatch = html.match(/\/shops\/product\/([a-zA-Z0-9]{20,26})/);
      const itemMatch = html.match(/m\d{10,11}/);

      if (shopMatch) {
        resultUrl = `https://jp.mercari.com/shops/product/${shopMatch[1]}`;
      } else if (itemMatch) {
        resultUrl = `https://jp.mercari.com/item/${itemMatch[0]}`;
      }
    } catch (e) {
      console.log(`[Fallback Fetch Failed] ${uuid}`);
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
