// ============================================================
// LINEボット × Google Sheets 家計簿保存機能
// ============================================================
// 必要パッケージ: npm install @line/bot-sdk openai googleapis dotenv
// .env に以下を設定してください:
//   LINE_ACCESS_TOKEN=...
//   LINE_CHANNEL_SECRET=...
//   OPENAI_API_KEY=...
//   GOOGLE_SERVICE_ACCOUNT_EMAIL=...
//   GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n(長い秘密鍵)\n-----END PRIVATE KEY-----\n"
//   SPREADSHEET_ID=...
//   PORT=3000
// ============================================================

require("dotenv").config();
const line = require("@line/bot-sdk");
const { OpenAI } = require("openai");
const { google } = require("googleapis");
const express = require("express");

// ─── クライアント初期化 ───────────────────────────────────────

const lineConfig = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,   // ← LINE_ACCESS_TOKEN
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── OpenAI: 家計簿データ解析 ────────────────────────────────

/**
 * ユーザーのメッセージを解析し、家計簿データをJSON形式で返す
 * @param {string} userMessage - ユーザーの自然言語メッセージ
 * @returns {Object|null} { date, item, amount, category } or null
 */
async function parseExpenseWithAI(userMessage) {
  const today = new Date().toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const systemPrompt = `あなたは家計簿アシスタントです。
ユーザーのメッセージから支出情報を読み取り、必ず以下の構造のJSONのみを返してください。
余計な説明文・マークダウン・コードブロックは一切含めないでください。

{
  "date": "YYYY/MM/DD",
  "item": "品目名",
  "amount": 数値（円単位の整数）,
  "category": "カテゴリ名"
}

【カテゴリの選択肢】
食費, 交通費, 日用品, 娯楽, 医療費, 衣服, 光熱費, 外食, その他

【ルール】
- 日付が不明な場合は今日の日付（${today}）を使用する
- 金額は数値のみ（円記号・カンマ不要）
- 品目が不明な場合は "不明" とする
- JSONとして解析不能な入力の場合は {"error": "解析できませんでした"} を返す`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0,
    max_tokens: 200,
  });

  const content = response.choices[0].message.content.trim();

  try {
    const parsed = JSON.parse(content);
    if (parsed.error) return null;
    // 必須フィールド検証
    if (!parsed.date || !parsed.item || !parsed.amount || !parsed.category) {
      return null;
    }
    return parsed;
  } catch {
    console.error("JSON parse error:", content);
    return null;
  }
}

// ─── Google Sheets: 認証 ────────────────────────────────────

/**
 * サービスアカウントで Google Sheets API の認証を行う
 */
function getGoogleSheetsClient() {
  // GOOGLE_PRIVATE_KEY の \n を実際の改行に変換
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  
  // ↓ デバッグ用（確認後に削除）
  console.log("=== PRIVATE_KEY DEBUG ===");
  console.log("先頭40文字:", privateKey.substring(0, 40));
  console.log("改行含む?:", privateKey.includes("\n"));
  console.log("メール:", process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  console.log("SPREADSHEET_ID:", process.env.SPREADSHEET_ID);
  console.log("========================");
  // ↑ ここまで


  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: privateKey,
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

// ─── Google Sheets: 末尾に1行追記 ──────────────────────────

/**
 * スプレッドシートの末尾に家計簿データを追加する
 * @param {{ date: string, item: string, amount: number, category: string }} expense
 */
async function appendToSheet(expense) {
  const sheets = getGoogleSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;

  // シート名を指定（デフォルト: Sheet1）
  const range = "Sheet1!A:E";

  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  // 列構成: 登録日時 | 日付 | 品目 | 金額 | カテゴリ
  const values = [[now, expense.date, expense.item, expense.amount, expense.category]];

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED", // 日付を自動認識
    insertDataOption: "INSERT_ROWS",  // 既存データを上書きしない
    requestBody: { values },
  });

  return response.data.updates;
}

// ─── シートヘッダー初期化（初回のみ） ────────────────────────

/**
 * スプレッドシートが空の場合にヘッダー行を追加する
 */
async function initSheetHeader() {
  const sheets = getGoogleSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Sheet1!A1",
  });

  if (!existing.data.values) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      requestBody: {
        values: [["登録日時", "日付", "品目", "金額（円）", "カテゴリ"]],
      },
    });
    console.log("✅ ヘッダー行を初期化しました");
  }
}

// ─── LINEメッセージハンドラー ────────────────────────────────

async function handleMessage(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userText = event.message.text;
  const replyToken = event.replyToken;

  try {
    // 1. AIで解析
    const expense = await parseExpenseWithAI(userText);

    if (!expense) {
      await lineClient.replyMessage(replyToken, {
        type: "text",
        text: "⚠️ 支出情報を読み取れませんでした。\n例: 「コンビニで昼食500円」「電車代230円」のように送ってみてください。",
      });
      return;
    }

    // 2. スプレッドシートに保存
    await appendToSheet(expense);

    // 3. 確認メッセージを返信
    const replyText =
      `✅ 家計簿に記録しました！\n` +
      `📅 日付: ${expense.date}\n` +
      `🛍️ 品目: ${expense.item}\n` +
      `💴 金額: ${expense.amount.toLocaleString()}円\n` +
      `🏷️ カテゴリ: ${expense.category}`;

    await lineClient.replyMessage(replyToken, {
      type: "text",
      text: replyText,
    });
  } catch (err) {
    console.error("Error:", err);
    await lineClient.replyMessage(replyToken, {
      type: "text",
      text: "❌ エラーが発生しました。しばらく経ってからもう一度お試しください。",
    });
  }
}

// ─── Expressサーバー ─────────────────────────────────────────

const app = express();

app.post(
  "/webhook",
  line.middleware(lineConfig),
  (req, res) => {
    Promise.all(req.body.events.map(handleMessage))
      .then(() => res.status(200).json({ status: "ok" }))
      .catch((err) => {
        console.error(err);
        res.status(500).end();
      });
  }
);

app.get("/", (_, res) => res.send("LINE Kakeibo Bot is running 🟢"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server started on port ${PORT}`);
  await initSheetHeader().catch(console.error);
});