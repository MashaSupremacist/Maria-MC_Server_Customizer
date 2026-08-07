/** A field definition in a server.properties schema. */
export interface BedrockPropertyField {
  key: string;
  label: string;
  description: string;
  type: 'boolean' | 'integer' | 'string' | 'enum';
  /** For enums: allowed values. */
  enumValues?: string[];
  default: string | number | boolean;
  min?: number;
  max?: number;
  /** Whether a server restart is required for the change to take effect. */
  restartRequired: boolean;
}

/**
 * Schema for the Bedrock Dedicated Server server.properties. BDS uses the
 * same key=value format as Java, but a completely different set of keys.
 */
export const BEDROCK_SERVER_PROPERTIES_SCHEMA: BedrockPropertyField[] = [
  { key: 'server-port', label: 'IPv4 port', description: 'Port the server listens on (IPv4).', type: 'integer', default: 19132, min: 1, max: 65535, restartRequired: true },
  { key: 'server-portv6', label: 'IPv6 port', description: 'Port the server listens on (IPv6).', type: 'integer', default: 19133, min: 1, max: 65535, restartRequired: true },
  { key: 'level-name', label: 'Level name', description: 'Folder name of the world.', type: 'string', default: 'Bedrock level', restartRequired: true },
  { key: 'level-seed', label: 'Level seed', description: 'World seed (blank = random).', type: 'string', default: '', restartRequired: true },
  { key: 'level-type', label: 'Level type', description: 'World generator type.', type: 'enum', enumValues: ['DEFAULT', 'FLAT', 'LEGACY'], default: 'DEFAULT', restartRequired: true },
  { key: 'online-mode', label: 'Online mode', description: 'Require Xbox Live authentication. Off disables security and is discouraged.', type: 'boolean', default: true, restartRequired: true },
  { key: 'white-list', label: 'Allowlist', description: 'Only allowlisted players may join.', type: 'boolean', default: false, restartRequired: false },
  { key: 'motd', label: 'Message of the Day', description: 'Shown in the server list.', type: 'string', default: 'Dedicated Server', restartRequired: false },
  { key: 'max-players', label: 'Maximum players', description: 'Max players the server reports.', type: 'integer', default: 10, min: 1, max: 100000, restartRequired: false },
  { key: 'difficulty', label: 'Difficulty', description: 'peaceful, easy, normal, or hard.', type: 'enum', enumValues: ['peaceful', 'easy', 'normal', 'hard'], default: 'easy', restartRequired: false },
  { key: 'gamemode', label: 'Game mode', description: 'survival, creative, adventure, or spectator.', type: 'enum', enumValues: ['survival', 'creative', 'adventure', 'spectator'], default: 'survival', restartRequired: false },
  { key: 'force-gamemode', label: 'Force game mode', description: 'Prevent players from changing their own game mode.', type: 'boolean', default: false, restartRequired: false },
  { key: 'default-player-permission-level', label: 'Default permission level', description: 'Permission level for new players.', type: 'enum', enumValues: ['visitor', 'member', 'operator'], default: 'member', restartRequired: false },
  { key: 'allow-cheats', label: 'Allow cheats', description: 'Enable commands/cheats on the server.', type: 'boolean', default: false, restartRequired: false },
  { key: 'view-distance', label: 'View distance', description: 'Chunks sent to players. High values use more CPU/RAM.', type: 'integer', default: 32, min: 2, max: 96, restartRequired: false },
  { key: 'tick-distance', label: 'Tick distance', description: 'Chunks with active simulation.', type: 'integer', default: 4, min: 4, max: 12, restartRequired: false },
  { key: 'player-idle-timeout', label: 'Player idle timeout', description: 'Kick idle players after this many minutes (0 = never).', type: 'integer', default: 30, min: 0, max: 100000, restartRequired: false },
  { key: 'max-threads', label: 'Max threads', description: 'Maximum worker threads (0 = auto).', type: 'integer', default: 8, min: 0, max: 64, restartRequired: true },
  { key: 'texturepack-required', label: 'Require texture pack', description: 'Force players to download the server texture pack.', type: 'boolean', default: false, restartRequired: false },
  { key: 'content-log-file-enabled', label: 'Content log file', description: 'Write content errors to a log file.', type: 'boolean', default: false, restartRequired: false },
  { key: 'compression-threshold', label: 'Compression threshold', description: 'Bytes before network compression (1 = always, 65535 = never).', type: 'integer', default: 1, min: 1, max: 65535, restartRequired: false },
  { key: 'compression-algorithm', label: 'Compression algorithm', description: 'Network compression algorithm.', type: 'enum', enumValues: ['zlib', 'snappy'], default: 'zlib', restartRequired: false },
  { key: 'server-authoritative-movement', label: 'Server-authoritative movement', description: 'Server controls player movement validation.', type: 'enum', enumValues: ['client-auth', 'server-auth', 'server-auth-with-rewind'], default: 'server-auth', restartRequired: false },
  { key: 'correct-player-movement', label: 'Correct player movement', description: 'Correct movement when out of sync (requires server-authoritative).', type: 'boolean', default: false, restartRequired: false },
  { key: 'emit-server-telemetry', label: 'Emit server telemetry', description: 'Send anonymous usage data to Microsoft.', type: 'boolean', default: true, restartRequired: false },
  { key: 'enable-lan-visibility', label: 'LAN visibility', description: 'Show the server on the local network.', type: 'boolean', default: true, restartRequired: false },
  { key: 'chat-restriction', label: 'Chat restriction', description: 'Restrict chat for unverified players.', type: 'enum', enumValues: ['None', 'Dropped', 'Disabled'], default: 'None', restartRequired: false },
  { key: 'disable-persona', label: 'Disable persona', description: 'Disable player personas.', type: 'boolean', default: false, restartRequired: false },
  { key: 'disable-custom-skins', label: 'Disable custom skins', description: 'Disable custom player skins.', type: 'boolean', default: false, restartRequired: false },
];

/** Look up a field by key. */
export function getBedrockPropertyField(key: string): BedrockPropertyField | undefined {
  return BEDROCK_SERVER_PROPERTIES_SCHEMA.find((f) => f.key === key);
}

/** Validate a raw string value for a field; returns an error message or null. */
export function validateBedrockProperty(field: BedrockPropertyField, value: string): string | null {
  if (field.type === 'boolean') {
    if (value !== 'true' && value !== 'false') {
      return 'Must be true or false';
    }
    return null;
  }
  if (field.type === 'integer') {
    const n = Number(value);
    if (!Number.isInteger(n)) return 'Must be a whole number';
    if (field.min !== undefined && n < field.min) {
      return `Must be at least ${field.min}`;
    }
    if (field.max !== undefined && n > field.max) {
      return `Must be at most ${field.max}`;
    }
    return null;
  }
  if (field.type === 'enum' && field.enumValues) {
    if (!field.enumValues.includes(value)) {
      return `Must be one of: ${field.enumValues.join(', ')}`;
    }
    return null;
  }
  return null;
}

/** Convert a typed value to the string form used in the file. */
export function toBedrockRawValue(field: BedrockPropertyField, value: string | number | boolean): string {
  return String(value);
}

/** Convert a raw string from the file to the typed form. */
export function fromBedrockRawValue(field: BedrockPropertyField, value: string): string | number | boolean {
  if (field.type === 'boolean') return value === 'true';
  if (field.type === 'integer') return parseInt(value, 10) || 0;
  return value;
}
