const line = require('@line/bot-sdk');
const express = require('express');
const OpenAI = require('openai');
require('dotenv').config();

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  // --- AIに考えてもらう部分 ---
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system", 
        content: "あなたは整理の達人です。ユーザーから送られた情報を「家計簿」「予定」「メモ」「ゴミの日」のいずれかに分類し、見やすく箇条書きで整理して返してください。分類できないものは丁寧に聞き返してください。"
      },
      { role: "user", content: event.message.text }
    ],
  });

  const aiResponse = completion.choices[0].message.content;

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: aiResponse
  });
}

const client = new line.Client(config);
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});