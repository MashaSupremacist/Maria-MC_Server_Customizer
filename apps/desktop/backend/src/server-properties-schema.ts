/** A field definition in the server.properties schema. */
export interface PropertyField {
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
 * Schema for Vanilla server.properties. Version-aware where it matters;
 * the editor shows only known keys and preserves anything else.
 */
export const SERVER_PROPERTIES_SCHEMA: PropertyField[] = [
  { key: 'motd', label: 'Message of the Day', description: 'Shown in the server list.', type: 'string', default: 'A Minecraft Server', restartRequired: false },
  { key: 'gamemode', label: 'Game mode', description: 'survival, creative, adventure, or spectator.', type: 'enum', enumValues: ['survival', 'creative', 'adventure', 'spectator'], default: 'survival', restartRequired: false },
  { key: 'difficulty', label: 'Difficulty', description: 'peaceful, easy, normal, or hard.', type: 'enum', enumValues: ['peaceful', 'easy', 'normal', 'hard'], default: 'easy', restartRequired: false },
  { key: 'hardcore', label: 'Hardcore', description: 'Permadeath mode; players are banned on death.', type: 'boolean', default: false, restartRequired: false },
  { key: 'pvp', label: 'PvP', description: 'Allow player-versus-player combat.', type: 'boolean', default: true, restartRequired: false },
  { key: 'online-mode', label: 'Online mode', description: 'Authenticate players with Mojang. Off disables security and is discouraged.', type: 'boolean', default: true, restartRequired: true },
  { key: 'max-players', label: 'Maximum players', description: 'Max players the server reports.', type: 'integer', default: 20, min: 1, max: 100000, restartRequired: false },
  { key: 'server-port', label: 'Server port', description: 'Port the server listens on.', type: 'integer', default: 25565, min: 1, max: 65535, restartRequired: true },
  { key: 'white-list', label: 'Whitelist', description: 'Only whitelisted players may join.', type: 'boolean', default: false, restartRequired: false },
  { key: 'enforce-whitelist', label: 'Enforce whitelist', description: 'Kick players not on the whitelist on join.', type: 'boolean', default: false, restartRequired: false },
  { key: 'spawn-protection', label: 'Spawn protection', description: 'Radius of spawn protection (0 disables).', type: 'integer', default: 16, min: 0, max: 100000, restartRequired: false },
  { key: 'view-distance', label: 'View distance', description: 'Chunks sent to players. High values use more CPU/RAM.', type: 'integer', default: 10, min: 3, max: 32, restartRequired: false },
  { key: 'simulation-distance', label: 'Simulation distance', description: 'Chunks with active simulation.', type: 'integer', default: 10, min: 3, max: 32, restartRequired: false },
  { key: 'allow-flight', label: 'Allow flight', description: 'Allow flying without a plugin/anticheat.', type: 'boolean', default: false, restartRequired: false },
  { key: 'allow-nether', label: 'Allow Nether', description: 'Allow the Nether dimension.', type: 'boolean', default: true, restartRequired: false },
  { key: 'generate-structures', label: 'Generate structures', description: 'Generate structures like villages.', type: 'boolean', default: true, restartRequired: false },
  { key: 'enable-command-block', label: 'Command blocks', description: 'Enable command blocks.', type: 'boolean', default: false, restartRequired: true },
  { key: 'player-idle-timeout', label: 'Player idle timeout', description: 'Kick idle players after this many minutes (0 = never).', type: 'integer', default: 0, min: 0, max: 100000, restartRequired: false },
  { key: 'resource-pack', label: 'Resource pack URL', description: 'URL of a resource pack players are offered.', type: 'string', default: '', restartRequired: false },
  { key: 'require-resource-pack', label: 'Require resource pack', description: 'Kick players who decline the resource pack.', type: 'boolean', default: false, restartRequired: false },
  { key: 'enable-rcon', label: 'Enable RCON', description: 'Remote console. Requires a strong password.', type: 'boolean', default: false, restartRequired: true },
  { key: 'rcon.port', label: 'RCON port', description: 'Port for RCON.', type: 'integer', default: 25575, min: 1, max: 65535, restartRequired: true },
  { key: 'rcon.password', label: 'RCON password', description: 'Password for RCON. Use a strong password.', type: 'string', default: '', restartRequired: true },
  { key: 'enable-query', label: 'Enable query', description: 'Enable the GameSpy4 query protocol.', type: 'boolean', default: false, restartRequired: false },
  { key: 'query.port', label: 'Query port', description: 'Port for the query protocol.', type: 'integer', default: 25565, min: 1, max: 65535, restartRequired: false },
  { key: 'level-name', label: 'Level name', description: 'Folder name of the world.', type: 'string', default: 'world', restartRequired: true },
  { key: 'level-seed', label: 'Level seed', description: 'World seed (blank = random).', type: 'string', default: '', restartRequired: true },
  { key: 'max-tick-time', label: 'Max tick time', description: 'Max milliseconds a tick may take before the server watchdog stops it.', type: 'integer', default: 60000, min: 1000, max: 2147483647, restartRequired: false },
  { key: 'network-compression-threshold', label: 'Network compression threshold', description: 'Bytes before network compression (-1 disables).', type: 'integer', default: 256, min: -1, max: 1024, restartRequired: false },
];

/** Look up a field by key. */
export function getPropertyField(key: string): PropertyField | undefined {
  return SERVER_PROPERTIES_SCHEMA.find((f) => f.key === key);
}

/** Validate a raw string value for a field; returns an error message or null. */
export function validateProperty(field: PropertyField, value: string): string | null {
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
export function toRawValue(field: PropertyField, value: string | number | boolean): string {
  return String(value);
}

/** Convert a raw string from the file to the typed form. */
export function fromRawValue(field: PropertyField, value: string): string | number | boolean {
  if (field.type === 'boolean') return value === 'true';
  if (field.type === 'integer') return parseInt(value, 10) || 0;
  return value;
}
