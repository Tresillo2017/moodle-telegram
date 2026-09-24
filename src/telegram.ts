export interface ReplyKeyboard {
  keyboard: string[][];
  resize_keyboard: true;
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: ReplyKeyboard
): Promise<number | null> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  if (!res.ok) {
    console.error("telegram sendMessage failed", res.status, await res.text());
    return null;
  }
  const data: any = await res.json();
  return data.result?.message_id ?? null;
}

export async function editMessageText(token: string, chatId: number, messageId: number, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    console.error("telegram editMessageText failed", res.status, await res.text());
  }
}

export async function setMyCommands(token: string, commands: { command: string; description: string }[]) {
  await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands }),
  });
}
