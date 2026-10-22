export const SAMPLE_RATE = 24000
export const PACKET_SAMPLES = 480
export const HEADER_BYTES = 4
export const PACKET_BYTES = HEADER_BYTES + PACKET_SAMPLES * 2

export type PlaybackStats = {
  gaps: number
  late: number
  underruns: number
  queuedMs: number
  level: number
}
