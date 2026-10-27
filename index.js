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
  let resultUrl = null;

  // 1. 提取 UUID 與 variant ID
  const uuidMatch = fullUrl.match(/items\/([a-zA-Z0-9-]+)/);
  if (!uuidMatch) return null;
  const uuid = uuidMatch[1];
  const variantMatch = fullUrl.match(/variant=([a-zA-Z0-9-]+)/);

  // 策略 A：如果有 variant 參數（Shops 店家商品）
  if (variantMatch) {
    const variantId = variantMatch[1];
    try {
      // 直連台灣後端 GraphQL 微服務
      const gqBody = {
        operationName: "GetShopProductVariant",
        query: `query GetShopProductVariant($id: String!) {
          shopProductVariant(id: $id) {
            id
            productId
            rawProductId
          }
        }`,
        variables: { id: variantId }
      };

      const gqResp = await fetch('https://tw.mercari.com/api/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        },
        body: JSON.stringify(gqBody)
      });

      if (gqResp.ok) {
        const resJson = await gqResp.json();
        const vData = resJson?.data?.shopProductVariant;
        const prodId = vData?.rawProductId || vData?.productId;
        if (prodId) {
          resultUrl = `https://jp.mercari.com/shops/product/${prodId}`;
        }
      }
    } catch (e) {
      console.log(`[GraphQL Shops] Failed for variant ${variantMatch[1]}`);
    }
  }

  // 策略 B：若非 variant 或 GraphQL 沒拿到，用 UUID 打通用 GraphQL 查一般商品與 Shops
  if (!resultUrl) {
    try {
      const gqItemBody = {
        operationName: "GetItem",
        query: `query GetItem($id: String!) {
          item(id: $id) {
            id
            rawItemId
            shopId
            productId
          }
        }`,
        variables: { id: uuid }
      };

      const itemResp = await fetch('https://tw.mercari.com/api/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        },
        body: JSON.stringify(gqItemBody)
      });

      if (itemResp.ok) {
        const itemJson = await itemResp.json();
        const itemData = itemJson?.data?.item;

        if (itemData) {
          // 如果是 Shops 店家商品
          if (itemData.shopId || itemData.productId) {
            const pId = itemData.productId || itemData.rawItemId || itemData.id;
            if (pId && !pId.startsWith('m')) {
              resultUrl = `https://jp.mercari.com/shops/product/${pId}`;
            }
          }
          // 一般個人賣家商品
          if (!resultUrl) {
            const mId = itemData.rawItemId || itemData.id;
            if (mId && mId.startsWith('m')) {
              resultUrl = `https://jp.mercari.com/item/${mId}`;
            }
          }
        }
      }
    } catch (e) {
      console.log(`[GraphQL Item] Failed for ${uuid}`);
    }
  }

  // 策略 C：備用，打 cross_border API
  if (!resultUrl) {
    try {
      const cbResp = await fetch(`https://api.mercari.jp/cross_border/v1/items/${uuid}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });
      if (cbResp.ok) {
        const cbData = await cbResp.json();
        const mId = cbData?.item?.id || cbData?.raw_item_id;
        if (mId && mId.startsWith('m')) {
          resultUrl = `https://jp.mercari.com/item/${mId}`;
        }
      }
    } catch (e) {
      console.log(`[CB API] Failed for ${uuid}`);
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
