const line = require('@line/bot-sdk');
const express = require('express');
const OpenAI = require('openai');
const { google } = require('googleapis');
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

// ─── Google Sheets認証 ────────────────────────────────────────

function getGoogleSheetsClient() {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: privateKey,
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// ─── スプレッドシート末尾に追記 ──────────────────────────────

async function appendToSheet(expense) {
  const sheets = getGoogleSheetsClient();
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const values = [[now, expense.date, expense.item, expense.amount, expense.category]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: "Sheet1!A:E",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
  console.log("✅ スプレッドシートに書き込み完了:", values);
}

// ─── メインハンドラー ─────────────────────────────────────────

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userText = event.message.text;
  const today = new Date().toLocaleDateString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit"
  });

  // AIに分類・整理してもらう
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `あなたは整理の達人です。ユーザーから送られた情報を「家計簿」「予定」「メモ」「ゴミの日」のいずれかに分類してください。

【家計簿の場合】
必ず以下のJSON形式のみを返してください。余計な説明・マークダウン不要。
{
  "type": "家計簿",
  "date": "YYYY/MM/DD",
  "item": "品目名",
  "amount": 数値,
  "category": "食費/交通費/日用品/娯楽/医療費/衣服/光熱費/外食/その他",
  "reply": "LINEに返信するメッセージ"
}

【家計簿以外の場合】
{
  "type": "その他",
  "reply": "見やすく整理した返信メッセージ"
}

日付不明の場合は今日（${today}）を使用。分類できない場合はtypeを「不明」にして聞き返す。`
      },
      { role: "user", content: userText }
    ],
    temperature: 0,
  });

  const content = completion.choices[0].message.content.trim();
  console.log("AI応答:", content);

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // JSON解析失敗時はそのまま返信
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: content
    });
  }

  // 家計簿ならスプレッドシートに保存
  if (parsed.type === "家計簿") {
    try {
      await appendToSheet({
        date: parsed.date,
        item: parsed.item,
        amount: parsed.amount,
        category: parsed.category,
      });
    } catch (err) {
      console.error("❌ スプレッドシート書き込みエラー:", err);
    }
  }

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: parsed.reply || "処理しました。"
  });
}

const client = new line.Client(config);
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});