/**
 * Tindeq Progressor Bluetooth protocol (published API: https://tindeq.com/progressor_api/).
 *  - Custom GATT service with a CONTROL POINT characteristic (write commands) and a
 *    DATA POINT characteristic (notifications).
 *  - Commands and responses use a tag-length-value (TLV) format.
 *  - Data is little-endian. Weight notifications carry N samples of
 *    [float32 kg][uint32 device timestamp in microseconds].
 * Pure encode/decode functions — unit-tested without a device.
 */

export const PROGRESSOR_SERVICE_UUID = '7e4e1701-1ea6-40c9-9dcc-13d34ffead57';
export const DATA_CHAR_UUID = '7e4e1702-1ea6-40c9-9dcc-13d34ffead57';
export const CONTROL_CHAR_UUID = '7e4e1703-1ea6-40c9-9dcc-13d34ffead57';
export const DEVICE_NAME_PREFIX = 'Progressor';

export const CMD = {
  TARE_SCALE: 100,
  START_WEIGHT_MEAS: 101,
  STOP_WEIGHT_MEAS: 102,
  START_PEAK_RFD_MEAS: 103,
  START_PEAK_RFD_MEAS_SERIES: 104,
  GET_APP_VERSION: 107,
  GET_ERROR_INFORMATION: 108,
  ENTER_SLEEP: 110,
  GET_BATTERY_VOLTAGE: 111,
} as const;

export const RES = {
  CMD_RESPONSE: 0,
  WEIGHT_MEAS: 1,
  RFD_PEAK: 2,
  RFD_PEAK_SERIES: 3,
  LOW_PWR_WARNING: 4,
} as const;

export type CommandCode = (typeof CMD)[keyof typeof CMD];

export interface ForceSample {
  /** Force in kg. */
  kg: number;
  /** Device timestamp, microseconds (uint32, wraps after ~71.6 min). */
  us: number;
}

export type ProgressorMessage =
  | { type: 'weight'; samples: ForceSample[] }
  | { type: 'command_response'; payload: Uint8Array }
  | { type: 'low_power' }
  | { type: 'rfd_peak'; payload: Uint8Array }
  | { type: 'unknown'; tag: number; payload: Uint8Array };

/** Encode a command as TLV: [tag][length][value...]. */
export function encodeCommand(code: CommandCode, value: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(2 + value.length);
  out[0] = code;
  out[1] = value.length;
  out.set(value, 2);
  return out;
}

/** Decode one notification from the data point characteristic. */
export function decodeMessage(view: DataView): ProgressorMessage {
  if (view.byteLength < 2) return { type: 'unknown', tag: view.byteLength ? view.getUint8(0) : -1, payload: new Uint8Array(0) };
  const tag = view.getUint8(0);
  const len = Math.min(view.getUint8(1), view.byteLength - 2);
  const payload = new Uint8Array(view.buffer, view.byteOffset + 2, len);
  switch (tag) {
    case RES.WEIGHT_MEAS: {
      const samples: ForceSample[] = [];
      for (let o = 0; o + 8 <= len; o += 8) {
        samples.push({ kg: view.getFloat32(2 + o, true), us: view.getUint32(2 + o + 4, true) });
      }
      return { type: 'weight', samples };
    }
    case RES.CMD_RESPONSE:
      return { type: 'command_response', payload: new Uint8Array(payload) };
    case RES.LOW_PWR_WARNING:
      return { type: 'low_power' };
    case RES.RFD_PEAK:
    case RES.RFD_PEAK_SERIES:
      return { type: 'rfd_peak', payload: new Uint8Array(payload) };
    default:
      return { type: 'unknown', tag, payload: new Uint8Array(payload) };
  }
}

/** Battery voltage response: uint32 little-endian, millivolts. */
export function parseBatteryMv(payload: Uint8Array): number | null {
  if (payload.length < 4) return null;
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
}

/** Approximate charge from LiPo voltage (3.0-4.2 V linear) — indicative only. */
export function batteryPercent(mv: number): number {
  return Math.round(Math.min(100, Math.max(0, ((mv - 3000) / 1200) * 100)));
}

/** Firmware version response is ASCII text. */
export function parseText(payload: Uint8Array): string {
  return String.fromCharCode(...payload).replace(/\0+$/, '');
}

/**
 * Converts wrapping uint32 µs device timestamps into monotonic milliseconds since
 * the first sample of a measurement.
 */
export class TimestampUnwrapper {
  private first: number | null = null;
  private last = 0;
  private wraps = 0;
  reset() {
    this.first = null;
    this.last = 0;
    this.wraps = 0;
  }
  toMs(us: number): number {
    if (this.first === null) {
      this.first = us;
      this.last = us;
    }
    if (us < this.last && this.last - us > 0x80000000) this.wraps++;
    this.last = us;
    const abs = us + this.wraps * 0x100000000;
    return (abs - this.first) / 1000;
  }
}
