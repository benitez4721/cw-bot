import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { Balance } from '../../domain/broker/BrokerTypes.js';

export class GetBalances {
  constructor(private readonly broker: BrokerPort) {}

  async execute(): Promise<Balance> {
    return this.broker.getBalances();
  }
}
