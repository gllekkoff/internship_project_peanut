import { makeLogger } from '@/core/core.logger';

const log = makeLogger('Telegram');

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_S = 30;
const URGENT_RETRIES = 3;
const URGENT_BACKOFF_MS = 1_000;

interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
}

type CommandHandler = () => void | Promise<void>;

export class TelegramNotifier {
  private readonly baseUrl: string;
  private readonly chatIdNum: number;
  private offset = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private commands: Map<string, CommandHandler> = new Map();

  constructor(
    botToken: string,
    private readonly chatId: string,
  ) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
    this.chatIdNum = Number(chatId);
  }

  async send(message: string, urgent = false): Promise<void> {
    const text = urgent ? `🚨 URGENT 🚨\n${message}` : message;
    const body = JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML' });
    const attempts = urgent ? URGENT_RETRIES : 1;

    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`${this.baseUrl}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (res.ok) return;
        log.warn(`Telegram send failed (attempt ${i + 1}/${attempts}): HTTP ${res.status}`);
      } catch (e) {
        log.warn(
          `Telegram send error (attempt ${i + 1}/${attempts}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, URGENT_BACKOFF_MS * (i + 1)));
    }
  }

  async sendControlPanel(text: string): Promise<void> {
    const body = JSON.stringify({
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🛑 Stop bot', callback_data: 'stop' }]] },
    });
    try {
      await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (e) {
      log.warn(`Telegram control panel send failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  onCommand(name: string, handler: CommandHandler): void {
    this.commands.set(name, handler);
  }

  startListening(): void {
    if (this.pollTimer) return;
    log.info('Telegram command listener started');
    void this.drainStaleUpdates().then(() => {
      const tick = (): void => {
        void this.pollOnce().finally(() => {
          this.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
        });
      };
      this.pollTimer = setTimeout(tick, 0);
    });
  }

  stopListening(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async drainStaleUpdates(): Promise<void> {
    try {
      const url = `${this.baseUrl}/getUpdates?limit=1&offset=-1`;
      const res = await fetch(url);
      if (!res.ok) return;
      const json = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
      if (json.ok && json.result && json.result.length > 0) {
        this.offset = json.result[json.result.length - 1]!.update_id + 1;
        log.info(`Telegram: discarded stale updates, starting from offset=${this.offset}`);
      }
    } catch {
      // Non-fatal — polling will handle any duplicates naturally.
    }
  }

  private async pollOnce(): Promise<void> {
    try {
      const url = `${this.baseUrl}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${this.offset}&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const json = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
      if (!json.ok || !json.result) return;
      for (const update of json.result) {
        this.offset = update.update_id + 1;
        await this.handleUpdate(update);
      }
    } catch (e) {
      log.warn(`Telegram poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      const cq = update.callback_query;
      if (cq.message?.chat.id !== this.chatIdNum) return;
      const cmd = cq.data ?? '';
      await this.ackCallback(cq.id, `Received: ${cmd}`);
      const handler = this.commands.get(cmd);
      if (handler) await handler();
      return;
    }
    const msg = update.message;
    if (!msg || msg.chat.id !== this.chatIdNum || !msg.text) return;
    const text = msg.text.trim();
    if (!text.startsWith('/')) return;
    const cmd = text.slice(1).split(/\s+/)[0]!.toLowerCase();
    const handler = this.commands.get(cmd);
    if (handler) await handler();
  }

  private async ackCallback(callbackQueryId: string, text: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      });
    } catch {
      // Acknowledgement failures are non-fatal.
    }
  }
}
