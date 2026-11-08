import type { Logger } from '@atlas/observability';
import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';

/**
 * RabbitMQ connector.
 *
 * The connection is established lazily and re-established on demand after loss. Consumers that
 * need automatic resubscription after a reconnect are a Stage 1A deliverable; Stage 0 provides the
 * connection, confirm channels and readiness reporting.
 */
export interface RabbitMqConnector {
  connection(): Promise<ChannelModel>;
  createConfirmChannel(): Promise<ConfirmChannel>;
  check(): Promise<void>;
  close(): Promise<void>;
}

export function createRabbitMqConnector(options: {
  url: string;
  connectionName: string;
  logger: Logger;
}): RabbitMqConnector {
  let current: Promise<ChannelModel> | undefined;
  let closing = false;

  const connection = (): Promise<ChannelModel> => {
    if (closing) return Promise.reject(new Error('RabbitMQ connector is closed'));
    current ??= amqp
      .connect(options.url, {
        clientProperties: { connection_name: options.connectionName },
        timeout: 2_000,
      })
      .then((model) => {
        model.on('error', (error: Error) =>
          options.logger.warn({ error: { name: error.name } }, 'RabbitMQ connection error'),
        );
        model.on('close', () => {
          current = undefined;
          if (!closing) options.logger.warn('RabbitMQ connection closed; will reconnect on demand');
        });
        return model;
      })
      .catch((error: unknown) => {
        current = undefined;
        throw error;
      });
    return current;
  };

  return {
    connection,
    async createConfirmChannel() {
      return (await connection()).createConfirmChannel();
    },
    async check() {
      const model = await connection();
      const channel = await model.createChannel();
      await channel.close();
    },
    async close() {
      closing = true;
      const pending = current;
      current = undefined;
      if (pending) {
        await pending.then((model) => model.close()).catch(() => undefined);
      }
    },
  };
}
