/**
 * Broadcast hub for Server-Sent Events. Senders are added by the /api/stream
 * route and removed on abort. A slow or dead client never blocks the pipeline:
 * writes are fire-and-forget with per-client catch.
 */

export type Sender = (event: string, data: string) => Promise<void> | void;

export class Hub {
  private readonly clients = new Map<Sender, () => void>();

  add(sender: Sender, close: () => void = () => {}): void {
    this.clients.set(sender, close);
  }

  remove(sender: Sender): void {
    this.clients.delete(sender);
  }

  get size(): number {
    return this.clients.size;
  }

  closeAll(): void {
    const clients = [...this.clients.values()];
    this.clients.clear();
    for (const close of clients) {
      try {
        close();
      } catch (error) {
        console.error("[desk] SSE client close failed:", error);
      }
    }
  }

  broadcast(event: string, data: unknown): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(data);
    for (const client of [...this.clients.keys()]) {
      try {
        void Promise.resolve(client(event, payload)).catch(() => this.remove(client));
      } catch {
        this.clients.delete(client);
      }
    }
  }
}
