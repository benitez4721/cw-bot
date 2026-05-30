export interface ScannerColumn {
  key: string;
  value: string;
}

export interface ScannerRow {
  symbol: string;
  columns: ScannerColumn[];
}

export interface ScannerAlertRecord {
  configId: string;
  capturedAt: string;
  row: ScannerRow;
}
