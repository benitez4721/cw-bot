import type { ScannerAlertRecord } from './ScannerTypes.js';

export interface ScannerAlertRepository {
  append(record: ScannerAlertRecord): Promise<void>;
}
