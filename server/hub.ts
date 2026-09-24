/**
 * Broadcast hub for Server-Sent Events. Senders are added by the /api/stream
 * route and removed on abort. A slow or dead client never blocks the pipeline:
 * writes are fire-and-forget with per-client catch.
 */

export type Sender = (event: string, data: string) => Promise<void> | void;

export class Hub {
  private readonly clients = new Set<Sender>();

  add(sender: Sender): void {
    this.clients.add(sender);
  }

  remove(sender: Sender): void {
    this.clients.delete(sender);
  }

  get size(): number {
    return this.clients.size;
  }

  broadcast(event: string, data: unknown): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(data);
    for (const client of [...this.clients]) {
      try {
        void Promise.resolve(client(event, payload)).catch(() => this.remove(client));
      } catch {
        this.clients.delete(client);
      }
    }
  }
}
