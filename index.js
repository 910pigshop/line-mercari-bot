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
  // 萃取網址中的 ID
  const variantMatch = fullUrl.match(/variant=([a-zA-Z0-9-]+)/);
  const uuidMatch = fullUrl.match(/items\/([a-zA-Z0-9-]+)/);
  const variantId = variantMatch ? variantMatch[1] : null;
  const itemId = uuidMatch ? uuidMatch[1] : null;

  // 1. API 掃描 (對一般個人商品極快，但商店商品通常會被擋)
  const idsToTest = [variantId, itemId].filter(Boolean);
  for (const id of idsToTest) {
    try {
      const cbResp = await fetch(`https://api.mercari.jp/cross_border/v1/items/${id}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });

      if (cbResp.ok) {
        const cbData = await cbResp.json();
        const item = cbData?.item || cbData || {};
        
        if (item.product_id || item.raw_product_id) {
          const pId = item.raw_product_id || item.product_id;
          if (pId && !pId.includes('-')) return `https://jp.mercari.com/shops/product/${pId}`;
        }

        const mId = item.id || item.raw_item_id;
        if (mId && typeof mId === 'string' && mId.startsWith('m')) {
          return `https://jp.mercari.com/item/${mId}`;
        }
      }
    } catch (e) {
      console.log(`[API Error]:`, e.message);
    }
  }

  // 2. 終極多重 User-Agent 網頁解析 (專門對付 Shops 商店與 Cloudflare 防護)
  let htmlJpUrl = null;
  
  // 依序偽裝成 Facebook、Google 爬蟲、真實電腦、真實手機
  const userAgents = [
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
  ];

  for (const ua of userAgents) {
    try {
      const htmlResp = await fetch(fullUrl, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
        }
      });
      
      // 如果被 Cloudflare 阻擋 (403) 則立刻換下一個身分
      if (!htmlResp.ok) continue;

      const html = await htmlResp.text();

      // (A) 找尋一般商品 m-ID
      const mIdMatch = html.match(/m\d{10,11}/);
      if (mIdMatch) {
        htmlJpUrl = `https://jp.mercari.com/item/${mIdMatch[0]}`;
        break;
      }

      // (B) 找尋頁面中是否有直接暴露的日本網址
      const directLinkMatch = html.match(/https:\/\/jp\.mercari\.com\/(?:item\/|shops\/product\/)([a-zA-Z0-9_]+)/);
      if (directLinkMatch && !directLinkMatch[1].includes('-')) {
        const type = html.includes(`shops/product/${directLinkMatch[1]}`) ? 'shops/product' : 'item';
        htmlJpUrl = `https://jp.mercari.com/${type}/${directLinkMatch[1]}`;
        break;
      }

      // (C) 暴力尋找底層資料庫的商店 ID
      const shopRegexes = [
        /"rawProductId"\s*:\s*"([a-zA-Z0-9]+)"/,
        /"productId"\s*:\s*"([a-zA-Z0-9]+)"/,
        /mercari:\/\/shop\/product\/([a-zA-Z0-9]+)/,
        /shops\/product\/([a-zA-Z0-9]+)/
      ];

      for (const regex of shopRegexes) {
        const match = html.match(regex);
        if (match) {
          const id = match[1];
          // 確保不是 UUID 且長度符合商店 ID 特徵
          if (!id.includes('-') && id.length >= 10 && id.length <= 40) {
            htmlJpUrl = `https://jp.mercari.com/shops/product/${id}`;
            break;
          }
        }
      }
      
      // 如果找到了，就結束身分切換迴圈
      if (htmlJpUrl) break;

    } catch (e) {
      console.log(`[HTML Parse Error - UA: ${ua}]:`, e.message);
    }
  }

  return htmlJpUrl || null;
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
    
    // 並列處理解析所有網址
    const results = await Promise.all(
      uniqueUrls.map(async (url) => {
        const jpUrl = await getJpUrlFromTwUrl(url);
        return { url, jpUrl };
      })
    );

    const successResults = results.filter(r => r.jpUrl !== null);
    const failResults = results.filter(r => r.jpUrl === null);
    const successJpUrls = successResults.map(r => r.jpUrl);

    // 全部失敗
    if (successJpUrls.length === 0) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 轉換失敗：無法從提供的網址中擷取到日本 Mercari 頁面。可能是目標頁面已下架或遭防爬蟲機制阻擋。'
      });
    }

    // 組合成功的回覆內容
    let replyText = `🤖 此為ROBOT自動通知 🤖\n` +
      `因偵測到非日本MERCARI頁面\n` +
      `已成功為您導入日本頁面\n` +
      `請確認是否與原提供頁面是否為相同商品\n` +
      `如確認為相同商品 請務必回覆【相同】\n\n`;

    if (successJpUrls.length === 1) {
      replyText += `🇯🇵 日本 Mercari 網址：\n${successJpUrls[0]}`;
    } else {
      replyText += `🇯🇵 日本 Mercari 網址（共 ${successJpUrls.length} 個）：\n` + 
        successJpUrls.map((url, idx) => `${idx + 1}. ${url}`).join('\n\n');
    }

    // 新增：如果有漏掉的網址，會在最下方顯示提醒
    if (failResults.length > 0) {
      replyText += `\n\n⚠️ 提醒：有 ${failResults.length} 個網址解析失敗 (可能是商店商品或遭防阻擋) 請稍待人員為您報價。`;
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
