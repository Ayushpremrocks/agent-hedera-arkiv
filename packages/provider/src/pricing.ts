/**
 * Booking price: floor × 2^(4u), where u is how full the next window of bookable capacity is.
 * Idle capacity costs the floor; as it fills the price climbs steeply, capped at 16× when full,
 * so hoarding gets expensive whoever's accounts do it, without a formula-driven blow-up.
 */
export function bookingPrice(booked: number, capacity: number, floor: bigint): bigint {
  const u = capacity > 0 ? Math.min(1, booked / capacity) : 1;
  return BigInt(Math.round(Number(floor) * 2 ** (4 * u)));
}
