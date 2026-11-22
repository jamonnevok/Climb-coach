/**
 * Web Bluetooth transport (Chrome on Android & desktop; requires HTTPS — GitHub Pages is fine).
 * One-tap reconnect:
 *  - If navigator.bluetooth.getDevices() is available (Chrome with the persistent-permissions
 *    backend), the remembered device is re-acquired WITHOUT the chooser.
 *  - Otherwise the chooser opens filtered to "Progressor" — one tap on the device.
 * The Progressor must NOT be paired in Android Bluetooth settings (per Tindeq's manual).
 */
import { CONTROL_CHAR_UUID, DATA_CHAR_UUID, DEVICE_NAME_PREFIX, PROGRESSOR_SERVICE_UUID } from './protocol';
import { Progressor, type BleTransport } from './progressor';

export function webBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator && !!navigator.bluetooth;
}

export class WebBluetoothTransport implements BleTransport {
  private device: BluetoothDevice | null = null;
  private control: BluetoothRemoteGATTCharacteristic | null = null;
  private data: BluetoothRemoteGATTCharacteristic | null = null;
  private notifyCb: ((v: DataView) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private onValue = (ev: Event) => {
    const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (v && this.notifyCb) this.notifyCb(v);
  };
  private onGattDisconnected = () => this.disconnectCb?.();

  get connected(): boolean {
    return !!this.device?.gatt?.connected && !!this.control;
  }

  onNotify(cb: (view: DataView) => void): void {
    this.notifyCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  private async findRemembered(id: string | null): Promise<BluetoothDevice | null> {
    if (!id) return null;
    const bt = navigator.bluetooth as Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> };
    if (typeof bt.getDevices !== 'function') return null;
    try {
      const devices = await bt.getDevices();
      return devices.find((d) => d.id === id) ?? null;
    } catch {
      return null;
    }
  }

  async connect(opts: { rememberedId: string | null; interactive: boolean }): Promise<{ id: string; name: string }> {
    if (!webBluetoothAvailable()) throw new Error('Web Bluetooth is not available in this browser. Use Chrome on Android or desktop.');
    let device = this.device && (!opts.rememberedId || this.device.id === opts.rememberedId) ? this.device : await this.findRemembered(opts.rememberedId);
    if (!device) {
      if (!opts.interactive) throw new Error('Device not available without user interaction.');
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: DEVICE_NAME_PREFIX }],
        optionalServices: [PROGRESSOR_SERVICE_UUID],
      });
    }
    if (this.device && this.device !== device) this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    this.device = device;
    device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(PROGRESSOR_SERVICE_UUID);
    this.control = await service.getCharacteristic(CONTROL_CHAR_UUID);
    this.data = await service.getCharacteristic(DATA_CHAR_UUID);
    this.data.removeEventListener('characteristicvaluechanged', this.onValue);
    this.data.addEventListener('characteristicvaluechanged', this.onValue);
    await this.data.startNotifications();
    return { id: device.id, name: device.name ?? 'Progressor' };
  }

  async disconnect(): Promise<void> {
    try {
      await this.data?.stopNotifications();
    } catch {
      /* ignore */
    }
    this.device?.gatt?.disconnect();
    this.control = null;
    this.data = null;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.control) throw new Error('Progressor not connected');
    const c = this.control as BluetoothRemoteGATTCharacteristic & { writeValueWithResponse?: (v: BufferSource) => Promise<void> };
    if (typeof c.writeValueWithResponse === 'function') await c.writeValueWithResponse(bytes);
    else await c.writeValue(bytes);
  }
}

/** Singleton used by the app (null transport when Web Bluetooth is unavailable -> manual entry). */
let instance: Progressor | null = null;
export function getProgressor(): Progressor {
  if (!instance) instance = new Progressor(webBluetoothAvailable() ? new WebBluetoothTransport() : null);
  return instance;
}
