import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { Position } from '../../domain/broker/BrokerTypes.js';

export class GetPositions {
  constructor(private readonly broker: BrokerPort) {}

  async execute(): Promise<Position[]> {
    return this.broker.getPositions();
  }
}
