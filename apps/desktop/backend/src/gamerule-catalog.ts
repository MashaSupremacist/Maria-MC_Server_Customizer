/** Catalog metadata for a gamerule. */
export interface GameruleDef {
  key: string;
  category: 'Gameplay' | 'Mobs' | 'Drops' | 'Player' | 'World' | 'Spawning' | 'Chat' | 'Command Blocks';
  type: 'boolean' | 'integer';
  description: string;
  defaultValue: string | number | boolean;
  min?: number;
  max?: number;
}

/**
 * Version-aware gamerule catalog for Vanilla Java Edition.
 * Each rule notes the minimum MC version that introduced it; the catalog
 * filters rules not present in the server's Minecraft version.
 */
export const GAMERULE_DEFS: Array<GameruleDef & { since: string }> = [
  // Gameplay
  { key: 'doFireTick', category: 'Gameplay', type: 'boolean', description: 'Fire spreads and naturally extinguishes.', defaultValue: true, since: '1.8' },
  { key: 'doMobSpawning', category: 'Gameplay', type: 'boolean', description: 'Entities spawn naturally.', defaultValue: true, since: '1.8' },
  { key: 'doMobLoot', category: 'Drops', type: 'boolean', description: 'Mobs drop loot when killed.', defaultValue: true, since: '1.8' },
  { key: 'doTileDrops', category: 'Drops', type: 'boolean', description: 'Blocks drop items when broken.', defaultValue: true, since: '1.8' },
  { key: 'doEntityDrops', category: 'Drops', type: 'boolean', description: 'Entities drop items.', defaultValue: true, since: '1.8' },
  { key: 'keepInventory', category: 'Player', type: 'boolean', description: 'Players keep inventory on death.', defaultValue: false, since: '1.8' },
  { key: 'mobGriefing', category: 'Mobs', type: 'boolean', description: 'Mobs can change the world (creeper holes, villager farms).', defaultValue: true, since: '1.8' },
  { key: 'doDaylightCycle', category: 'Gameplay', type: 'boolean', description: 'The day/night cycle advances.', defaultValue: true, since: '1.8' },
  { key: 'doWeatherCycle', category: 'Gameplay', type: 'boolean', description: 'Weather changes over time.', defaultValue: true, since: '1.8' },
  { key: 'doLimitedCrafting', category: 'Gameplay', type: 'boolean', description: 'Players can only craft unlocked recipes.', defaultValue: false, since: '1.12' },
  { key: 'doTraderSpawning', category: 'Gameplay', type: 'boolean', description: 'Wandering traders spawn.', defaultValue: true, since: '1.14' },
  { key: 'playersSleepingPercentage', category: 'Gameplay', type: 'integer', description: 'Percent of players that must sleep to skip night.', defaultValue: 100, min: 0, max: 100, since: '1.17' },
  { key: 'doPatrolSpawning', category: 'Gameplay', type: 'boolean', description: 'Pillager patrols spawn.', defaultValue: true, since: '1.14' },
  { key: 'doVinesSpread', category: 'Gameplay', type: 'boolean', description: 'Vines spread over time.', defaultValue: true, since: '1.16' },
  { key: 'doWardenSpawning', category: 'Gameplay', type: 'boolean', description: 'Wardens spawn in the deep dark.', defaultValue: true, since: '1.19' },
  { key: 'doImmediateRespawn', category: 'Player', type: 'boolean', description: 'Players respawn immediately without the death screen.', defaultValue: false, since: '1.15' },
  { key: 'naturalRegeneration', category: 'Player', type: 'boolean', description: 'Players regenerate health naturally.', defaultValue: true, since: '1.8' },
  { key: 'doInsomnia', category: 'Gameplay', type: 'boolean', description: 'Phantoms spawn for players who have not slept.', defaultValue: true, since: '1.10' },
  { key: 'doMobSpawning', category: 'Spawning', type: 'boolean', description: 'Entities spawn naturally.', defaultValue: true, since: '1.8' },

  // World
  { key: 'spawnRadius', category: 'World', type: 'integer', description: 'Radius of the world spawn area.', defaultValue: 10, min: 0, max: 100, since: '1.8' },
  { key: 'randomTickSpeed', category: 'World', type: 'integer', description: 'Random ticks per block (0 disables).', defaultValue: 3, min: 0, max: 256, since: '1.8' },
  { key: 'maxEntityCramming', category: 'World', type: 'integer', description: 'Entities in one block before damage.', defaultValue: 24, min: 0, max: 100, since: '1.8' },

  // Chat
  { key: 'commandBlockOutput', category: 'Command Blocks', type: 'boolean', description: 'Command blocks broadcast output to chat.', defaultValue: true, since: '1.8' },
  { key: 'sendCommandFeedback', category: 'Chat', type: 'boolean', description: 'Command feedback shows in chat.', defaultValue: true, since: '1.8' },
  { key: 'logAdminCommands', category: 'Chat', type: 'boolean', description: 'Admin commands appear in the server log.', defaultValue: true, since: '1.8' },
  { key: 'announceAdvancements', category: 'Chat', type: 'boolean', description: 'Advancements are announced in chat.', defaultValue: true, since: '1.12' },
  { key: 'showDeathMessages', category: 'Chat', type: 'boolean', description: 'Death messages appear in chat.', defaultValue: true, since: '1.8' },
  { key: 'maxCommandChainLength', category: 'Command Blocks', type: 'integer', description: 'Max command chain length.', defaultValue: 65536, min: 1, max: 2147483647, since: '1.8' },
];

/** Parse an MC version like "1.21.4" or "26.2" into a comparable tuple. */
export function parseMcVersion(version: string): number[] {
  return version.split('.').map((part) => parseInt(part, 10) || 0);
}

/** Compare two MC versions: negative if a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = parseMcVersion(a);
  const pb = parseMcVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/** Filter the catalog to rules available in a given MC version. */
export function gamerulesForVersion(
  minecraftVersion: string | null,
): Array<GameruleDef & { since: string }> {
  if (!minecraftVersion) return GAMERULE_DEFS;
  return GAMERULE_DEFS.filter((rule) => compareVersions(minecraftVersion, rule.since) >= 0);
}

/** Get a single rule definition by key (any version). */
export function getGameruleDef(key: string): (GameruleDef & { since: string }) | undefined {
  return GAMERULE_DEFS.find((rule) => rule.key === key);
}
