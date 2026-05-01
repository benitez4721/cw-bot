import type { ScannerRow } from './ScannerTypes.js';

export interface ScannerFeedPort {
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(configId: string): void;
  unsubscribe(configId: string): void;
  onUpdate(callback: (configId: string, rows: ScannerRow[]) => void): void;
}
