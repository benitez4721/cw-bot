export interface MarketHours {
  isOpen(at: Date): boolean;
}
