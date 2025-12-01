import * as protobuf from 'protobufjs';

// Define AppSettings schema as JSON descriptor
const jsonDescriptor = {
  nested: {
    WaveSource: {
      fields: {
        id: { type: 'string', id: 1 },
        x: { type: 'float', id: 2 },
        y: { type: 'float', id: 3 },
        amplitude: { type: 'float', id: 4 },
        frequency: { type: 'float', id: 5 },
        phase: { type: 'float', id: 6 },
        visible: { type: 'bool', id: 7 },
      },
    },
    AppSettings: {
      fields: {
        globalSpeed: { type: 'float', id: 1 },
        appMode: { type: 'int32', id: 2 },
        paramMode: { type: 'int32', id: 3 },
        sources: { rule: 'repeated', type: 'WaveSource', id: 4 },
      },
    },
  },
};

// Load schema from JSON descriptor
const root = protobuf.Root.fromJSON(jsonDescriptor);

// Get the AppSettings type for encode/decode
const AppSettingsType = root.lookupType('AppSettings');

// Version byte: 0x01 for current format (protobuf)
const SETTINGS_VERSION = 0x01;

export interface SerializedState {
  sources: Array<{
    id: string;
    x: number;
    y: number;
    amplitude: number;
    frequency: number;
    phase: number;
    visible: boolean;
  }>;
  globalSpeed: number;
  appMode: number;
  paramMode: number;
}


/**
 * Serialize settings to binary with version byte prepended
 */
export function serializeSettings(state: SerializedState): Uint8Array {
  try {
    // Create message and encode
    const message = AppSettingsType.create(state);
    const buffer = AppSettingsType.encode(message).finish();
    
    // Prepend version byte
    const result = new Uint8Array(buffer.length + 1);
    result[0] = SETTINGS_VERSION;
    result.set(buffer, 1);
    
    return result;
  } catch (e) {
    console.error('[protobuf] serialize error:', e);
    throw e;
  }
}

/**
 * Deserialize binary settings (with version byte)
 */
export function deserializeSettings(buffer: Uint8Array): SerializedState | null {
  try {
    if (buffer.length < 2) return null;
    
    const version = buffer[0];
    if (version !== SETTINGS_VERSION) {
      console.warn('[protobuf] unsupported version:', version);
      return null;
    }
    
    const payload = buffer.slice(1);
    const message = AppSettingsType.decode(payload);
    
    return AppSettingsType.toObject(message, {
      longs: Number,
      enums: Number,
      bytes: String,
      defaults: true,
      arrays: true,
      objects: true,
    }) as unknown as SerializedState;
  } catch (e) {
    console.error('[protobuf] deserialize error:', e);
    return null;
  }
}
