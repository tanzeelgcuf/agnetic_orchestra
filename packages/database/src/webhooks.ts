import { and, eq } from "drizzle-orm";
import type { OrchestraDb } from "./client";
import { webhookDeliveries } from "./schema";

export interface DeliveryRecordResult {
  /** false when this delivery id was already recorded (duplicate webhook). */
  isNew: boolean;
}

/** Deduplicating store for inbound webhook deliveries (GitHub etc.). */
export interface WebhookDeliveryStore {
  recordDelivery(input: {
    source: string;
    deliveryId: string;
    event: string;
    action?: string;
    payload?: Record<string, unknown>;
  }): Promise<DeliveryRecordResult>;
  hasDelivery(source: string, deliveryId: string): Promise<boolean>;
}

/** PostgreSQL implementation. */
export class PgWebhookStore implements WebhookDeliveryStore {
  constructor(private readonly db: OrchestraDb) {}

  /**
   * Record a delivery. Duplicate (source, deliveryId) pairs are ignored via
   * unique-index conflict handling, giving webhook idempotency.
   */
  async recordDelivery(input: {
    source: string;
    deliveryId: string;
    event: string;
    action?: string;
    payload?: Record<string, unknown>;
  }): Promise<DeliveryRecordResult> {
    const rows = await this.db
      .insert(webhookDeliveries)
      .values({
        source: input.source,
        deliveryId: input.deliveryId,
        event: input.event,
        action: input.action ?? null,
        payload: input.payload ?? null
      })
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.id });
    return { isNew: rows.length > 0 };
  }

  async hasDelivery(source: string, deliveryId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(eq(webhookDeliveries.source, source), eq(webhookDeliveries.deliveryId, deliveryId))
      )
      .limit(1);
    return rows.length > 0;
  }
}
