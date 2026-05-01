export interface ScannerColumn {
  key: string;
  value: string;
}

export interface ScannerRow {
  symbol: string;
  columns: ScannerColumn[];
}
