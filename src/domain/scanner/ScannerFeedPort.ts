import type { ScannerRow } from './ScannerTypes.js';

export interface ScannerFeedPort {
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(configId: string): void;
  onUpdate(callback: (configId: string, rows: ScannerRow[]) => void): void;
  onConnectionChange(callback: (connected: boolean) => void): void;
}
