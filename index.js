const express = require('express');
const line = require('@line/bot-sdk');

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

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();
  const twUrlMatch = text.match(/https?:\/\/tw\.mercari\.com\/[^\s]+/);

  if (!twUrlMatch) {
    return Promise.resolve(null);
  }

  const twUrl = twUrlMatch[0];

  try {
    const uuidMatch = twUrl.match(/items\/([a-zA-Z0-9-]+)/);
    if (!uuidMatch) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 網址格式不正確，找不到商品 UUID。'
      });
    }

    const uuid = uuidMatch[1];
    const graphqlQuery = {
      query: `query getItem($id: String!) {
        item(id: $id) {
          id
          rawItemId
        }
      }`,
      variables: { id: uuid }
    };

    let mId = null;

    try {
      const apiResp = await fetch('https://tw.mercari.com/api/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Referer': twUrl
        },
        body: JSON.stringify(graphqlQuery)
      });

      if (apiResp.ok) {
        const resJson = await apiResp.json();
        if (resJson?.data?.item?.rawItemId) {
          mId = resJson.data.item.rawItemId;
        } else if (resJson?.data?.item?.id && resJson.data.item.id.startsWith('m')) {
          mId = resJson.data.item.id;
        }
      }
    } catch (e) {
      console.log('GraphQL API failed, using fallback...');
    }

    if (!mId) {
      const htmlResp = await fetch(twUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        }
      });
      const html = await htmlResp.text();
      const rawMatch = html.match(/"rawItemId"\s*:\s*"(m\d{10,11})"/);
      if (rawMatch) {
        mId = rawMatch[1];
      } else {
        const generalMatch = html.match(/m\d{10,11}/);
        if (generalMatch) mId = generalMatch[0];
      }
    }

    if (mId) {
      const jpUrl = `https://jp.mercari.com/item/${mId}`;
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `✅ 已成功為您解析日本原廠頁面：\n\n🇯🇵 日本 Mercari 網址：\n${jpUrl}`
      });
    } else {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 無法從該商品頁面中讀取到日本 m-ID，請確認商品是否已下架。'
      });
    }
  } catch (error) {
    console.error('解析錯誤:', error.message);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⚠️ 解析失敗，請確認網址是否正確或稍後再試！'
    });
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LINE Bot 服務已啟動，Port: ${PORT}`);
});
