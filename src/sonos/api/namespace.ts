import type { SonosWebSocketApi } from './websocket';

export type SubscribeCallback<T> = (payload: T) => void;
export type UnsubscribeCallback = () => void;

/**
 * Base helper for namespace handlers.
 */
export class SonosNamespace<TEventPayload> {
  protected listeners = new Map<string, SubscribeCallback<TEventPayload>>();
  public readonly eventType: string;

  constructor(
    protected api: SonosWebSocketApi,
    protected namespace: string,
    eventType: string,
    protected eventKey: string,
  ) {
    this.eventType = eventType;
  }

  protected async handleSubscribe(
    id: string,
    callback: SubscribeCallback<TEventPayload>,
  ): Promise<UnsubscribeCallback> {
    if (this.listeners.has(id)) {
      this.api.logger.error(`Duplicate subscription detected for ${id}`);
    }
    await this.api.sendCommand(this.namespace, 'subscribe', undefined, { [this.eventKey]: id });
    this.listeners.set(id, callback);

    return () => {
      this.listeners.delete(id);
      this.api.sendCommandNoWait(this.namespace, 'unsubscribe', undefined, { [this.eventKey]: id });
    };
  }

  public handleEvent(event: Record<string, unknown>, eventData: TEventPayload): void {
    const id = event[this.eventKey];
    if (typeof id === 'string') {
      const handler = this.listeners.get(id);
      handler?.(eventData);
    }
  }
}
